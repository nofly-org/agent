import os from 'node:os';
import { gateMachine } from '../core/api-client.mjs';
import { breakerOpen } from '../core/circuit-breaker.mjs';
import { loadConfig, resolveSettings, storedAgentCredential } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { red } from '../core/terminal.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { envFlag } from '../guard/options.mjs';
import { spawnGuardedServer } from './child-process.mjs';
import { reportListing, requestConnectVerdict } from './connect-gate.mjs';
import { createLineFramer, idInHead, refusal, sendBlockedInitialize, writeMessage } from './jsonrpc.mjs';
import { LISTING_KEY, RESULT_METHODS, screenInstructions, screenListing, screenResult, screenToolCallArguments } from './screening.mjs';
import { resolveAgentIdentityHandle } from '../commands/agent-identity.mjs';
import { resolveScreenMode, screenCallRemote, screenResultRemote, shimSessionId } from './backend-screen.mjs';
import { SCREENED_SERVER_METHODS, screenServerRequest } from './server-requests.mjs';

export { mcpConfigCandidates, unwrapMcpConfig, wrapMcpConfig } from './config-wrapping.mjs';

const MAX_PENDING_REQUESTS = 1000;
const USAGE = 'shomra mcp-guard --name <server> -- <command> [args…]';

function note(message) {
  process.stderr.write(`[shomra] ${message}\n`);
}

function readLaunchTarget(flags, positional) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const childArgv = separator === -1 ? [] : argv.slice(separator + 1);
  const [command, ...args] = childArgv;
  const name = String(flags.name || positional[0] || command || '').trim();
  return { name, command, args };
}

async function resolveConnectVerdict({ name, command, args, flags, settings, strict }) {
  const { apiKey, url } = settings;
  if (!apiKey || !url) {
    if (strict) {
      sendBlockedInitialize(
        'Shomra is not configured on this machine (SHOMRA_GUARD_STRICT). Run: shomra init --key shm_…',
        name,
      );
      process.exit(0);
    }
    return null;
  }
  if (!strict && breakerOpen()) return null;

  const { verdict, error } = await requestConnectVerdict({
    url,
    apiKey,
    server: { name, command, args },
    agent: flags.agent ? String(flags.agent) : undefined,
    projectId: flags.project ? String(flags.project) : undefined,
  });
  if (!error) return verdict;

  if (strict) {
    sendBlockedInitialize(`Shomra could not verify "${name}" (${error.message}); refused by fail-closed policy.`, name);
    process.exit(0);
  }
  note(`mcp-guard: could not reach the backend (${error.message}); "${name}" started unverified.`);
  return null;
}

function enforceConnectVerdict(verdict, name) {
  if (!verdict) return;
  if (verdict.decision === 'BLOCK') {
    sendBlockedInitialize(
      verdict.reason || `MCP server "${name}" is not permitted in this organization.`,
      name,
      verdict,
    );
    note(verdict.reason || `"${name}" refused.`);
    process.exit(0);
  }
  if (verdict.decision === 'FLAG') note(verdict.reason || `"${name}" is unreviewed.`);
}

function launchServer(name, command, args) {
  try {
    return spawnGuardedServer(command, args);
  } catch (error) {
    sendBlockedInitialize(`Shomra refused to launch "${name}": ${error.message}`, name);
    note(error.message);
    return process.exit(0);
  }
}

const isObject = (m) => m !== null && typeof m === 'object' && !Array.isArray(m);

const SCREENED_RESPONSE = (method) => !!LISTING_KEY[method] || RESULT_METHODS.has(method) || method === 'tools/call' || method === 'initialize';

function wellFormedResponse(message) {
  const hasResult = message.result !== undefined;
  const hasError = message.error !== undefined;
  if (hasResult === hasError) return false;
  return hasResult ? isObject(message.result) : isObject(message.error);
}

function trackRequest(pending, message) {
  if (message.method === 'notifications/cancelled' && isObject(message.params) && 'requestId' in message.params) {
    pending.delete(JSON.stringify(message.params.requestId));
    return;
  }
  if (typeof message.method !== 'string' || !('id' in message)) return;
  if (pending.size >= MAX_PENDING_REQUESTS) pending.delete(pending.keys().next().value);
  pending.set(JSON.stringify(message.id), { method: message.method, tool: message.params?.name, args: message.params?.arguments });
}

/**
 * ⚠ ONE MESSAGE AT A TIME, IN ORDER. A backend screen is async; handling the next
 * line while the previous one waits would let a later message overtake a refused
 * one, or a result arrive before the call it answers was judged.
 */
function serial(handler, onError) {
  let chain = Promise.resolve();
  const push = (message, line) => {
    chain = chain
      .then(() => handler(message, line))
      .catch((error) => {
        note(`mcp-guard: screening error (${error?.message ?? error}).`);
        try {
          onError(message, line);
        } catch (failure) {
          note(`mcp-guard: ${failure?.message ?? failure}`);
        }
      });
  };
  push.idle = () => chain;
  return push;
}

/**
 * ⚠ A SCREEN THAT THREW NEVER PASSES THE MESSAGE UNREAD, AND NEVER SWALLOWS IT.
 * A request gets an explicit refusal (the client is waiting on that id and would
 * hang); a notification, which nobody waits on, is passed through.
 */
function refuseUnscreenedClient(server, child) {
  return (message, line) => {
    if (isObject(message) && 'id' in message && typeof message.method === 'string') {
      writeMessage(refusal(message.id, 'Shomra could not screen this message, so it was not passed on.', { source: 'shomra-mcp-shim', server, refusedBy: 'error' }));
    } else {
      child.stdin.write(`${line}\n`);
    }
  };
}

function refuseUnscreenedServer(server, child) {
  return (message, line) => {
    if (!isObject(message) || !('id' in message)) {
      process.stdout.write(`${line}\n`);
      return;
    }
    const error = refusal(message.id, 'Shomra could not screen this message, so it was not passed on.', { source: 'shomra-mcp-shim', server, refusedBy: 'error' });
    if (typeof message.method === 'string') child.stdin.write(`${JSON.stringify(error)}\n`);
    else writeMessage(error);
  };
}

/**
 * Judge one tool call or result: the backend in `backend` mode, the local rules in
 * `local` mode or when the backend cannot answer. Returns { blocked, label, via }.
 */
async function judgeItem({ ctx, remote, local }) {
  if (ctx.mode === 'backend') {
    const d = await remote();
    if (!d.unreachable) {
      const label = d.held ? `held for approval${d.approvalId ? ` (${d.approvalId})` : ''}` : d.reason || 'refused by org policy';
      return { blocked: d.blocked, label, via: 'backend' };
    }
    if (ctx.strict) return { blocked: true, label: `Shomra could not be reached (${d.unreachable}); refused by fail-closed policy`, via: 'strict' };
    note(`mcp-guard: backend unreachable (${d.unreachable}) - judged by local rules only.`);
  }
  const screen = local();
  return { blocked: screen.blocked, label: screen.label, via: 'local' };
}

function overflowNote(server, direction, refuse) {
  return (head) => {
    note(`mcp-guard: a ${direction} message for "${server}" was larger than the screen reads and was dropped.`);
    const id = idInHead(head);
    if (id !== undefined) refuse(id);
  };
}

function createClientFilter({ child, pending, server, ctx, queue }) {
  const onOverflow = overflowNote(server, 'client', (id) => writeMessage(refusal(id, 'Shomra refused this request: it was too large to screen.', { source: 'shomra-mcp-shim', server, refusedBy: 'size' })));
  return createLineFramer(queue(async (message, line) => {
    if (!isObject(message)) {
      child.stdin.write(`${line}\n`);
      return;
    }
    trackRequest(pending, message);
    if (message.method === 'tools/call' && 'id' in message) {
      const tool = message.params?.name;
      const args = message.params?.arguments;
      const verdict = await judgeItem({
        ctx,
        remote: () => screenCallRemote({ settings: ctx.settings, server, tool, args, sessionId: ctx.sessionId, agentId: ctx.agentId }),
        local: () => screenToolCallArguments(args),
      });
      if (verdict.blocked) {
        pending.delete(JSON.stringify(message.id));
        writeMessage(refusal(message.id, `Refused by Shomra (${verdict.via}): ${verdict.label}.`, {
          source: 'shomra-mcp-shim',
          server,
          tool,
          refusedBy: 'policy',
          screenedBy: verdict.via,
        }));
        return;
      }
    }
    child.stdin.write(`${line}\n`);
  }, refuseUnscreenedClient(server, child)), { onOverflow });
}

function listingTelemetry({ settings, server, agent, withheld, total }) {
  reportListing(settings.url, settings.apiKey, {
    server,
    withheld,
    total,
    machine: gateMachine(),
    env: detectEnv(),
    agent,
    sessionId: process.env.SHOMRA_SESSION_ID || undefined,
  });
}

async function forwardResultMethod({ message, line, entry, server, ctx }) {
  const { method } = entry;
  // ⚠ tools/call results are the injection channel that matters most, and they were
  // never screened here - only resources/read, prompts/get and completions were.
  const verdict = method === 'tools/call'
    ? await judgeItem({
      ctx,
      remote: () => screenResultRemote({ settings: ctx.settings, server, tool: entry.tool, args: entry.args, result: message.result, sessionId: ctx.sessionId, agentId: ctx.agentId }),
      local: () => screenResult(message.result),
    })
    : { ...screenResult(message.result), via: 'local' };
  if (!verdict.blocked) {
    process.stdout.write(`${line}\n`);
    return;
  }
  note(`withheld a ${method} result from "${server}" (${verdict.via}): ${verdict.label}`);
  writeMessage(refusal(
    message.id,
    `Shomra withheld this ${method} result: ${verdict.label}. The content was not read into context - do not act on it.`,
    { source: 'shomra-mcp-shim', server, method, refusedBy: 'content', screenedBy: verdict.via },
  ));
}

function forwardError({ message, line, entry, server }) {
  const verdict = screenResult({ error: message.error });
  if (!verdict.blocked) {
    process.stdout.write(`${line}\n`);
    return;
  }
  note(`withheld a ${entry.method} error from "${server}": ${verdict.label}`);
  writeMessage(refusal(
    message.id,
    `Shomra withheld this ${entry.method} error: ${verdict.label}. Its text was not read into context - do not act on it.`,
    { source: 'shomra-mcp-shim', server, method: entry.method, refusedBy: 'content', screenedBy: 'local' },
  ));
}

function forwardInitialize({ message, line, server }) {
  const screened = screenInstructions(message.result);
  if (!screened.withheld) {
    process.stdout.write(`${line}\n`);
    return;
  }
  note(`withheld the server instructions from "${server}": they carry injected directives`);
  writeMessage({ ...message, result: screened.result });
}

function forwardListing({ message, method, server, deniedTools, settings, agent }) {
  const screened = screenListing(method, message.result, deniedTools);
  if (screened.denied.length) {
    note(`withheld ${screened.denied.length} tool(s) denied by policy on "${server}": ${screened.denied.join(', ')}`);
  }
  if (screened.withheld.length) {
    note(`withheld ${screened.withheld.length} poisoned descriptor(s) from "${server}": ${screened.withheld.join(', ')}`);
    listingTelemetry({ settings, server, agent, withheld: screened.withheld, total: screened.total });
  } else if (method === 'tools/list' && screened.total) {
    listingTelemetry({ settings, server, agent, withheld: [], total: screened.total });
  }
  writeMessage({ ...message, result: screened.result });
}

function createServerFilter({ child, pending, server, deniedTools, settings, agent, ctx, queue }) {
  const onOverflow = overflowNote(server, 'server', (id) => {
    const key = JSON.stringify(id);
    if (!pending.has(key)) return;
    pending.delete(key);
    writeMessage(refusal(id, 'Shomra withheld this response: it was too large to screen. The content was not read into context.', { source: 'shomra-mcp-shim', server, refusedBy: 'size' }));
  });
  return createLineFramer(queue(async (message, line) => {
    if (!isObject(message)) {
      process.stdout.write(`${line}\n`);
      return;
    }
    const answers = message.result !== undefined || message.error !== undefined;
    if (answers && typeof message.method === 'string') {
      note(`mcp-guard: "${server}" sent a message that is both a request and a response; it was dropped.`);
      return;
    }
    if (!answers) {
      const verdict = 'id' in message && SCREENED_SERVER_METHODS.has(message.method) ? screenServerRequest(message) : null;
      if (verdict?.refused) {
        child.stdin.write(`${JSON.stringify(refusal(message.id, `Refused by Shomra: ${verdict.reason}.`, { source: 'shomra-mcp-guard', method: message.method, relayed: false }))}\n`);
        note(`mcp-guard: refused ${message.method} from "${server}": ${verdict.reason}.`);
        return;
      }
      process.stdout.write(`${line}\n`);
      return;
    }
    const key = 'id' in message ? JSON.stringify(message.id) : null;
    const entry = key ? pending.get(key) : null;
    if (!entry || !wellFormedResponse(message)) {
      note(`mcp-guard: dropped a response from "${server}" that answers no pending request or is malformed (id ${key ?? 'missing'}).`);
      return;
    }
    pending.delete(key);
    if (message.error !== undefined) {
      forwardError({ message, line, entry, server });
      return;
    }
    if (!SCREENED_RESPONSE(entry.method)) {
      process.stdout.write(`${line}\n`);
      return;
    }

    if (entry.method === 'initialize') forwardInitialize({ message, line, server });
    else if (RESULT_METHODS.has(entry.method) || entry.method === 'tools/call') await forwardResultMethod({ message, line, entry, server, ctx });
    else forwardListing({ message, method: entry.method, server, deniedTools, settings, agent });
  }, refuseUnscreenedServer(server, child)), { onOverflow });
}

export async function runMcpShim(flags, positional) {
  const { name, command, args } = readLaunchTarget(flags, positional);
  if (!command) {
    console.error(`${red('✗')} Usage: ${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  const strict = envFlag('SHOMRA_GUARD_STRICT');
  const config = loadConfig();
  const settings = resolveSettings(config);
  const agent = flags.agent ? String(flags.agent) : undefined;

  const screening = resolveScreenMode({
    flag: flags.screen,
    env: process.env.SHOMRA_MCP_SCREEN,
    config: config?.mcpScreen,
    enrolled: !!(settings.apiKey && settings.url),
  });
  if (screening.error) {
    sendBlockedInitialize(`Shomra refused to start "${name}": ${screening.error}`, name);
    note(screening.error);
    process.exit(0);
  }
  if (screening.mode === 'backend' && !(settings.apiKey && settings.url)) {
    const why = 'screening mode "backend" needs this machine enrolled - run: shomra init --key shm_… --url <backend>';
    if (strict) {
      sendBlockedInitialize(`Shomra refused to start "${name}": ${why}`, name);
      process.exit(0);
    }
    note(`mcp-guard: ${why}; judging "${name}" by local rules only.`);
    screening.mode = 'local';
  }
  const ctx = {
    mode: screening.mode,
    strict,
    settings,
    sessionId: shimSessionId(name),
    agentId: resolveAgentIdentityHandle(flags) ?? storedAgentCredential(config, agent ?? null, settings.url),
  };
  if (process.env.SHOMRA_DEBUG) note(`mcp-guard: "${name}" screening=${ctx.mode} (from ${screening.source})`);

  const verdict = await resolveConnectVerdict({ name, command, args, flags, settings, strict });
  enforceConnectVerdict(verdict, name);
  const deniedTools = Array.isArray(verdict?.deniedTools) ? verdict.deniedTools.map(String) : [];

  const child = launchServer(name, command, args);
  child.on('error', (error) => {
    note(`mcp-guard: failed to start "${command}": ${error.message}`);
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
      }
    });
  }

  const pending = new Map();
  const clientQueue = (handler, onError) => serial(handler, onError);
  const serverQueue = (handler, onError) => serial(handler, onError);
  let clientIdle = () => Promise.resolve();
  let serverIdle = () => Promise.resolve();
  const trackClient = (handler, onError) => {
    const q = clientQueue(handler, onError);
    clientIdle = q.idle;
    return q;
  };
  const trackServer = (handler, onError) => {
    const q = serverQueue(handler, onError);
    serverIdle = q.idle;
    return q;
  };
  process.stdin.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stdin.on('error', (error) => note(`mcp-guard: could not write to "${name}": ${error.message}`));
  const fromClient = createClientFilter({ child, pending, server: name, ctx, queue: trackClient });
  const fromServer = createServerFilter({ child, pending, server: name, deniedTools, settings, agent, ctx, queue: trackServer });
  process.stdin.on('data', (chunk) => {
    fromClient(chunk);
    if (child.stdin.writableNeedDrain) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  });
  child.stdout.on('data', (chunk) => {
    fromServer(chunk);
    if (process.stdout.writableNeedDrain) {
      child.stdout.pause();
      process.stdout.once('drain', () => child.stdout.resume());
    }
  });
  process.stdin.on('end', () => {
    clientIdle().then(() => child.stdin.end());
  });
  child.on('close', async (code, signal) => {
    await serverIdle();
    const status = signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0);
    process.stdout.write('', () => process.exit(status));
  });

  await new Promise(() => {});
}

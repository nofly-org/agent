import os from 'node:os';
import { loadConfig, resolveSettings, storedAgentCredential } from '../core/config.mjs';
import { exitNotConfigured } from '../core/exit-codes.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { VERSION } from '../core/version.mjs';
import { resolveAgentIdentityHandle } from './agent-identity.mjs';
import { keyedFetch } from '../core/keyed-fetch.mjs';
import { currentUsername } from '../core/api-client.mjs';

export const LLM_PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq', 'mistral', 'xai', 'deepseek', 'openrouter', 'together', 'cohere', 'voyage', 'jina'];

const OPENAI_COMPATIBLE = ['groq', 'mistral', 'xai', 'deepseek', 'openrouter', 'together', 'cohere'];
const EMBEDDINGS_ONLY = ['voyage', 'jina'];
const DEFAULT_PORT = 4141;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BODYLESS_METHODS = ['GET', 'HEAD'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const HOP_BY_HOP_REQUEST_HEADERS = [...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding', 'expect'];
const HOP_BY_HOP_RESPONSE_HEADERS = [...HOP_BY_HOP, 'content-length', 'content-encoding'];

const namedByConnection = (value) => String(value ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
const AGENT_CREDENTIAL_PREFIX = 'shm_agt_';

function newSessionId() {
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.replace(/:\d+$/, '');
}

export function localClientOnly(headers = {}) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(headers.host))) return false;
  const origin = headers.origin;
  if (origin == null || origin === '') return true;
  try {
    return LOOPBACK_HOSTS.has(hostnameOf(new URL(origin).host));
  } catch {
    return false;
  }
}

export function forwardHeaders(incoming, { apiKey, actor, machineId, sessionId, project, agentId }) {
  const headers = { ...incoming };
  for (const name of [...HOP_BY_HOP_REQUEST_HEADERS, ...namedByConnection(incoming.connection)]) delete headers[name];

  headers['x-shomra-key'] = apiKey;
  headers['x-shomra-actor'] = actor;
  if (machineId) headers['x-shomra-machine'] = machineId;
  headers['x-shomra-source'] = 'shomra llm-proxy';
  if (!headers['x-shomra-session']) headers['x-shomra-session'] = sessionId;
  if (project) headers['x-shomra-project'] = project;
  const presented = typeof headers['x-shomra-agent'] === 'string' ? headers['x-shomra-agent'].trim() : '';
  delete headers['x-shomra-agent'];
  const agent = agentId || (presented.startsWith(AGENT_CREDENTIAL_PREFIX) ? presented : null);
  if (agent) headers['x-shomra-agent'] = agent;
  return headers;
}

export class BodyTooLarge extends Error {}

export async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge(`request body is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function streamUpstreamBody(upstream, response) {
  try {
    if (!upstream.body) return;
    for await (const chunk of upstream.body) {
      if (response.destroyed) break;
      if (!response.write(chunk)) {
        await new Promise((done) => {
          const finish = () => {
            response.off('drain', finish);
            response.off('close', finish);
            done();
          };
          response.on('drain', finish);
          response.on('close', finish);
        });
      }
    }
  } catch {
    return;
  }
}

async function relayResponse(upstream, response) {
  const headers = {};
  const dropped = new Set([...HOP_BY_HOP_RESPONSE_HEADERS, ...namedByConnection(upstream.headers.get('connection'))]);
  for (const [name, value] of upstream.headers) {
    if (!dropped.has(name)) headers[name] = value;
  }
  response.once('close', () => {
    if (!response.writableFinished) upstream.body?.cancel?.().catch(() => {});
  });
  response.writeHead(upstream.status, headers);
  await streamUpstreamBody(upstream, response);
  response.end();
}

export function containRequestErrors(handler) {
  return async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    try {
      await handler(request, response);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(response, 413, { error: { message: `Refused: ${error.message}.` } });
        request.destroy();
        return;
      }
      if (response.headersSent) response.destroy();
      else sendJson(response, 502, { error: { message: `Shomra LLM proxy error: ${error?.message ?? error}` } });
    }
  };
}

function statusMark(status) {
  if (status === 403) return red('BLOCKED');
  return status >= 400 ? yellow(String(status)) : green(String(status));
}

function logCall(provider, request, suffix, status) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`  ${dim(time)} ${bold(provider.padEnd(10))} ${dim(request.method)} ${suffix} ${statusMark(status)}`);
}

function createProxyHandler({ url, headerContext, providerPattern }) {
  return async (request, response) => {
    if (!localClientOnly(request.headers)) {
      sendJson(response, 403, {
        error: { message: 'Refused: the Shomra LLM proxy only serves clients on this machine. The Host and any Origin must be loopback, which stops a web page from reaching it through DNS rebinding.' },
      });
      return;
    }
    const requestPath = String(request.url).replace(/^\/llm(?=\/)/, '');
    const match = requestPath.match(providerPattern);
    if (!match) {
      sendJson(response, 404, {
        error: { message: `Unknown route - use /<provider>/… (providers: ${LLM_PROVIDERS.join(', ')})` },
      });
      return;
    }

    const [, provider, suffix] = match;
    const route = `/llm/${provider}${suffix ?? '/'}`;
    const body = await readBody(request);
    const headers = forwardHeaders(request.headers, headerContext);

    let upstream;
    try {
      upstream = await keyedFetch(`${url}${route}`, {
        method: request.method,
        headers,
        body: BODYLESS_METHODS.includes(request.method) ? undefined : body,
      });
    } catch (error) {
      const cause = error.cause ? ` (${error.cause.code ?? ''} ${error.cause.message ?? error.cause})` : '';
      sendJson(response, 502, { error: { message: `Shomra backend unreachable at ${url}: ${error.message}${cause}` } });
      console.log(`  ${red('✗')} ${request.method} ${request.url} ${red('backend unreachable')}${dim(cause)} ${dim(`hdrs: ${Object.keys(headers).join(',')}`)}`);
      return;
    }

    await relayResponse(upstream, response);
    logCall(provider, request, suffix ?? '/', upstream.status);
  };
}

function printStartupBanner({ port, url, project, actor }) {
  console.log(bold(cyan('\n  Shomra LLM Guard')) + dim(` - local proxy v${VERSION}`));
  console.log(`  ${green('●')} Listening on ${bold(`http://127.0.0.1:${port}`)} ${dim(`→ ${url} → provider`)}`);
  if (project) console.log(`  ${dim('Project  ')} ${project}`);
  console.log(`  ${dim('Actor    ')} ${actor}\n`);

  console.log(bold('  Route your SDKs through the guard (no code changes):'));
  console.log(dim('    OpenAI / Anthropic (PowerShell)'));
  console.log(`      $env:OPENAI_BASE_URL    = "http://127.0.0.1:${port}/openai/v1"`);
  console.log(`      $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:${port}/anthropic"`);
  console.log(dim('    OpenAI / Anthropic (bash/zsh)'));
  console.log(`      export OPENAI_BASE_URL=http://127.0.0.1:${port}/openai/v1`);
  console.log(`      export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}/anthropic`);
  console.log(dim('    Gemini - point the Google GenAI SDK base URL at'));
  console.log(`      http://127.0.0.1:${port}/gemini`);
  console.log(dim(`    OpenAI-compatible (${OPENAI_COMPATIBLE.join(', ')}) - set the SDK baseURL to`));
  console.log(`      http://127.0.0.1:${port}/<provider>/v1`);
  console.log(dim(`    Embeddings only (${EMBEDDINGS_ONLY.join(', ')}) - POST to`));
  console.log(`      http://127.0.0.1:${port}/<provider>/v1/embeddings`);
  console.log(dim('\n  Prompts and completions are screened against org policy;'));
  console.log(dim('  blocked calls return HTTP 403 with the reason. Ctrl+C to stop.\n'));
}

export async function cmdLlmProxy(flags) {
  const config = loadConfig();
  const { apiKey, url } = resolveSettings(config);
  if (!apiKey) exitNotConfigured();

  const port = parseInt(flags.port, 10) || DEFAULT_PORT;
  const project = flags.project ? String(flags.project) : null;
  const actor = `${os.hostname()}/${currentUsername()}`;

  const handler = createProxyHandler({
    url,
    providerPattern: new RegExp(`^/(${LLM_PROVIDERS.join('|')})(/.*)?$`),
    headerContext: {
      apiKey,
      actor,
      project,
      machineId: config.machineId,
      sessionId: newSessionId(),
      agentId: resolveAgentIdentityHandle(flags) ?? storedAgentCredential(config, null, url),
    },
  });

  const { createServer } = await import('node:http');
  const server = createServer(containRequestErrors(handler));
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.on('error', (error) => {
    const why = error?.code === 'EADDRINUSE'
      ? `port ${port} is already in use - another llm-proxy may be running, or pass --port <n>`
      : error?.message ?? String(error);
    console.error(red(`✗ Shomra LLM proxy could not listen: ${why}`));
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => printStartupBanner({ port, url, project, actor }));
}

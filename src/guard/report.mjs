import { gateMachine } from '../core/api-client.mjs';
import { breakerOpen, breakerReset, breakerTrip, guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { resolveCommand } from './command-resolve.mjs';
import { redactLocally } from '../detect/local-redact.mjs';
import { keyedFetch } from '../core/keyed-fetch.mjs';
import { git } from '../core/git-exec.mjs';
import { drainReports, queueReport } from './report-outbox.mjs';

let gitEmail;

function configuredEmail() {
  if (gitEmail !== undefined) return gitEmail;
  try {
    gitEmail = git(['config', '--get', 'user.email'], { timeout: 1500 })?.trim() || null;
  } catch {
    gitEmail = null;
  }
  return gitEmail;
}

export function triggerOf(env) {
  if (env?.environment === 'CI') return `ci:${env.ciProvider || 'pipeline'}`;
  if (env?.environment === 'REMOTE') return 'cli:remote';
  return 'cli:local';
}

export function actingPerson(env, vars = process.env, readEmail = configuredEmail) {
  const token = String(vars.NOFLY_USER_TOKEN ?? '').trim();
  const named = String(vars.NOFLY_USER ?? '').trim();
  const email = named || (env?.environment === 'CI' ? '' : readEmail() || '');
  if (!email && !token) return {};
  return { principal: { ...(email ? { email } : {}), ...(token ? { token } : {}) } };
}

export function buildGuardBody(norm, agent, clientDecision, clientReason) {
  const command = norm.tool_input?.command ?? norm.tool_input?.cmd ?? norm.tool_input?.script;
  const env = detectEnv();
  const found = typeof command === 'string' ? resolveCommand(command) : null;
  const resolved = found?.command ? { ...found, command: redactLocally(found.command, { categories: ['secret'] }).text } : found;
  return {
    tool_name: norm.tool_name,
    tool_input: norm.tool_input,
    ...(norm.mcp_gateway ? { mcp_gateway: norm.mcp_gateway } : {}),
    ...(resolved ? { resolved } : {}),
    cwd: norm.cwd,
    session_id: norm.session_id,
    ...(norm.parent_session_id ? { parent_session_id: norm.parent_session_id } : {}),
    machine: gateMachine(),
    env,
    trigger: triggerOf(env),
    ...actingPerson(env),
    agent,
    ...(clientDecision ? { client_decision: clientDecision, client_reason: clientReason } : {}),
  };
}

async function postReport(url, apiKey, agentId, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(guardTimeoutMs(), 1000));
  try {
    const res = await keyedFetch(`${url}/gate/tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NoFly-Key': apiKey, ...(agentId ? { 'X-NoFly-Agent': agentId } : {}), Connection: 'close' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    res.body?.cancel?.().catch(() => {});
    if (res.status >= 500 || res.status === 429 || res.status === 408) return 'failed';
    return res.ok ? 'sent' : 'rejected';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

export async function reportGuardDecision(url, apiKey, agentId, body) {
  if (!apiKey || !url) return;
  if (breakerOpen()) {
    queueReport(url, agentId, body);
    return;
  }
  const outcome = await postReport(url, apiKey, agentId, body);
  if (outcome === 'failed') {
    breakerTrip();
    queueReport(url, agentId, body);
    return;
  }
  breakerReset();
  await flushQueuedReports(url, apiKey);
}

export async function flushQueuedReports(url, apiKey) {
  if (!apiKey || !url) return;
  await drainReports(url, (entry) => postReport(url, apiKey, entry.agentId ?? undefined, entry.body));
}

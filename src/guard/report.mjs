import { gateMachine } from '../core/api-client.mjs';
import { breakerOpen, breakerReset, breakerTrip, guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { resolveCommand } from './command-resolve.mjs';
import { redactLocally } from '../detect/local-redact.mjs';
import { keyedFetch } from '../core/keyed-fetch.mjs';
import { drainReports, queueReport } from './report-outbox.mjs';

export function buildGuardBody(norm, agent, clientDecision, clientReason) {
  const command = norm.tool_input?.command ?? norm.tool_input?.cmd ?? norm.tool_input?.script;
  const found = typeof command === 'string' ? resolveCommand(command) : null;
  const resolved = found?.command ? { ...found, command: redactLocally(found.command, { categories: ['secret'] }).text } : found;
  return {
    tool_name: norm.tool_name,
    tool_input: norm.tool_input,
    ...(resolved ? { resolved } : {}),
    cwd: norm.cwd,
    session_id: norm.session_id,
    ...(norm.parent_session_id ? { parent_session_id: norm.parent_session_id } : {}),
    machine: gateMachine(),
    env: detectEnv(),
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

import { gateMachine } from '../core/api-client.mjs';
import { breakerReset, breakerTrip, guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { keyedFetch } from '../core/keyed-fetch.mjs';
import { redactLocally } from '../detect/local-redact.mjs';

const LISTING_REPORT_TIMEOUT_MS = 2000;

async function postJson(url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await keyedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shomra-Key': apiKey, Connection: 'close' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

const MAX_ARGS = 100;
const SECRET_FLAG = /^--?(?:api[-_]?key|access[-_]?key|key|secret|client[-_]?secret|token|access[-_]?token|auth|authorization|bearer|password|passwd|pwd|credentials?|private[-_]?key|cookie|session)(?:$|[-_=.])/i;
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s@]*@/gi;

export function maskedLaunchArgs(args) {
  const out = [];
  let maskNext = false;
  for (const raw of Array.isArray(args) ? args : []) {
    const a = String(raw);
    if (maskNext) {
      out.push('[redacted]');
      maskNext = false;
      continue;
    }
    const eq = a.indexOf('=');
    if (/^--?[\w.-]+$/.test(a) && SECRET_FLAG.test(a)) {
      out.push(a);
      maskNext = true;
      continue;
    }
    if (eq > 1 && /^--?[\w.-]+=/.test(a) && SECRET_FLAG.test(a.slice(0, eq + 1))) {
      out.push(`${a.slice(0, eq)}=[redacted]`);
      continue;
    }
    out.push(redactLocally(a.replace(USERINFO, '$1')).text);
  }
  if (out.length <= MAX_ARGS) return out;
  return [...out.slice(0, MAX_ARGS - 1), `[+${out.length - MAX_ARGS + 1} more arguments not sent]`];
}

const VERDICTS = new Set(['ALLOW', 'FLAG', 'BLOCK']);

export async function requestConnectVerdict({ url, apiKey, server, agent, projectId }) {
  try {
    const response = await postJson(`${url}/gate/mcp-connect`, apiKey, {
      server: { ...server, args: maskedLaunchArgs(server.args) },
      machine: gateMachine(),
      env: detectEnv(),
      agent,
      projectId,
      sessionId: process.env.SHOMRA_SESSION_ID || undefined,
    }, guardTimeoutMs());
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) return { error };
      throw error;
    }
    const verdict = JSON.parse(response.text);
    if (!verdict || typeof verdict !== 'object' || !VERDICTS.has(verdict.decision)) throw new Error('the backend answered without a connect decision');
    breakerReset();
    return { verdict };
  } catch (error) {
    breakerTrip();
    return { error };
  }
}

export function reportListing(url, apiKey, body) {
  if (!url || !apiKey) return;
  postJson(`${url}/gate/mcp-listing`, apiKey, body, LISTING_REPORT_TIMEOUT_MS).catch(() => {});
}

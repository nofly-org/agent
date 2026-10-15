import os from 'node:os';
import { getMachineId, getMachineSerial, loadConfig } from './config.mjs';
import { readMachineSerial } from './machine-serial.mjs';
import { clampInt } from './numbers.mjs';
import { reportUsername } from './user-homes.mjs';
import { VERSION } from './version.mjs';
import { describeFetchError, keyedFetch } from './keyed-fetch.mjs';

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;
const MAX_ERROR_TEXT = 300;

export function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || process.env.LOGNAME || '';
  }
}

export function gateMachine() {
  let machineId;
  try {
    machineId = loadConfig().machineId;
  } catch {

  }
  return { ...(typeof machineId === 'string' && machineId ? { machineId } : {}), hostname: os.hostname(), username: currentUsername() };
}

export function machineInfo(cfg) {
  const serial = getMachineSerial(cfg, () => readMachineSerial());
  return {
    machineId: getMachineId(cfg),
    ...(serial ? { serial } : {}),
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: os.release(),
    username: reportUsername(),
    agentVersion: VERSION,
  };
}

export function errorText(json, res) {
  const msg = json?.message ?? json?.error ?? json?.raw ?? res.statusText;
  const text = Array.isArray(msg) ? msg.join(', ') : typeof msg === 'string' ? msg : JSON.stringify(msg);
  const plain = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > MAX_ERROR_TEXT ? `${plain.slice(0, MAX_ERROR_TEXT)}…` : plain;
}

function retryWaitMs(res, attempt) {
  const raw = res.headers?.get?.('retry-after');
  const secs = Number(raw);
  if (raw && Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_WAIT_MS);
  const when = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_WAIT_MS);
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

function networkError(e, url) {
  return new Error(describeFetchError(e, url));
}

export function okBody(text, json, url) {
  if (!String(text).trim()) return {};
  if (json === undefined) {
    if (/^\s*</.test(text)) throw new Error(`${originOf(url)} answered with a web page instead of data - a proxy or sign-in page may be in the way`);
    return { raw: text };
  }
  if (json === null || typeof json !== 'object') throw new Error(`${originOf(url)} answered with something this version of the CLI cannot read`);
  return json;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}

export async function api(url, key, route, body, opts = {}) {

  if (!url) throw new Error('no backend configured - set SHOMRA_URL or run `shomra init --url <your backend>`');

  const timeoutMs = opts.timeoutMs ?? clampInt(process.env.SHOMRA_API_TIMEOUT_MS, 30000, 1000, 600000);
  const deadline = Date.now() + timeoutMs;
  const method = opts.method ?? 'POST';
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(deadline - Date.now(), 1));
    let res;
    let text;
    try {
      res = await keyedFetch(`${url}${route}`, {
        method,

        headers: { 'Content-Type': 'application/json', 'X-Shomra-Key': key, Connection: 'close' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms (raise SHOMRA_API_TIMEOUT_MS or check the backend)`);
      throw networkError(e, url);
    } finally {
      clearTimeout(timer);
    }
    let json;
    let parsed = true;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
      parsed = false;
    }
    if (res.ok) return okBody(text, parsed ? json : undefined, url);
    if (RETRY_STATUSES.has(res.status) && attempt < (opts.retries ?? MAX_RETRIES)) {
      const wait = retryWaitMs(res, attempt);
      if (Date.now() + wait < deadline) {
        await sleep(wait);
        continue;
      }
    }
    const err = new Error(`${res.status} ${errorText(json, res)}`);

    err.status = res.status;
    err.auth = res.status === 401 || res.status === 403;
    err.rejected = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw err;
  }
}

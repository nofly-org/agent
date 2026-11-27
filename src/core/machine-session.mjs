import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, getMachineId } from './config.mjs';
import { keyedFetch } from './keyed-fetch.mjs';
import { writeCachedCredential } from './workload-identity.mjs';
import { isAgentCredential } from './api-key.mjs';

export const MACHINE_SESSION_PATH = '/agents/machine-session';
const RENEW_BEFORE_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

export function machineSessionCachePath(dir = CONFIG_DIR) {
  return path.join(dir, 'machine-sessions.json');
}

export function storedMachineBinding(cfg, vendor, url) {
  const all = cfg?.agentCredentials;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  for (const key of [vendor, 'default']) {
    const e = key ? all[key] : null;
    if (!e || e.machineBound !== true || typeof e.slug !== 'string' || !e.slug) continue;
    if (url && e.url && e.url !== url) continue;
    return e;
  }
  return null;
}

function readSessions(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function cachedMachineSession(file, { url, slug, now = Date.now() }) {
  const e = readSessions(file)[`${url}|${slug}`];
  if (!e || typeof e.credential !== 'string' || !isAgentCredential(e.credential)) return null;
  return Date.parse(e.expiresAt) - now > RENEW_BEFORE_MS ? e.credential : null;
}

export async function machineSessionCredential({ cfg, url, binding, file = machineSessionCachePath(), fetchImpl = keyedFetch, onError = () => {} }) {
  if (!binding || !url || !cfg?.apiKey) return null;
  const cached = cachedMachineSession(file, { url, slug: binding.slug });
  if (cached) return cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${url}${MACHINE_SESSION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NoFly-Key': cfg.apiKey, Connection: 'close' },
      body: JSON.stringify({ agent: binding.slug, machineId: getMachineId(cfg) }),
      signal: ctrl.signal,
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (typeof body?.credential !== 'string' || !isAgentCredential(body.credential)) {
      onError(new Error(`the backend issued no session for "${binding.slug}" (HTTP ${res.status})`));
      return null;
    }
    const sessions = readSessions(file);
    sessions[`${url}|${binding.slug}`] = { credential: body.credential, expiresAt: body.expiresAt };
    writeCachedCredential(file, sessions);
    return body.credential;
  } catch (e) {
    onError(e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

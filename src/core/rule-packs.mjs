import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { readRegularText } from './safe-read.mjs';

export const RULE_PACKS_FILE = path.join(CONFIG_DIR, 'rule-packs.json');
export const RULE_PACK_KEYS_FILE = path.join(CONFIG_DIR, 'rule-pack-keys.json');
const REFRESH_MARK_FILE = path.join(CONFIG_DIR, 'rule-packs-refresh.json');

export const RULE_PACKS_STALE_MS = 24 * 60 * 60 * 1000;
const REFRESH_EVERY_MS = 60 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(readRegularText(file));
  } catch {
    return null;
  }
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function envKey() {
  const k = String(process.env.NOFLY_RULES_KEY ?? '').trim().toLowerCase();
  return k || null;
}

export function pinnedKey(url) {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  const pins = readJson(RULE_PACK_KEYS_FILE);
  return url && typeof pins?.[url] === 'string' ? pins[url] : null;
}

function pin(url, fingerprint) {
  if (envKey()) return;
  const pins = readJson(RULE_PACK_KEYS_FILE) ?? {};
  writePrivate(RULE_PACK_KEYS_FILE, { ...pins, [url]: fingerprint });
}

export function rulePacksOff() {
  const v = String(process.env.NOFLY_RULE_PACKS ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

export async function syncRulePacks({ url, apiKey, trustNewKey = false, fetchEnvelope, timeoutMs = 15000 } = {}) {
  if (!url || !apiKey) return { ok: false, error: 'no NoFly server is configured on this machine' };
  const { openRulePacks } = await import('../detect/signals/rule-pack-envelope.mjs');
  let envelope;
  try {
    envelope = fetchEnvelope
      ? await fetchEnvelope()
      : await (await import('./api-client.mjs')).api(url, apiKey, '/gate/rule-packs', undefined, { method: 'GET', timeoutMs });
  } catch (e) {
    return { ok: false, error: `the server did not send its rule packs - ${e?.message ?? e}` };
  }
  const pinned = trustNewKey && !envKey() ? null : pinnedKey(url);
  const opened = openRulePacks(envelope, pinned);
  if ('error' in opened) {
    const hint = pinned && opened.error.includes('does not trust') ? ' If the server key was rotated on purpose, run `nofly packs sync --trust-new-key`.' : '';
    return { ok: false, error: `${opened.error}.${hint}` };
  }
  if (!pinned) pin(url, opened.fingerprint);
  writePrivate(RULE_PACKS_FILE, { url, fetchedAt: new Date().toISOString(), envelope });
  return {
    ok: true,
    packs: opened.packs.length,
    rules: opened.packs.reduce((n, p) => n + p.rules.length, 0),
    issuedAt: opened.issuedAt,
    fingerprint: opened.fingerprint,
    pinnedNow: !pinned,
  };
}

export async function readRulePacks({ url } = {}) {
  const cache = readJson(RULE_PACKS_FILE);
  if (!cache) return null;
  if (url && cache.url !== url) return { error: `the cached rule packs came from ${cache.url}, not ${url}`, fetchedAt: cache.fetchedAt ?? null };
  const pinned = pinnedKey(cache.url);
  if (!pinned) return { error: 'no trusted server key is pinned for these rule packs', fetchedAt: cache.fetchedAt ?? null };
  const { openRulePacks } = await import('../detect/signals/rule-pack-envelope.mjs');
  const opened = openRulePacks(cache.envelope, pinned);
  if ('error' in opened) return { error: opened.error, fetchedAt: cache.fetchedAt ?? null };
  return { ...opened, fetchedAt: cache.fetchedAt ?? null, url: cache.url };
}

let builtins = null;

function rebuild(target, next) {
  target.length = 0;
  target.push(...next);
}

export async function applyRulePacks(packs) {
  const [{ compilePacks }, injection, secrets, shell, egress, config, names, intel] = await Promise.all([
    import('../detect/signals/pack-compile.mjs'),
    import('../detect/signals/injection.mjs'),
    import('../detect/signals/secrets.mjs'),
    import('../detect/signals/shell.mjs'),
    import('../detect/signals/egress.mjs'),
    import('../detect/signals/config-markers.mjs'),
    import('../detect/signals/package-names.mjs'),
    import('../detect/signals/package-intel.mjs'),
  ]);
  builtins ??= {
    injection: [...injection.INJECTION_PHRASES],
    injectionRe: [...injection.INJECTION_REGEXES],
    secrets: [...secrets.SECRET_PATTERNS],
    shell: [...shell.DANGEROUS_SHELL],
    egress: [...egress.SUSPICIOUS_EGRESS_HOSTS],
    risky: [...config.RISKY_CONFIG_MARKERS],
  };
  const feed = packs.find((p) => p.kind === intel.PACKAGE_INTEL_KIND && intel.isPackedPackageIntel(p.rules?.[0]));
  names.loadPackageIntel(feed ? intel.unpackPackageIntel(feed.rules[0]) : names.SNAPSHOT_INTEL, feed ? 'feed' : 'snapshot');
  const { compiled, rules } = compilePacks(packs.filter((p) => p.kind !== intel.PACKAGE_INTEL_KIND));
  rebuild(injection.INJECTION_PHRASES, [...builtins.injection, ...compiled.injection]);
  rebuild(injection.INJECTION_REGEXES, [...builtins.injectionRe, ...compiled.injectionRe]);
  rebuild(secrets.SECRET_PATTERNS, [...builtins.secrets, ...compiled.secrets]);
  rebuild(shell.DANGEROUS_SHELL, [...builtins.shell, ...compiled.shell]);
  rebuild(egress.SUSPICIOUS_EGRESS_HOSTS, [...builtins.egress, ...compiled.egress]);
  rebuild(config.RISKY_CONFIG_MARKERS, [...builtins.risky, ...compiled.risky]);
  for (const p of compiled.malicious) names.MALICIOUS_PACKAGE_SEED.add(p);
  return { rules, intel: feed ? 'feed' : 'snapshot' };
}

export async function applyCachedRulePacks() {
  if (rulePacksOff()) return { state: 'off' };
  if (!fs.existsSync(RULE_PACKS_FILE)) return { state: 'none' };
  const { loadConfig, resolveSettings } = await import('./config.mjs');
  const { url } = resolveSettings(loadConfig());
  const read = await readRulePacks({ url });
  if (!read) return { state: 'none' };
  if ('error' in read) return { state: 'refused', error: read.error, fetchedAt: read.fetchedAt };
  const { rules } = await applyRulePacks(read.packs);
  return { state: 'applied', rules, issuedAt: read.issuedAt, fetchedAt: read.fetchedAt };
}

export const REFRESH_WAIT_MS = 1500;

export async function refreshRulePacksIfStale({ url, apiKey, now = Date.now(), waitMs = REFRESH_WAIT_MS, fetchEnvelope } = {}) {
  if (!url || !apiKey || rulePacksOff()) return null;
  const cache = readJson(RULE_PACKS_FILE);
  if (cache?.url === url && now - Date.parse(cache.fetchedAt ?? '') < RULE_PACKS_STALE_MS) return null;
  const mark = readJson(REFRESH_MARK_FILE);
  if (mark && now - Number(mark.at) < REFRESH_EVERY_MS) return null;
  try {
    writePrivate(REFRESH_MARK_FILE, { at: now });
  } catch {
    return null;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `no answer within ${waitMs}ms` }), waitMs);
  });
  try {
    return await Promise.race([syncRulePacks({ url, apiKey, fetchEnvelope, timeoutMs: waitMs }), timeout]);
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

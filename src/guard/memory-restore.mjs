import fs from 'node:fs';
import path from 'node:path';
import { isMemoryPath } from '../commands/memory-scan.mjs';
import { readLedger, recordLedger, sha256 } from './memory-write.mjs';
import { gateMachine } from '../core/api-client.mjs';
import { keyedFetch } from '../core/keyed-fetch.mjs';
import { guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { writeFileAtomic } from '../core/json-file.mjs';
import { readRegularText } from '../core/safe-read.mjs';

const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export const MAX_RESTORE_BYTES = 256 * 1024;

const NEVER_RESTORE_NAMES = new Set([
  'hooks.json', '.mcp.json', 'mcp.json', 'mcp_config.json', 'settings.json', 'settings.local.json', 'managed-settings.json',
  'gemini-extension.json', 'qwen-extension.json', 'plugin.json', 'marketplace.json', 'installed_plugins.json', 'known_marketplaces.json',
  'package.json', 'package-lock.json', 'claude_desktop_config.json', '.claude.json', 'config.toml', 'config.json', 'config.yaml', 'config.yml',
  'keybindings.json', 'extensions.json', '.npmrc', '.netrc', 'makefile', 'dockerfile',
]);
const NEVER_RESTORE_EXT = /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|command|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|pm|php|lua|exe|dll|so|dylib)$/i;
const NEVER_RESTORE_DIR = /(?:^|\/)(?:\.claude-plugin|hooks)\//i;

export function restoreRefusal(p) {
  const norm = String(p).split(path.sep).join('/');
  const base = path.posix.basename(norm).toLowerCase();
  if (NEVER_RESTORE_NAMES.has(base) || /^\.env(?:\.|$)/.test(base)) return 'it is an agent or tool configuration file, which a rollback never writes';
  if (NEVER_RESTORE_EXT.test(base)) return 'it is a script or program, which a rollback never writes';
  if (NEVER_RESTORE_DIR.test(norm)) return 'it sits in a hooks or plugin manifest folder, which a rollback never writes';
  return null;
}
export const MAX_RESTORES = 20;

const readOrNull = (p) => {
  try {
    return readRegularText(p);
  } catch {
    return null;
  }
};

export function restoreVerdict(item, { read = readOrNull, ledger = readLedger } = {}) {
  const raw = typeof item?.path === 'string' ? item.path : '';
  const p = raw ? path.resolve(raw) : '';
  if (!raw || !path.isAbsolute(raw)) return { ok: false, reason: 'the path it named is not an absolute path on this machine' };
  if (!isMemoryPath(p)) return { ok: false, reason: 'the path it named is not an agent memory or rules file, so the hook will not write it' };
  const refusal = restoreRefusal(p);
  if (refusal) return { ok: false, reason: `the hook will not write it: ${refusal}` };
  if (!ledger(p)) return { ok: false, reason: 'the hook has never seen this file on this machine' };
  if (typeof item.content !== 'string' || Buffer.byteLength(item.content, 'utf8') > MAX_RESTORE_BYTES) return { ok: false, reason: 'the version it sent is missing or too large to write back' };
  if (sha256(item.content) !== item.hash) return { ok: false, reason: 'the version it sent does not match its own hash' };
  const current = read(p);
  if (current == null) return { ok: false, reason: 'the file is no longer on disk' };
  const target = realOf(p);
  if (target !== p && (!isMemoryPath(target) || restoreRefusal(target))) return { ok: false, reason: `the file is a link to ${target}, which is not an agent memory or rules file, so the hook will not write through it` };
  if (sha256(current) === item.hash) return { ok: true, path: p, target, already: true };
  if (sha256(current) !== item.replaces) return { ok: false, reason: 'the file changed since the rollback was asked for, so writing it back could lose someone’s edits' };
  return { ok: true, path: p, target };
}

export function writeRestored(p, content) {
  writeFileAtomic(realOf(p), content);
  return sha256(readRegularText(p));
}

async function call(url, apiKey, route, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), guardTimeoutMs());
  try {
    const res = await keyedFetch(`${url}${route}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-NoFly-Key': apiKey, Connection: 'close', ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function applyPendingRestores({ url, apiKey, read = readOrNull, write = writeRestored, ledger = readLedger, record = recordLedger } = {}) {
  const out = { applied: [], refused: [], unread: false };
  if (!url || !apiKey) return out;
  const machine = gateMachine();
  if (!machine.machineId) return out;
  const query = new URLSearchParams({ machineId: machine.machineId, hostname: machine.hostname ?? '' });
  const listed = await call(url, apiKey, `/memory/restores/pending?${query}`);
  if (!listed || !Array.isArray(listed.restores)) {
    out.unread = true;
    return out;
  }
  for (const item of listed.restores.slice(0, MAX_RESTORES)) {
    const verdict = restoreVerdict(item, { read, ledger });
    let ack;
    if (verdict.ok && verdict.already) {
      record(verdict.path, [item.hash]);
      ack = { applied: true, contentHash: item.hash };
      out.applied.push(verdict.path);
    } else if (verdict.ok) {
      try {
        const written = write(verdict.path, item.content);
        record(verdict.path, [written]);
        ack = { applied: true, contentHash: written };
        out.applied.push(verdict.path);
      } catch (e) {
        ack = { applied: false, reason: `the file could not be written (${String(e?.code ?? e?.message ?? 'error').slice(0, 60)})` };
        out.refused.push({ path: item.path, reason: ack.reason });
      }
    } else {
      ack = { applied: false, reason: verdict.reason };
      out.refused.push({ path: item.path, reason: verdict.reason });
    }
    await call(url, apiKey, `/memory/restores/${encodeURIComponent(String(item.storeId ?? ''))}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ...ack, machineId: machine.machineId, hostname: machine.hostname }),
    });
  }
  return out;
}

export function restoreSummary(result) {
  const lines = [];
  if (result.applied.length) lines.push(`Restored ${result.applied.length} rolled-back memory file${result.applied.length === 1 ? '' : 's'}: ${result.applied.join(', ')}`);
  for (const r of result.refused) lines.push(`Did not restore ${r.path}: ${r.reason}.`);
  if (result.unread) lines.push('Could not read which memory files were rolled back, so none were restored.');
  return lines;
}

export async function cmdMemoryRestore() {
  const { loadConfig, resolveSettings } = await import('../core/config.mjs');
  const settings = resolveSettings(loadConfig());
  if (!settings.apiKey) {
    console.error('NoFly is not configured on this machine. Run: nofly init --key nfy_…');
    process.exit(1);
  }
  const result = await applyPendingRestores({ url: settings.url, apiKey: settings.apiKey });
  const lines = restoreSummary(result);
  console.log(lines.length ? lines.join('\n') : 'No rolled-back memory files are waiting for this machine.');
  process.exit(result.unread || result.refused.length ? 1 : 0);
}

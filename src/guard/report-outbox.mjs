import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../core/config.mjs';

const MAX_ENTRIES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAIN_PER_CALL = 5;

const outboxFile = (dir) => path.join(dir, 'report-outbox.jsonl');

function entryLine(entry) {
  let line = JSON.stringify(entry);
  if (line.length > MAX_ENTRY_BYTES) line = JSON.stringify({ ...entry, body: { ...entry.body, tool_input: { omitted: 'larger than 64 KB' } } });
  return line.length > MAX_ENTRY_BYTES ? null : line;
}

function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.body && typeof entry.url === 'string') out.push(entry);
    } catch {
    }
  }
  return out;
}

function appendEntries(entries, dir) {
  const lines = entries.map(entryLine).filter(Boolean);
  if (!lines.length) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = outboxFile(dir);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
  }
  if (size > MAX_BYTES) {
    const kept = parseLines(fs.readFileSync(file, 'utf8')).slice(-Math.floor(MAX_ENTRIES / 2));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map(entryLine).filter(Boolean).map((l) => `${l}\n`).join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

export function queueReport(url, agentId, body, { dir = CONFIG_DIR, now = Date.now() } = {}) {
  try {
    appendEntries([{ url, agentId: agentId ?? null, at: now, body }], dir);
  } catch {
  }
}

export async function drainReports(url, send, { dir = CONFIG_DIR, now = Date.now(), limit = DRAIN_PER_CALL } = {}) {
  const file = outboxFile(dir);
  const claim = `${file}.${process.pid}.${now}.drain`;
  try {
    fs.renameSync(file, claim);
  } catch {
    return { sent: 0, kept: 0 };
  }
  let entries = [];
  try {
    entries = parseLines(fs.readFileSync(claim, 'utf8'));
  } catch {
  }
  try {
    fs.unlinkSync(claim);
  } catch {
  }
  const fresh = entries.filter((e) => now - Number(e.at ?? 0) < MAX_AGE_MS).slice(-MAX_ENTRIES);
  const ours = fresh.filter((e) => e.url === url);
  const batch = ours.slice(0, limit);
  const outcomes = await Promise.all(batch.map((e) => send(e).catch(() => 'failed')));
  const keep = [...batch.filter((_, i) => outcomes[i] === 'failed'), ...ours.slice(limit), ...fresh.filter((e) => e.url !== url)];
  try {
    appendEntries(keep, dir);
  } catch {
  }
  return { sent: outcomes.filter((o) => o === 'sent').length, kept: keep.length };
}

export function pendingReports({ dir = CONFIG_DIR } = {}) {
  try {
    return parseLines(fs.readFileSync(outboxFile(dir), 'utf8')).length;
  } catch {
    return 0;
  }
}

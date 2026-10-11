import path from 'node:path';
import { git, gitBlobWindow, gitBuffer, safeRef } from './git-exec.mjs';

const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=ACMRT', '--relative'];
const TIMEOUT_MS = 15000;
const MAX_LINK_HOPS = 8;
const FILE_MODES = new Set(['100644', '100755']);
const LINK_MODE = '120000';

const nulList = (out) => out.split('\0').filter(Boolean);

export function diffNames(root, revs, { timeout = TIMEOUT_MS } = {}) {
  const out = git(['diff', '--name-only', '-z', ...DIFF_OPTIONS, ...revs], { cwd: root, timeout });
  return out === null ? null : nulList(out);
}

export function stagedNames(root, opts) {
  return diffNames(root, ['--cached'], opts);
}

export function untrackedNames(root, { timeout = TIMEOUT_MS } = {}) {
  const out = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, timeout });
  return out === null ? [] : nulList(out);
}

export function workingChanges(root, opts) {
  const tracked = diffNames(root, ['HEAD'], opts) ?? stagedNames(root, opts);
  if (tracked === null) return null;
  return [...new Set([...tracked, ...untrackedNames(root, opts)])];
}

export function stagedEntries(root, { timeout = TIMEOUT_MS } = {}) {
  const out = git(['diff', '--cached', '--raw', '-z', '--no-abbrev', ...DIFF_OPTIONS], { cwd: root, timeout });
  if (out === null) return null;
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]{40,64}) [ACMRT]/.exec(parts[i]);
    if (m && parts[i + 1]) entries.push({ rel: parts[i + 1], mode: m[1], oid: m[2] });
  }
  return entries;
}

export function indexFilesUnder(root, dirRel, { timeout = TIMEOUT_MS } = {}) {
  const out = git(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', dirRel || '.'], { cwd: root, timeout });
  if (out === null) return null;
  const entries = [];
  for (const record of nulList(out)) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.*)$/s.exec(record);
    if (m) entries.push({ rel: m[3], mode: m[1], oid: m[2] });
  }
  return entries;
}

function indexEntry(root, rel) {
  const out = git(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', rel], { cwd: root, timeout: TIMEOUT_MS });
  if (!out) return null;
  for (const record of nulList(out)) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.*)$/s.exec(record);
    if (m && m[3] === rel) return { rel, mode: m[1], oid: m[2] };
  }
  return null;
}

function blobSizes(root, oids) {
  const sizes = new Map();
  if (!oids.length) return sizes;
  const out = gitBuffer(['cat-file', '--batch-check'], { cwd: root, input: `${oids.join('\n')}\n`, timeout: TIMEOUT_MS });
  if (!out) return sizes;
  for (const line of out.toString('utf8').split('\n')) {
    const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(line.trim());
    if (m) sizes.set(m[1], Number(m[2]));
  }
  return sizes;
}

function smallBlobs(root, oids, sizes) {
  const blobs = new Map();
  if (!oids.length) return blobs;
  const total = oids.reduce((sum, oid) => sum + (sizes.get(oid) ?? 0), 0);
  const out = gitBuffer(['cat-file', '--batch'], { cwd: root, input: `${oids.join('\n')}\n`, timeout: TIMEOUT_MS, maxBuffer: total + oids.length * 256 + 65536 });
  if (!out) return blobs;
  let at = 0;
  while (at < out.length) {
    const newline = out.indexOf(0x0a, at);
    if (newline === -1) break;
    const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(out.subarray(at, newline).toString('utf8'));
    if (!m) break;
    const size = Number(m[2]);
    const start = newline + 1;
    blobs.set(m[1], out.subarray(start, start + size).toString('utf8'));
    at = start + size + 1;
  }
  return blobs;
}

export async function readBlobs(root, oids, { maxBytes }) {
  const unique = [...new Set(oids)];
  const sizes = blobSizes(root, unique);
  const small = unique.filter((oid) => sizes.has(oid) && sizes.get(oid) <= maxBytes);
  const read = new Map();
  for (const [oid, content] of smallBlobs(root, small, sizes)) read.set(oid, { content });
  for (const oid of unique.filter((o) => sizes.get(o) > maxBytes)) {
    const window = await gitBlobWindow(oid, { cwd: root, half: Math.floor(maxBytes / 2) });
    if (window) read.set(oid, { content: window.content, unread: window.unread });
  }
  for (const oid of unique) if (!read.has(oid)) read.set(oid, { skip: 'its staged copy could not be read from git' });
  return read;
}

function linkTarget(rel, text) {
  const target = String(text ?? '').trim();
  if (!target || path.posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target.replace(/\\/g, '/')));
  if (joined === '..' || joined.startsWith('../')) return null;
  return joined;
}

export async function resolveStagedEntry(root, entry, { maxBytes }) {
  let current = entry;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    if (FILE_MODES.has(current.mode)) return { oid: current.oid };
    if (current.mode !== LINK_MODE) return { skip: 'a submodule or other non-file entry in the index' };
    const text = (await readBlobs(root, [current.oid], { maxBytes })).get(current.oid);
    if (text?.skip) return { skip: text.skip };
    const target = linkTarget(current.rel, text?.content);
    if (target === null) return { skip: 'a symlink to a file outside the scanned folder' };
    const next = indexEntry(root, target);
    if (!next) return { dangling: true };
    current = next;
  }
  return { skip: 'a chain of symlinks too long to follow' };
}

export function isMergeHead(root) {
  const out = git(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: root, timeout: TIMEOUT_MS });
  return !!out && out.trim().split(/\s+/).length === 3;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

function mergeBase(root, candidate) {
  const out = git(['merge-base', candidate, 'HEAD'], { cwd: root, timeout: TIMEOUT_MS });
  const sha = out?.trim();
  return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export function changedSinceBase(root, { base, baseSha } = {}) {
  const ref = safeRef(base);
  const candidates = [...(ref ? [`origin/${ref}`, ref] : []), ...(SHA_RE.test(String(baseSha ?? '')) ? [String(baseSha)] : [])];
  for (const candidate of candidates) {
    const baseRev = mergeBase(root, candidate);
    if (!baseRev) continue;
    const files = diffNames(root, [baseRev, 'HEAD']);
    if (files !== null) return { files, against: candidate, baseRev };
  }
  if (isMergeHead(root)) {
    const baseRev = git(['rev-parse', '--verify', '-q', 'HEAD^1'], { cwd: root, timeout: TIMEOUT_MS })?.trim();
    const files = baseRev ? diffNames(root, [baseRev, 'HEAD']) : null;
    if (files !== null) return { files, against: 'HEAD^1', baseRev };
  }
  const sha = SHA_RE.test(String(baseSha ?? '')) ? git(['rev-parse', '--verify', '-q', `${baseSha}^{commit}`], { cwd: root, timeout: TIMEOUT_MS })?.trim() : null;
  if (sha) {
    const files = diffNames(root, [sha, 'HEAD']);
    if (files !== null) return { files, against: String(baseSha), baseRev: sha };
  }
  return null;
}

export function fetchCommit(root, sha, { timeout = 60000 } = {}) {
  if (!/^[0-9a-f]{40,64}$/.test(String(sha ?? ''))) return false;
  return git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha], { cwd: root, timeout }) !== null;
}

export function fileAtRevision(root, rev, rel, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!/^[0-9a-f]{40,64}$/.test(String(rev ?? ''))) return null;
  const out = gitBuffer(['cat-file', 'blob', `${rev}:./${rel}`], { cwd: root, timeout: TIMEOUT_MS, maxBuffer: maxBytes });
  return out === null ? null : out.toString('utf8');
}

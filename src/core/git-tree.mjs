import path from 'node:path';
import { git } from './git-exec.mjs';
import { readBlobs } from './git-changes.mjs';

const TIMEOUT_MS = 30000;
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const MAX_LINK_HOPS = 8;
const MAX_LINK_BYTES = 4096;
export const LINK_MODE = '120000';
export const FILE_MODES = new Set(['100644', '100755']);
const INDEX_RECORD = /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.*)$/s;
const TREE_RECORD = /^(\d{6}) (?:blob|commit|tree) ([0-9a-f]{40,64})\t(.*)$/s;
const OID_RE = /^[0-9a-f]{40,64}$/;

export function resolveRev(root, rev) {
  const r = String(rev ?? '').trim();
  if (!r || r.startsWith('-') || r.length > 200 || !/^[A-Za-z0-9._\/+~^@{}-]+$/.test(r)) return null;
  const sha = git(['rev-parse', '--verify', '-q', `${r}^{commit}`], { cwd: root, timeout: TIMEOUT_MS })?.trim();
  return sha && OID_RE.test(sha) ? sha : null;
}

export function listTree(root, { rev = null } = {}) {
  if (rev !== null && !OID_RE.test(String(rev))) return null;
  const args = rev ? ['ls-tree', '-r', '-z', '--full-tree', String(rev)] : ['--literal-pathspecs', 'ls-files', '--stage', '-z'];
  const out = git(args, { cwd: root, timeout: TIMEOUT_MS, maxBuffer: MAX_LISTING_BYTES });
  if (out === null) return null;
  const record = rev ? TREE_RECORD : INDEX_RECORD;
  const tree = new Map();
  for (const line of out.split('\0')) {
    const m = line ? record.exec(line) : null;
    if (m) tree.set(m[3], { rel: m[3], mode: m[1], oid: m[2] });
  }
  return tree;
}

export function linkTarget(rel, text) {
  const target = String(text ?? '').trim();
  if (!target || path.posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target.replace(/\\/g, '/')));
  if (joined === '..' || joined.startsWith('../')) return null;
  return joined === '.' ? '' : joined;
}

export function sortedKeys(tree) {
  return [...tree.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function keysUnder(keys, dir) {
  if (!dir) return keys;
  const prefix = `${dir}/`;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++) out.push(keys[i]);
  return out;
}

export function treeResolver(root, tree) {
  const links = new Map();
  let keys = null;
  const linkText = async (entry) => {
    if (!links.has(entry.oid)) links.set(entry.oid, (await readBlobs(root, [entry.oid], { maxBytes: MAX_LINK_BYTES })).get(entry.oid));
    return links.get(entry.oid);
  };
  const isDirectory = (rel) => {
    keys ??= sortedKeys(tree);
    return rel === '' || keysUnder(keys, rel).length > 0;
  };
  return async function resolve(rel) {
    let current = rel;
    const trail = [rel];
    for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
      const parts = current.split('/');
      let next = null;
      for (let i = 1; i <= parts.length && next === null; i++) {
        const prefix = parts.slice(0, i).join('/');
        const entry = tree.get(prefix);
        if (!entry) continue;
        const last = i === parts.length;
        if (last && FILE_MODES.has(entry.mode)) return { oid: entry.oid, rel: current, trail };
        if (entry.mode !== LINK_MODE) return last ? { skip: 'a submodule or other entry that is not a file', trail } : { dangling: true, trail };
        const text = await linkText(entry);
        if (typeof text?.content !== 'string' || text.unread) return { skip: 'a symlink git could not read', trail };
        const target = linkTarget(prefix, text.content);
        if (target === null) return { skip: 'a symlink to a file outside the scanned folder', trail };
        next = [target, ...parts.slice(i)].filter(Boolean).join('/');
      }
      if (next === null) return isDirectory(current) ? { directory: true, trail } : { dangling: true, trail };
      current = next;
      trail.push(current);
    }
    return { skip: 'a chain of symlinks too long to follow', trail };
  };
}

export function touchesChange(trail, changed) {
  for (const step of trail) {
    const parts = step.split('/');
    for (let i = parts.length; i > 0; i--) if (changed.has(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

import fs from 'node:fs';
import path from 'node:path';
import { CREDENTIAL_STORE, IGNORE_DIRS, MAX_DEPTH } from './limits.mjs';

function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function insideOf(root, real) {
  const rel = path.relative(root, real);
  if (rel === '') return '';
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : rel;
}

function linkKind(full, roots, here) {
  const real = realOf(full);
  if (!real || insideOf(real, here) !== null || insideOf(real, roots[0]) !== null) return {};
  const rel = roots.map((root) => insideOf(root, real)).find((r) => r !== null);
  if (rel === undefined) return { refused: 'link-outside' };
  if (CREDENTIAL_STORE.test(rel)) return { refused: 'link-withheld' };
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return {};
  }
  return st.isDirectory() ? { type: 'dir' } : st.isFile() ? { type: 'file' } : {};
}

export function walkRoot(dir, budget, { within = [], refused = null } = {}) {
  const out = [];
  const seen = new Set();
  const roots = [dir, ...within].map(realOf).filter(Boolean);
  if (!roots.length) return out;
  const queue = [{ d: dir, depth: 0 }];
  while (queue.length && budget.dirs > 0) {
    const { d, depth } = queue.shift();
    const real = realOf(d);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    budget.dirs--;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const link = e.isSymbolicLink() ? linkKind(full, roots, real) : null;
      if (link?.refused) {
        refused?.push({ reason: link.refused, path: full });
        continue;
      }
      const type = link ? link.type : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : null;
      if (type === 'dir') {
        if (depth < MAX_DEPTH && !IGNORE_DIRS.has(e.name)) queue.push({ d: full, depth: depth + 1 });
      } else if (type === 'file') {
        out.push(full);
      }
    }
  }
  return out;
}

import fs from 'node:fs';
import path from 'node:path';
import { globToRe, loadIgnoreRules } from '../gate/suppressions.mjs';

const _guardIgnoreCache = new Map();

function matchesEverything(glob) {
  const g = String(glob).trim();
  if (!g) return true;
  if (g.replace(/[*/]/g, '') === '') return true;
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) return true;
  if (/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=[\\/]|$)/i.test(g)) return true;
  if (g.split(/[\\/]/).includes('..')) return true;
  return false;
}

function guardIgnoreGlobs(root) {
  if (_guardIgnoreCache.has(root)) return _guardIgnoreCache.get(root);
  const repo = [];
  const env = [];
  const dropped = [];
  try { for (const re of loadIgnoreRules(root).fileGlobs) repo.push(re); } catch {  }
  const raw = process.env.NOFLY_GUARD_IGNORE;
  if (raw) for (const g of String(raw).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
    if (matchesEverything(g)) { dropped.push(g); continue; }
    try { env.push(globToRe(g)); } catch {  }
  }
  const globs = { repo, env, dropped };
  _guardIgnoreCache.set(root, globs);
  return globs;
}

export function droppedGuardIgnoreGlobs(root = process.cwd()) {
  return guardIgnoreGlobs(root).dropped.slice();
}

function relativeTo(root, target) {
  const rel = path.relative(root, target);
  return String(rel).split(path.sep).join('/');
}

function inside(rel) {
  return !!rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function realOrNull(p) {
  const rest = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

export function guardPathAllowlisted(cwd, filePath, { repo: useRepo = true } = {}) {
  if (!filePath) return false;
  const root = cwd || process.cwd();
  let abs;
  try { abs = path.resolve(root, filePath); } catch { return false; }
  const rel = relativeTo(root, abs);
  const base = rel.split('/').pop();
  const { repo, env } = guardIgnoreGlobs(root);
  const hit = (re) => re.test(rel) || re.test(base);
  const pool = useRepo ? [...env, ...repo] : env;
  if (!inside(rel) || !pool.some(hit)) return false;
  const realRoot = realOrNull(root) ?? root;
  const realTarget = realOrNull(abs);
  return !realTarget || inside(relativeTo(realRoot, realTarget));
}

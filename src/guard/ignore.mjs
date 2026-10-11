import fs from 'node:fs';
import path from 'node:path';
import { globToRe, loadIgnoreRules } from '../gate/suppressions.mjs';

const _guardIgnoreCache = new Map();

function guardIgnoreGlobs(root) {
  if (_guardIgnoreCache.has(root)) return _guardIgnoreCache.get(root);
  const repo = [];
  const env = [];
  try { for (const re of loadIgnoreRules(root).fileGlobs) repo.push(re); } catch {  }
  const raw = process.env.SHOMRA_GUARD_IGNORE;
  if (raw) for (const g of String(raw).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) { try { env.push(globToRe(g)); } catch {  } }
  const globs = { repo, env };
  _guardIgnoreCache.set(root, globs);
  return globs;
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

export function guardPathAllowlisted(cwd, filePath) {
  if (!filePath) return false;
  const root = cwd || process.cwd();
  let abs;
  try { abs = path.resolve(root, filePath); } catch { return false; }
  const rel = relativeTo(root, abs);
  const base = rel.split('/').pop();
  const { repo, env } = guardIgnoreGlobs(root);
  const hit = (re) => re.test(rel) || re.test(base);
  if (env.some(hit)) return true;
  if (!inside(rel) || !repo.some(hit)) return false;
  const realRoot = realOrNull(root) ?? root;
  const realTarget = realOrNull(abs);
  return !realTarget || inside(relativeTo(realRoot, realTarget));
}

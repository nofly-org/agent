import os from 'node:os';
import path from 'node:path';
import { guardTouchedPaths } from './classify.mjs';
import { readRegularText } from '../core/safe-read.mjs';

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_PLAN_FILES = 8;

export function plansDirectoryOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const doc = JSON.parse(text);
    const v = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.plansDirectory : null;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

const expandHome = (p, home) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(1)) : p);

const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function configuredPlanDirs(cwd, { home = os.homedir(), read = (p) => readRegularText(p, MAX_SETTINGS_BYTES) } = {}) {
  const files = [path.join(home, '.claude', 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const raw = plansDirectoryOf(text);
    if (!raw) continue;
    const dir = path.resolve(cwd || process.cwd(), expandHome(raw, home));
    if (!out.some((d) => sameDir(d, dir))) out.push(dir);
  }
  return out;
}

export function planFilesField(tool, input, normalized, opts = {}) {
  try {
    const touched = guardTouchedPaths(tool, input).map((p) => String(p ?? '')).filter((p) => /\.md$/i.test(p));
    if (!touched.length) return {};
    const cwd = normalized?.cwd || process.cwd();
    const dirs = configuredPlanDirs(cwd, opts);
    if (!dirs.length) return {};
    const home = opts.home ?? os.homedir();
    const out = [];
    for (const named of touched) {
      const abs = path.resolve(cwd, expandHome(named, home));
      if (dirs.some((d) => sameDir(path.dirname(abs), d)) && !out.includes(named)) out.push(named);
      if (out.length >= MAX_PLAN_FILES) break;
    }
    return out.length ? { plan_files: out } : {};
  } catch {
    return {};
  }
}

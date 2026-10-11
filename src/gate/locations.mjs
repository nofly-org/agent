import path from 'node:path';
import { git } from '../core/git-exec.mjs';

export function locationBase(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 })?.trim();
  return top ? path.resolve(top) : path.resolve(cwd);
}

export function findingPath(result, finding, cwd = process.cwd()) {
  if (finding?.file) return path.resolve(cwd, String(finding.file).replace(/!\/.*$/, ''));
  if (result?.full) return path.resolve(result.full);
  return path.resolve(cwd, String(result?.path ?? '').replace(/!\/.*$/, ''));
}

export function relativeToBase(abs, base) {
  const rel = path.relative(base, abs).split(path.sep).join('/');
  return rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
}

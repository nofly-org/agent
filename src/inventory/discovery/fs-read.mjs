import fs from 'node:fs';
import { parseJsonc } from '../../core/jsonc.mjs';

export function readJson(file) {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readText(file, cap = 200_000) {
  try {
    const b = fs.readFileSync(file, 'utf8');
    return b.length > cap ? b.slice(0, cap) : b;
  } catch {
    return null;
  }
}

export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function firstExisting(paths) {
  return paths.find((p) => p && exists(p)) || null;
}

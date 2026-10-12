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
  return readTextBounded(file, cap)?.text ?? null;
}

export function readTextBounded(file, cap) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, cap);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return { text: buf.subarray(0, n).toString('utf8'), truncated: st.size > cap };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
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

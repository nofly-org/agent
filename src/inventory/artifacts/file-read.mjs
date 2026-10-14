import fs from 'node:fs';
import { parseJsonc } from '../../core/jsonc.mjs';
import { MAX_FILE_BYTES } from './limits.mjs';

const MAX_JSON_BYTES = 8 * 1024 * 1024;

export function readJsonAt(file) {
  const read = readText(file, MAX_JSON_BYTES);
  if (!read) return null;
  if (read.truncated) return undefined;
  try {
    return parseJsonc(read.text);
  } catch {
    return undefined;
  }
}

export function readText(file, cap = MAX_FILE_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    const data = buf.subarray(0, n);
    if (data.includes(0)) return null;
    return { text: data.toString('utf8'), truncated: st.size > cap, bytes: st.size };
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

export { stripJsonc as stripJsonComments } from '../../core/jsonc.mjs';

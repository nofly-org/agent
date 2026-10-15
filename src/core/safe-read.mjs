import fs from 'node:fs';

export const MAX_SAFE_READ = 16 * 1024 * 1024;

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0);

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

export function readRegularText(file, maxBytes = MAX_SAFE_READ) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse('ENOTREG', `${file} is not a regular file`);
    if (st.size > maxBytes) throw refuse('EFBIG', `${file} is larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readRegularHead(file, bytes) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    if (!fs.fstatSync(fd).isFile()) throw refuse('ENOTREG', `${file} is not a regular file`);
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

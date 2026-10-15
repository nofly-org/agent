import fs from 'node:fs';

export const MAX_SAFE_READ = 16 * 1024 * 1024;

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0);

const REASONS = {
  ENOENT: 'it does not exist',
  EISDIR: 'it is a folder',
  ENOTREG: 'it is not a regular file',
  EFBIG: 'it is too large',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ELOOP: 'it is a loop of links',
};

export const readFailure = (error) => REASONS[error?.code] ?? error?.code ?? String(error?.message ?? error);

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function notRegular(st, file) {
  return st.isDirectory() ? refuse('EISDIR', `${file} is a folder`) : refuse('ENOTREG', `${file} is not a regular file`);
}

export function readRegularBuffer(file, maxBytes = MAX_SAFE_READ) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw notRegular(st, file);
    if (st.size > maxBytes) throw refuse('EFBIG', `${file} is larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export function readRegularText(file, maxBytes = MAX_SAFE_READ) {
  return readRegularBuffer(file, maxBytes).toString('utf8');
}

export function readRegularHead(file, bytes) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw notRegular(st, file);
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

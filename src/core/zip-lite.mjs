import zlib from 'node:zlib';

const MAX_ENTRIES = 20000;

export function normalizeZipName(name) {
  let n = String(name ?? '').replace(/\\/g, '/');
  while (n.startsWith('./') || n.startsWith('/')) n = n.replace(/^\.?\//, '');
  return n.replace(/\/{2,}/g, '/');
}

export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < Math.min(count, MAX_ENTRIES) && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    let localName = null;
    if (local + 30 <= buf.length && buf.readUInt32LE(local) === 0x04034b50) {
      const lnlen = buf.readUInt16LE(local + 26);
      localName = buf.subarray(local + 30, local + 30 + lnlen).toString('utf8');
    }
    entries.push({
      name,
      path: normalizeZipName(name),
      localName,
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      local,
      directory: name.endsWith('/'),
    });
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

export function readZipText(buf, entry, { maxBytes = 1024 * 1024 } = {}) {
  if (!entry || entry.usize > maxBytes || entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== 0x04034b50) return null;
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const data = buf.subarray(start, start + entry.csize);
  try {
    if (entry.method === 0) return data.subarray(0, maxBytes).toString('utf8');
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes }).toString('utf8');
  } catch {
    return null;
  }
  return null;
}

export function readZipEntry(buf, wanted, { maxBytes = 1024 * 1024 } = {}) {
  const want = normalizeZipName(wanted).toLowerCase();
  const entry = (listZipEntries(buf) ?? []).find((e) => e.path.toLowerCase() === want);
  return entry ? readZipText(buf, entry, { maxBytes }) : null;
}

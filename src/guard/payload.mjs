import fs from 'node:fs';

export function parseHookPayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return null;
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

export function readHookPayload() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
  return parseHookPayload(raw);
}

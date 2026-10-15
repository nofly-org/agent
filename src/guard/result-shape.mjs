import { SECRET_PATTERNS } from '../detect/signals/secrets.mjs';

const MAX_LOCAL_TEXT = 512 * 1024;
const MAX_SENT_CHARS = 4 * 1024 * 1024;
const MAX_SENT_NODES = 50000;
const MAX_DEPTH = 24;
const MEDIA_MIME_RE = /^(?:image|audio|video)\//i;
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;
const TOKEN_RE = /^[\w.:/@+#=,-]{0,64}$/;
const SECOND_NOTICE = '[withheld by NoFly]';
const SECRET_SHAPES = SECRET_PATTERNS.map(({ re }) => new RegExp(re.source, re.flags.replace(/[gy]/g, '')));

function structuralToken(value) {
  if (!TOKEN_RE.test(value)) return false;
  if (value.length >= 16 && /\d/.test(value)) return false;
  return !SECRET_SHAPES.some((re) => re.test(value));
}

function windowText(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[nofly: ${text.length - half * 2} characters not read]\n${text.slice(text.length - half)}`;
}

function mediaPayload(parent, key, value) {
  if ((key !== 'data' && key !== 'blob') || !parent || value.length <= 1024) return false;
  const mime = String(parent.mimeType ?? parent.mime_type ?? parent.media_type ?? '');
  const media = MEDIA_MIME_RE.test(mime) || parent.type === 'image' || parent.type === 'audio';
  return media && BASE64_RE.test(value.slice(0, 4096).replace(/[\r\n]/g, ''));
}

export function resultText(response, max = MAX_LOCAL_TEXT) {
  if (typeof response === 'string') return windowText(response, max);
  const parts = [];
  let size = 0;
  const walk = (value, key, parent, depth) => {
    if (size > max * 2) return;
    if (typeof value === 'string') {
      if (mediaPayload(parent, key, value)) return;
      parts.push(value);
      size += value.length;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (depth > MAX_DEPTH) {
      let rest = '';
      try {
        rest = JSON.stringify(value) ?? '';
      } catch {
        rest = '[nofly: a nested part of this result could not be read]';
      }
      parts.push(rest);
      size += rest.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, parent, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, k, value, depth + 1);
  };
  walk(response, '', null, 0);
  return windowText(parts.join('\n'), max);
}

function nodeCount(value, limit) {
  let n = 0;
  const stack = [value];
  while (stack.length && n <= limit) {
    const v = stack.pop();
    n += 1;
    if (v && typeof v === 'object') for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
  }
  return n;
}

export function sendableResponse(response) {
  if (response == null) return response;
  if (typeof response === 'string') return windowText(response, MAX_SENT_CHARS);
  let size = Infinity;
  try {
    size = JSON.stringify(response)?.length ?? Infinity;
  } catch {
  }
  if (size <= MAX_SENT_CHARS && nodeCount(response, MAX_SENT_NODES) <= MAX_SENT_NODES) return response;
  return resultText(response, MAX_SENT_CHARS);
}

export function withheldOutput(response, notice) {
  if (response == null || typeof response !== 'object') return notice;
  let placed = false;
  const mark = () => {
    if (placed) return SECOND_NOTICE;
    placed = true;
    return notice;
  };
  const walk = (value, key, parent, depth) => {
    if (typeof value === 'string') {
      if (structuralToken(value) || mediaPayload(parent, key, value)) return value;
      return mark();
    }
    if (!value || typeof value !== 'object') return value;
    if (depth > MAX_DEPTH) return null;
    if (Array.isArray(value)) return value.map((item) => walk(item, key, parent, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, value, depth + 1)]));
  };
  return walk(response, '', null, 0);
}

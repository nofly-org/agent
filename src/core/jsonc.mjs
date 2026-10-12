function scanJson(raw, onChar) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += raw[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    const r = onChar(raw, i);
    if (r === undefined) out += c;
    else {
      out += r.emit;
      i = r.next;
    }
  }
  return out;
}

export function stripJsonc(raw) {
  const noComments = scanJson(String(raw).replace(/^﻿/, ''), (s, i) => {
    if (s[i] === '/' && s[i + 1] === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      return { emit: '\n', next: j };
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      return { emit: ' ', next: end === -1 ? s.length : end + 1 };
    }
    return undefined;
  });
  return scanJson(noComments, (s, i) => {
    if (s[i] !== ',') return undefined;
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    return s[j] === '}' || s[j] === ']' ? { emit: '', next: i } : undefined;
  });
}

export function parseJsonc(raw) {
  const text = String(raw ?? '');
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return JSON.parse(stripJsonc(text));
  }
}

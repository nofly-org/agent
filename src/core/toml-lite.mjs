const MAX_TOML_BYTES = 512 * 1024;
const MAX_DEPTH = 32;
const BARE_KEY = /[A-Za-z0-9_-]/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

class TomlError extends Error {}

export function parseToml(text) {
  if (typeof text !== 'string' || text.length > MAX_TOML_BYTES) return null;
  const s = text.replace(/^\uFEFF/, '');
  let i = 0;
  const root = {};
  let table = root;

  const fail = () => {
    throw new TomlError();
  };
  const skipSpace = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const skipComment = () => {
    if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
  };
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (s[i] === '\r' || s[i] === '\n') {
        i++;
        continue;
      }
      return;
    }
  };
  const toLineEnd = () => {
    while (i < s.length && s[i] !== '\n') i++;
  };

  const unescape = (raw) => raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[btnfre"\\]|\r?\n[\s]*)/g, (_, e) => {
    if (e[0] === 'u' || e[0] === 'U') {
      const code = parseInt(e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (e[0] === '\n' || e[0] === '\r') return '';
    return ESCAPES[e] ?? '';
  });

  function basicString() {
    if (s.startsWith('"""', i)) {
      i += 3;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      let j = i;
      for (;;) {
        const end = s.indexOf('"""', j);
        if (end === -1) fail();
        let slashes = 0;
        for (let k = end - 1; k >= i && s[k] === '\\'; k--) slashes++;
        if (slashes % 2 === 0) {
          let close = end + 3;
          while (s[close] === '"' && close - end < 5) close++;
          const raw = s.slice(i, close - 3);
          i = close;
          return unescape(raw);
        }
        j = end + 1;
      }
    }
    i++;
    const start = i;
    while (i < s.length && s[i] !== '"' && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
    if (s[i] !== '"') fail();
    const raw = s.slice(start, i);
    i++;
    return unescape(raw);
  }

  function literalString() {
    if (s.startsWith("'''", i)) {
      i += 3;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      const end = s.indexOf("'''", i);
      if (end === -1) fail();
      let close = end + 3;
      while (s[close] === "'" && close - end < 5) close++;
      const raw = s.slice(i, close - 3);
      i = close;
      return raw;
    }
    i++;
    const end = s.indexOf("'", i);
    const newline = s.indexOf('\n', i);
    if (end === -1 || (newline !== -1 && newline < end)) fail();
    const raw = s.slice(i, end);
    i = end + 1;
    return raw;
  }

  function key() {
    const parts = [];
    for (;;) {
      skipSpace();
      if (s[i] === '"') parts.push(basicString());
      else if (s[i] === "'") parts.push(literalString());
      else {
        const start = i;
        while (i < s.length && BARE_KEY.test(s[i])) i++;
        if (i === start) fail();
        parts.push(s.slice(start, i));
      }
      if (UNSAFE_KEYS.has(parts[parts.length - 1])) fail();
      skipSpace();
      if (s[i] !== '.') return parts;
      i++;
    }
  }

  function scalar() {
    const start = i;
    while (i < s.length && !/[,\]}#\r\n]/.test(s[i])) i++;
    const raw = s.slice(start, i).trim();
    if (!raw) fail();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const plain = raw.replace(/_/g, '');
    if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(plain)) return Number(plain);
    if (/^0x[0-9A-Fa-f]+$/.test(plain)) return parseInt(plain.slice(2), 16);
    if (/^0o[0-7]+$/.test(plain)) return parseInt(plain.slice(2), 8);
    if (/^0b[01]+$/.test(plain)) return parseInt(plain.slice(2), 2);
    if (/^[+-]?inf$/.test(plain)) return plain.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(plain)) return NaN;
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    fail();
    return undefined;
  }

  function value(depth) {
    if (depth > MAX_DEPTH) fail();
    const c = s[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const out = [];
      for (;;) {
        skipBlank();
        if (s[i] === ']') {
          i++;
          return out;
        }
        out.push(value(depth + 1));
        skipBlank();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return out;
        }
        fail();
      }
    }
    if (c === '{') {
      i++;
      const out = {};
      for (;;) {
        skipBlank();
        if (s[i] === '}') {
          i++;
          return out;
        }
        const parts = key();
        if (s[i] !== '=') fail();
        i++;
        skipSpace();
        assign(out, parts, value(depth + 1));
        skipBlank();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '}') {
          i++;
          return out;
        }
        fail();
      }
    }
    return scalar();
  }

  function assign(target, parts, v) {
    let node = target;
    for (const part of parts.slice(0, -1)) {
      if (!isObj(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = v;
  }

  function header() {
    const array = s[i + 1] === '[';
    i += array ? 2 : 1;
    const parts = key();
    if (s[i] !== ']' || (array && s[i + 1] !== ']')) fail();
    i += array ? 2 : 1;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(node[part])) node = node[part][node[part].length - 1] ?? node;
      else {
        if (!isObj(node[part])) node[part] = {};
        node = node[part];
      }
    }
    const last = parts[parts.length - 1];
    if (array) {
      if (!Array.isArray(node[last])) node[last] = [];
      const entry = {};
      node[last].push(entry);
      return entry;
    }
    if (!isObj(node[last])) node[last] = {};
    return node[last];
  }

  while (i < s.length) {
    skipBlank();
    if (i >= s.length) break;
    const statement = i;
    try {
      if (s[i] === '[') table = header();
      else {
        const parts = key();
        if (s[i] !== '=') fail();
        i++;
        skipSpace();
        assign(table, parts, value(0));
      }
      skipSpace();
      skipComment();
      if (i < s.length && s[i] !== '\n' && s[i] !== '\r') toLineEnd();
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
      i = statement;
      toLineEnd();
    }
  }
  return root;
}

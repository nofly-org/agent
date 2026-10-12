import { FLAG_SPEC_MAX, RGI_SUBDIVISION_FLAGS, flagSpecOf, isFlagSpecValue, isOrdinaryInvisible, isWellFormedFlagSpec } from './invisible-chars.mjs';

export const MAX_DECODED_RUNS = 64;
export const MAX_RUN_TEXT = 100_000;
export const FLAG_CHAIN_MIN = 3;

export const MIN_RUN_CARRIERS = {
  'unicode-tag': 4,
  'variation-selector': 4,
  'sneaky-bits': 32,
  'zero-width': 16,
};

const MIN_STREAM_SNEAKY_RUN = 8;
const MIN_ZERO_WIDTH_RUN = 8;
const MAX_ZERO_WIDTH_DECODE = 8192;
const ZERO_WIDTH_PROBE = 256;
const ZERO_WIDTH_READABLE = 0.9;

const CARRIER_PRESENT_RE = /[⁢⁤︀-️]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const ZERO_WIDTH_PRESENT_RE = /[᠎​-‏‪-‮⁠-⁤﻿]/;
const ZERO_WIDTH_SYMBOLS = new Set([
  0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
]);
const READABLE_RE = /[\t\n\r\x20-\x7E]|[\p{L}\p{M}\p{N}\p{P}\p{Zs}\p{S}]/u;
const WORDY_RE = /[\p{L}\p{N} .,'"!?:;()\-\n\t]/u;
const ZERO_WIDTH_TRIES = 3;

function kindOf(cp) {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'unicode-tag';
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 'variation-selector';
  if (cp === 0x2062 || cp === 0x2064) return 'sneaky-bits';
  return null;
}

function valueOf(kind, cp) {
  if (kind === 'unicode-tag') return cp - 0xe0000;
  if (kind === 'variation-selector') return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
  return cp === 0x2064 ? 1 : 0;
}

function flagRun(text, run) {
  if (run.kind !== 'unicode-tag' || run.values.length < 2 || run.values.length > FLAG_SPEC_MAX + 1) return false;
  if (run.values[run.values.length - 1] !== 0x7f) return false;
  for (let i = 0; i < run.values.length - 1; i++) if (!isFlagSpecValue(run.values[i])) return false;
  const before = run.start >= 2 ? text.codePointAt(run.start - 2) : -1;
  return before === 0x1f3f4;
}

const flagSpec = (run) => run.values.slice(0, -1);

function ordinaryRun(text, run, chained) {
  if (flagRun(text, run)) {
    const spec = flagSpec(run);
    if (!isWellFormedFlagSpec(spec)) return false;
    return !chained || RGI_SUBDIVISION_FLAGS.has(flagSpecOf(spec));
  }
  return run.values.length === 1 && run.kind === 'variation-selector' && isOrdinaryInvisible(text, run.start);
}

function scanCarriers(text) {
  const body = text.length > MAX_RUN_TEXT ? text.slice(0, MAX_RUN_TEXT) : text;
  if (!CARRIER_PRESENT_RE.test(body)) return [];
  const out = [];
  let open = null;
  let i = 0;
  while (i < body.length) {
    const cp = body.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    const kind = kindOf(cp);
    if (!kind) {
      open = null;
      i += width;
      continue;
    }
    if (!open || open.kind !== kind) {
      open = { kind, start: i, end: i, values: [] };
      out.push(open);
    }
    open.values.push(valueOf(kind, cp));
    open.end = i + width;
    if (kind === 'unicode-tag' && cp === 0xe007f && flagRun(body, open)) open = null;
    i += width;
  }
  return out;
}

function chainedFlags(text, scanned) {
  let n = 0;
  for (const r of scanned) {
    if (!flagRun(text, r)) continue;
    const spec = flagSpec(r);
    if (isWellFormedFlagSpec(spec) && !RGI_SUBDIVISION_FLAGS.has(flagSpecOf(spec))) n++;
  }
  return n;
}

function keepZeroWidth(run) {
  if (run.values.length < MIN_ZERO_WIDTH_RUN) return false;
  return run.values.some((v) => v !== 0x2062 && v !== 0x2064);
}

function scanZeroWidth(text) {
  const body = text.length > MAX_RUN_TEXT ? text.slice(0, MAX_RUN_TEXT) : text;
  if (!ZERO_WIDTH_PRESENT_RE.test(body)) return [];
  const out = [];
  let open = null;
  for (let i = 0; i < body.length; i++) {
    const cp = body.charCodeAt(i);
    if (!ZERO_WIDTH_SYMBOLS.has(cp)) {
      if (open && keepZeroWidth(open)) out.push(open);
      open = null;
      continue;
    }
    if (!open) open = { kind: 'zero-width', start: i, end: i, values: [] };
    open.values.push(cp);
    open.end = i + 1;
  }
  if (open && keepZeroWidth(open)) out.push(open);
  return out;
}

function sneakyBytes(bits) {
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  return bytes;
}

const byteWidth = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

function printableOf(decoded) {
  let text = '';
  let bytes = 0;
  for (const ch of decoded) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      text += ch;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || cp === 0xfffd || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    text += ch;
    bytes += byteWidth(cp);
  }
  return { text, bytes };
}

function utf8(bytes) {
  if (!bytes.length) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
}

function readability(s) {
  let total = 0;
  let readable = 0;
  for (const ch of s) {
    total++;
    if (ch !== '�' && READABLE_RE.test(ch)) readable++;
  }
  return total ? readable / total : 0;
}

function quality(s) {
  let total = 0;
  let wordy = 0;
  for (const ch of s) {
    total++;
    if (WORDY_RE.test(ch)) wordy++;
  }
  return total ? (readability(s) + wordy / total) / 2 : 0;
}

function packBits(bits, width) {
  const out = [];
  for (let i = 0; i + width <= bits.length; i += width) {
    let v = 0;
    for (let j = 0; j < width; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

function zeroWidthReadings(alphabet) {
  const readings = [];
  if (alphabet.length === 2) {
    for (const width of [8, 7]) {
      for (const one of alphabet) {
        readings.push((symbols) => {
          const values = packBits(symbols.map((s) => (s === one ? 1 : 0)), width);
          return width === 8 ? utf8(values) : String.fromCharCode(...values);
        });
      }
    }
  }
  if (alphabet.length === 3) {
    for (const sep of alphabet) {
      const pair = alphabet.filter((s) => s !== sep);
      for (const one of pair) {
        readings.push((symbols) => {
          let out = '';
          let group = 0;
          let width = 0;
          const flush = () => {
            if (width && width <= 21 && group >= 9 && group <= 0x10ffff) out += String.fromCodePoint(group);
            else if (width) out += '�';
            group = 0;
            width = 0;
          };
          for (const s of symbols) {
            if (s === sep) flush();
            else {
              group = group * 2 + (s === one ? 1 : 0);
              width++;
            }
          }
          flush();
          return out;
        });
      }
    }
  }
  if (alphabet.length === 4) {
    for (const order of permutations(alphabet)) {
      readings.push((symbols) => {
        const bits = [];
        for (const s of symbols) {
          const d = order.indexOf(s);
          if (d < 0) return '';
          bits.push(d >> 1, d & 1);
        }
        return utf8(packBits(bits, 8));
      });
    }
  }
  return readings;
}

export function decodeZeroWidthSymbols(values) {
  const symbols = values.slice(0, MAX_ZERO_WIDTH_DECODE);
  const alphabet = [...new Set(symbols)];
  if (alphabet.length < 2 || alphabet.length > 4) return { text: '', bytes: 0 };
  const ranked = [];
  for (const reading of zeroWidthReadings(alphabet)) {
    const probe = reading(symbols.slice(0, ZERO_WIDTH_PROBE));
    if (probe && readability(probe) >= ZERO_WIDTH_READABLE) ranked.push({ reading, score: quality(probe) });
  }
  ranked.sort((a, b) => b.score - a.score);
  for (const { reading } of ranked.slice(0, ZERO_WIDTH_TRIES)) {
    const full = reading(symbols);
    if (readability(full) >= ZERO_WIDTH_READABLE && new Set(full).size >= 3) return printableOf(full);
  }
  return { text: '', bytes: 0 };
}

function decodeValues(kind, values) {
  if (kind === 'zero-width') return decodeZeroWidthSymbols(values);
  if (kind === 'unicode-tag') {
    let text = '';
    let bytes = 0;
    for (const v of values) {
      if (v >= 0x20 && v <= 0x7e) {
        text += String.fromCharCode(v);
        bytes++;
      } else if (v === 0x09 || v === 0x0a || v === 0x0d) text += String.fromCharCode(v);
    }
    return { text, bytes };
  }
  const bytes = kind === 'sneaky-bits' ? sneakyBytes(values) : values;
  if (!bytes.length) return { text: '', bytes: 0 };
  return printableOf(utf8(bytes));
}

function toRun(kind, start, end, values, carriers, combined) {
  const { text, bytes } = decodeValues(kind, values);
  return { kind, start, end, carriers, decoded: text, printableBytes: bytes, combined };
}

const streamable = (run) => run.kind !== 'sneaky-bits' || run.values.length >= MIN_STREAM_SNEAKY_RUN;

function carrierRuns(text) {
  const scanned = scanCarriers(text);
  const flagChain = chainedFlags(text, scanned);
  const chained = flagChain >= FLAG_CHAIN_MIN;
  const raw = scanned.filter((r) => !ordinaryRun(text, r, chained));
  return { raw: [...raw, ...scanZeroWidth(text)], flagChain: chained ? flagChain : 0 };
}

export function invisibleRuns(text) {
  const { raw, flagChain } = carrierRuns(text ?? '');
  const runs = [];
  let skipped = 0;
  const perKind = new Map();
  for (const r of raw) {
    if (streamable(r)) {
      const k = perKind.get(r.kind) ?? { runs: 0, skipped: false, values: [], start: r.start, end: r.end, carriers: 0 };
      k.runs++;
      for (const v of r.values) k.values.push(v);
      k.end = r.end;
      k.carriers += r.values.length;
      perKind.set(r.kind, k);
    }
    if (r.values.length < MIN_RUN_CARRIERS[r.kind]) continue;
    if (runs.length >= MAX_DECODED_RUNS) {
      skipped++;
      const k = perKind.get(r.kind);
      if (k) k.skipped = true;
      continue;
    }
    runs.push(toRun(r.kind, r.start, r.end, r.values, r.values.length, false));
  }
  const streams = [];
  for (const [kind, k] of perKind) {
    if (k.runs < 2 && !k.skipped) continue;
    if (k.carriers < MIN_RUN_CARRIERS[kind]) continue;
    streams.push(toRun(kind, k.start, k.end, k.values, k.carriers, true));
  }
  return { runs, streams, skipped, flagChain };
}

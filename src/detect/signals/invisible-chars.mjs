export const INVISIBLE_CHARS_RE =
  /[؜ᅟᅠ᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

export const INVISIBLE_CHARS_GLOBAL_RE = new RegExp(INVISIBLE_CHARS_RE.source, 'gu');

const RIGHT_TO_LEFT = [[0x0590, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefe], [0x10800, 0x10fff], [0x1e800, 0x1efff]];

const JOINING_OR_INDIC = [
  [0x0600, 0x08ff], [0x0900, 0x0dff], [0x0f00, 0x109f], [0x1780, 0x18af], [0xa800, 0xa8ff], [0xa9e0, 0xa9ff],
  [0xaa60, 0xaa7f], [0xfb50, 0xfdff], [0xfe70, 0xfefe], [0x10ac0, 0x10aff], [0x10b80, 0x10baf], [0x10d00, 0x10d3f],
  [0x10f30, 0x10f6f], [0x11000, 0x11dff], [0x1e900, 0x1e95f],
];

const UNSPACED_SCRIPTS = [
  [0x0e00, 0x0eff], [0x1000, 0x109f], [0x1100, 0x11ff], [0x1780, 0x17ff], [0x19e0, 0x19ff], [0x2e80, 0x2fdf],
  [0x3000, 0x9fff], [0xa000, 0xa4cf], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f], [0xac00, 0xd7af], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0x1b000, 0x1b16f], [0x20000, 0x3ffff],
];

const IDEOGRAPHS = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x3ffff]];

const MONGOLIAN_LETTERS = [[0x1820, 0x1878], [0x1880, 0x18aa]];

const VIRAMAS = new Set([0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d, 0x0dca, 0x1039, 0x103a, 0x17d2]);

const EMOJI_BASE_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;
const SYMBOL_BASE_RE = /[\p{Extended_Pictographic}\p{Emoji}\p{So}\p{Sm}\p{Sk}]/u;

const BOM_OPENERS = new Set([0x0a, 0x0d, 0x09, 0x22, 0x27, 0x60, 0x2192]);

const RTL_REACH = 3;
export const FLAG_SPEC_MAX = 7;

export function isFlagSpecValue(v) {
  return (v >= 0x30 && v <= 0x39) || (v >= 0x61 && v <= 0x7a);
}

const FLAG_SPEC_RE = /^[a-z]{2}[a-z0-9]{1,4}$/;

export const RGI_SUBDIVISION_FLAGS = new Set(['gbeng', 'gbsct', 'gbwls']);

export function flagSpecOf(values) {
  return String.fromCharCode(...values.filter(isFlagSpecValue));
}

export function isWellFormedFlagSpec(values) {
  return values.every(isFlagSpecValue) && FLAG_SPEC_RE.test(flagSpecOf(values));
}

function within(cp, ranges) {
  if (cp < 0) return false;
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function cpAt(text, i) {
  return i >= 0 && i < text.length ? text.codePointAt(i) : -1;
}

function startBefore(text, i) {
  if (i <= 0) return -1;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return i - 2;
  }
  return i - 1;
}

export function codePointBefore(text, i) {
  const at = startBefore(text, i);
  return at < 0 ? -1 : text.codePointAt(at);
}

const widthOf = (cp) => (cp > 0xffff ? 2 : 1);

export function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

export function isTagCharacter(cp) {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

function isEmojiBase(cp) {
  return cp === 0xfe0f || (cp > 0 && EMOJI_BASE_RE.test(String.fromCodePoint(cp)));
}

function isSymbolBase(cp) {
  return cp > 0 && !isVariationSelector(cp) && SYMBOL_BASE_RE.test(String.fromCodePoint(cp));
}

function rightToLeftNear(text, at, width) {
  let back = at;
  for (let n = 0; n < RTL_REACH; n++) {
    back = startBefore(text, back);
    if (back < 0) break;
    if (within(text.codePointAt(back), RIGHT_TO_LEFT)) return true;
  }
  let ahead = at + width;
  for (let n = 0; n < RTL_REACH && ahead < text.length; n++) {
    const cp = text.codePointAt(ahead);
    if (within(cp, RIGHT_TO_LEFT)) return true;
    ahead += widthOf(cp);
  }
  return false;
}

export function flagTagSequenceAt(text, at) {
  let start = at;
  for (let n = 0; ; n++) {
    const before = startBefore(text, start);
    if (before < 0 || n > FLAG_SPEC_MAX) return false;
    const cp = text.codePointAt(before);
    if (cp === 0x1f3f4) break;
    if (!isFlagSpecValue(cp - 0xe0000)) return false;
    start = before;
  }
  for (let end = at; (end - start) / 2 <= FLAG_SPEC_MAX; end += 2) {
    const cp = cpAt(text, end);
    if (cp === 0xe007f) {
      const spec = [];
      for (let i = start; i < end; i += 2) spec.push(cpAt(text, i) - 0xe0000);
      return isWellFormedFlagSpec(spec);
    }
    if (!isFlagSpecValue(cp - 0xe0000)) return false;
  }
  return false;
}

export function isOrdinaryInvisible(text, at) {
  const cp = cpAt(text, at);
  if (cp < 0) return false;
  const width = widthOf(cp);
  const prev = codePointBefore(text, at);
  const next = cpAt(text, at + width);

  if (cp === 0x200c || cp === 0x200d) {
    if (within(prev, JOINING_OR_INDIC) && (within(next, JOINING_OR_INDIC) || VIRAMAS.has(prev))) return true;
    return cp === 0x200d && isEmojiBase(prev) && next > 0 && EMOJI_BASE_RE.test(String.fromCodePoint(next));
  }
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return rightToLeftNear(text, at, width);
  if (cp === 0xfeff) return at === 0 || BOM_OPENERS.has(prev);
  if (cp === 0x200b) return within(prev, UNSPACED_SCRIPTS) || within(next, UNSPACED_SCRIPTS);
  if (cp >= 0xfe00 && cp <= 0xfe0f) return !isVariationSelector(next) && (isSymbolBase(prev) || within(prev, IDEOGRAPHS));
  if (cp >= 0xe0100 && cp <= 0xe01ef) return !isVariationSelector(next) && within(prev, IDEOGRAPHS);
  if ((cp >= 0x180b && cp <= 0x180d) || cp === 0x180f) return within(prev, MONGOLIAN_LETTERS) && !(next >= 0x180b && next <= 0x180f);
  if (cp === 0x180e) return within(prev, MONGOLIAN_LETTERS) && within(next, MONGOLIAN_LETTERS);
  if (cp >= 0xe0020 && cp <= 0xe007f) return flagTagSequenceAt(text, at);
  return false;
}

export function suspiciousInvisible(text) {
  if (!text) return null;
  for (const m of text.matchAll(INVISIBLE_CHARS_GLOBAL_RE)) {
    const at = m.index ?? 0;
    if (!isOrdinaryInvisible(text, at)) return { index: at, codePoint: m[0].codePointAt(0) };
  }
  return null;
}

export function codePointLabel(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { grade } from '../detect/guard-signals.mjs';
import { readRegularText } from '../core/safe-read.mjs';

const IGNORE_MARK = /(?:\/\/|#|<!--|;)\s*shomra-ignore(-file|-next-line)?\b[:\s]?(.*)$/i;

export function globToRe(glob) {
  const esc = String(glob).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

export function loadIgnoreRules(root) {
  let raw = '';
  try { raw = readRegularText(path.join(root, '.shomraignore'), 1024 * 1024); } catch {  }
  return parseIgnoreRules(raw);
}

export function parseIgnoreRules(raw) {
  const fileGlobs = [], findingRules = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sep = t.indexOf('::');
    if (sep !== -1) findingRules.push({ re: globToRe(t.slice(0, sep).trim()), titleSub: t.slice(sep + 2).trim().toLowerCase() });
    else fileGlobs.push(globToRe(t));
  }
  return { fileGlobs, findingRules };
}

export function loadBaseline(root) {
  try { return parseBaseline(readRegularText(path.join(root, '.shomra', 'baseline.json'))); } catch { return null; }
}

export function parseBaseline(raw) {
  if (typeof raw !== 'string') return null;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.fingerprints)) return null;
  const counts = doc.counts && typeof doc.counts === 'object' && !Array.isArray(doc.counts) ? doc.counts : null;
  const allowance = new Map();
  for (const fp of doc.fingerprints) {
    if (typeof fp !== 'string') continue;
    const n = counts ? Number(counts[fp]) : Infinity;
    allowance.set(fp, Number.isFinite(n) && n > 0 ? Math.floor(n) : counts ? 1 : Infinity);
  }
  if (doc.lines && typeof doc.lines === 'object' && !Array.isArray(doc.lines)) {
    allowance.lines = new Map();
    for (const [fp, digests] of Object.entries(doc.lines)) {
      if (!digests || typeof digests !== 'object' || Array.isArray(digests)) continue;
      const byDigest = new Map();
      for (const [digest, n] of Object.entries(digests)) if (Number.isFinite(Number(n)) && Number(n) > 0) byDigest.set(digest, Math.floor(Number(n)));
      allowance.lines.set(fp, byDigest);
    }
  }
  return allowance;
}

export function lineDigest(text) {
  return crypto.createHash('sha1').update(String(text ?? '').trim()).digest('hex').slice(0, 16);
}

export function findingFingerprint(relPath, f) {
  return crypto.createHash('sha1').update(`${relPath}::${f.ruleId || f.title}`).digest('hex').slice(0, 16);
}

const MAX_SUPPRESSION_BYTES = 2 * 1024 * 1024;

function readLinesBounded(fullPath) {
  let fd;
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, MAX_SUPPRESSION_BYTES);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n).toString('utf8').split(/\r?\n/);
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

const FILE_MARK = /\bshomra-ignore-file\b/i;
const FILE_MARK_LINES = 5;

const linesMark = (text) => {
  const m = IGNORE_MARK.exec(text ?? '');
  return m && m[1]?.toLowerCase() !== '-file' ? m : null;
};

export const NO_MARKS = Object.freeze({ fileMark: false, same: new Map(), next: new Map() });

export function marksIn(text) {
  if (typeof text !== 'string') return NO_MARKS;
  const lines = text.split(/\r?\n/);
  const same = new Map();
  const next = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (let i = 0; i < lines.length; i++) {
    if (!linesMark(lines[i])) continue;
    bump(same, lines[i].trim());
    if (i + 1 < lines.length) bump(next, `${lines[i].trim()}\n${lines[i + 1].trim()}`);
  }
  return { fileMark: lines.slice(0, FILE_MARK_LINES).some((line) => FILE_MARK.test(line)), same, next };
}

function markLedger(trust) {
  const used = new Map();
  const granted = new Set();
  return (kind, at, key) => {
    if (kind === 'file') return !!trust.fileMark;
    const slot = `${kind}:${at}`;
    if (granted.has(slot)) return true;
    const pool = kind === 'same' ? trust.same : trust.next;
    const tag = `${kind}:${key}`;
    const taken = used.get(tag) ?? 0;
    if (taken >= (pool?.get(key) ?? 0)) return false;
    used.set(tag, taken + 1);
    granted.add(slot);
    return true;
  };
}

function inlineSuppressed(fullPath, line, cache, ledger) {
  if (!fullPath) return null;
  const lines = linesOf(fullPath, cache);
  if (!lines) return null;
  let refused = false;
  const honour = (kind, at, key) => {
    if (!ledger || ledger(kind, at, key)) return true;
    refused = true;
    return false;
  };

  for (let i = 0; i < Math.min(FILE_MARK_LINES, lines.length); i++) {
    if (FILE_MARK.test(lines[i]) && honour('file')) return 'inline';
  }
  if (line) {
    const here = lines[line - 1] ?? '';
    if (linesMark(here) && honour('same', line, here.trim())) return 'inline-line';
    const above = line >= 2 ? lines[line - 2] ?? '' : '';
    if (linesMark(above) && honour('next', line, `${above.trim()}\n${here.trim()}`)) return 'inline-line';
  }
  return refused ? 'refused' : null;
}

export const REFUSED_MARK_NOTE = 'a shomra-ignore mark added by this change applies only once it is merged';

function findingSource(r, f) {
  if (!f.file || f.file === r.path) return r.full ? path.resolve(r.full) : null;
  if (String(f.file).includes('!/')) return null;
  return path.resolve(String(f.file));
}

function linesOf(source, cache) {
  let lines = cache.get(source);
  if (lines === undefined) {
    lines = readLinesBounded(source);
    cache.set(source, lines);
  }
  return lines;
}

function lineOf(r, f, cache) {
  if (!f.line || r.notAnalyzed || f.notAnalyzed) return null;
  const source = findingSource(r, f);
  const text = source ? linesOf(source, cache)?.[f.line - 1] : undefined;
  return typeof text === 'string' && text.trim() ? text : null;
}

function baselineReason(r, f, baseline, cache, used) {
  const fp = findingFingerprint(r.path, f);
  const byLine = baseline.lines?.get(fp);
  const text = byLine ? lineOf(r, f, cache) : null;
  if (text !== null) {
    const digest = lineDigest(text);
    const key = `${fp}\u0001${digest}`;
    const taken = used.get(key) ?? 0;
    if (taken >= (byLine.get(digest) ?? 0)) return null;
    used.set(key, taken + 1);
    return 'baseline-line';
  }
  const taken = used.get(fp) ?? 0;
  const allowed = baseline instanceof Map ? baseline.get(fp) ?? 0 : baseline.has(fp) ? Infinity : 0;
  if (taken >= allowed) return null;
  used.set(fp, taken + 1);
  return 'baseline';
}

function suppressionReason(r, f, rules, baseline, cache, ledgerFor, used) {
  if (rules.fileGlobs.some((re) => re.test(r.path))) return 'ignored (.shomraignore)';
  const title = String(f.title || '').toLowerCase();
  if (rules.findingRules.some((rule) => rule.re.test(r.path) && title.includes(rule.titleSub))) return 'ignored (.shomraignore)';
  if (baseline) {
    const reason = baselineReason(r, f, baseline, cache, used);
    if (reason) return reason;
  }
  if (r.notAnalyzed || f.notAnalyzed) return null;
  const source = findingSource(r, f);
  return source ? inlineSuppressed(source, f.line, cache, ledgerFor(source)) : null;
}

export const ORG_BLOCK_NOTE = 'ignored locally, still blocked by org policy';
export const MARK_REACH_NOTE = 'a shomra-ignore mark covers only the line it governs, and this appears on another line';
export const BASELINE_REACH_NOTE = 'the baseline accepted this on other lines, not on this one - run shomra baseline again to accept it';
const MAX_RECHECK_ROUNDS = 16;
const LINE_REASONS = { 'inline-line': 'inline', 'baseline-line': 'baseline' };
const publicReason = (reason) => LINE_REASONS[reason] ?? reason;

function revealHidden(source, covered, cache, recheck, classify, refusedNote, reachNote) {
  const out = { suppressed: [], kept: [] };
  const lines = cache.get(source);
  if (!Array.isArray(lines)) return out;
  const key = (f) => `${f.title}\u0001${f.line ?? ''}`;
  let before;
  try {
    before = recheck(source, lines.join('\n'));
  } catch {
    return out;
  }
  if (!Array.isArray(before)) return out;
  const known = new Set(before.map(key));
  for (let round = 0; round < MAX_RECHECK_ROUNDS; round++) {
    let after;
    try {
      after = recheck(source, lines.map((text, i) => (covered.has(i + 1) ? '' : text)).join('\n'));
    } catch {
      break;
    }
    if (!Array.isArray(after)) break;
    let grew = false;
    for (const f of after) {
      const k = key(f);
      if (known.has(k)) continue;
      known.add(k);
      const reason = classify(f);
      if (LINE_REASONS[reason] && f.line && !covered.has(f.line)) {
        covered.add(f.line);
        grew = true;
      }
      if (reason && reason !== 'refused') out.suppressed.push({ ...f, suppressedBy: publicReason(reason) });
      else out.kept.push({ ...f, suppressionRefused: reason === 'refused' ? refusedNote : reachNote });
    }
    if (!grew) break;
  }
  return out;
}

export function acceptedLines(r, cache, recheck) {
  const out = {};
  const covered = new Map();
  const add = (f) => {
    const text = lineOf(r, f, cache);
    if (text === null) return false;
    const fp = findingFingerprint(r.path, f);
    const digest = lineDigest(text);
    out[fp] ??= {};
    out[fp][digest] = (out[fp][digest] ?? 0) + 1;
    return true;
  };
  for (const f of r.findings || []) {
    if (!add(f)) continue;
    const source = findingSource(r, f);
    if (!covered.has(source)) covered.set(source, new Set());
    covered.get(source).add(f.line);
  }
  if (recheck) {
    for (const [source, lines] of covered) {
      for (const f of revealHidden(source, lines, cache, recheck, () => 'baseline-line', '', '').suppressed) add(f);
    }
  }
  return out;
}

export function suppressResult(r, rules, baseline, cache, trustedMarks, markNote = REFUSED_MARK_NOTE, { recheck } = {}) {
  const kept = [], suppressed = [];
  const ledgers = new Map();
  const ledgerFor = (source) => {
    if (!trustedMarks) return null;
    if (!ledgers.has(source)) ledgers.set(source, markLedger(trustedMarks(source) ?? NO_MARKS));
    return ledgers.get(source);
  };
  const used = new Map();
  const covered = new Map();
  let refused = 0;
  for (const f of r.findings || []) {
    const reason = suppressionReason(r, f, rules, baseline, cache, ledgerFor, used);
    if (reason === 'refused') {
      refused += 1;
      kept.push({ ...f, suppressionRefused: markNote });
      continue;
    }
    if (LINE_REASONS[reason]) {
      const source = findingSource(r, f);
      if (!covered.has(source)) covered.set(source, { lines: new Set(), by: new Set() });
      covered.get(source).lines.add(f.line);
      covered.get(source).by.add(reason);
    }
    (reason ? suppressed : kept).push(reason ? { ...f, suppressedBy: publicReason(reason) } : f);
  }
  if (recheck) {
    const present = new Set(kept.map((f) => `${f.title}\u0001${f.line ?? ''}`));
    for (const [source, { lines, by }] of covered) {
      const classify = (f) => suppressionReason(r, f, rules, baseline, cache, ledgerFor, used);
      const reachNote = by.has('inline-line') ? MARK_REACH_NOTE : BASELINE_REACH_NOTE;
      const found = revealHidden(source, lines, cache, (at, text) => recheck(at, text), classify, markNote, reachNote);
      suppressed.push(...found.suppressed);
      for (const f of found.kept) {
        const k = `${f.title}\u0001${f.line ?? ''}`;
        if (present.has(k)) continue;
        present.add(k);
        if (f.suppressionRefused === markNote) refused += 1;
        kept.push(f);
      }
    }
  }
  if (!suppressed.length) return refused ? { ...r, findings: kept } : r;
  const g = grade(kept);
  const held = r.orgDecision === 'BLOCK' && g.verdict !== 'BLOCK';
  return { ...r, findings: kept, decision: held ? 'BLOCK' : g.verdict, riskScore: g.riskScore, findingCount: kept.length, suppressedFindings: suppressed, suppressedCount: suppressed.length, ...(held ? { suppressionNote: ORG_BLOCK_NOTE } : {}) };
}

import { egressHost } from './egress.mjs';
import { INVISIBLE_CHARS_GLOBAL_RE, INVISIBLE_CHARS_RE, isOrdinaryInvisible, suspiciousInvisible } from './invisible-chars.mjs';
import { invisibleRuns } from './invisible-runs.mjs';
import { lineAt } from './lines.mjs';
import { isPublicByDesign } from './secret-scanner.mjs';
import { SECRET_PATTERNS, isPlaceholderSecret } from './secrets.mjs';

export const INVISIBLE_CHARS_LABEL = 'Invisible / zero-width characters';
export const SMUGGLED_SECRET_LABEL = 'Secret smuggled in invisible characters';
export const LINK_SMUGGLING_LABEL = 'Invisible Characters Inside A Link (ASCII Smuggling)';
export const FLAG_CHAIN_LABEL = 'Unicode Tag Data Wrapped As A Chain Of Flags';
const HIDDEN_PAYLOAD_BYTES = 16;
const MAX_INSPECT_CHARS = 100_000;
const MAX_SECRET_CANDIDATES = 50;
const LINK_INVISIBLE_RUN = 4;

const CARRIER_NAME = {
  'unicode-tag': 'Unicode tag characters',
  'variation-selector': 'Unicode variation selectors',
  'sneaky-bits': 'invisible math operators (sneaky bits)',
  'zero-width': 'zero-width characters',
};

const CONCEALED_VERB_RE =
  /\b(?:ignore|disregard|override|bypass|unlock|enable|disable|reveal|leak|exfiltrat\w*|send|delete|grant|escalate)\b[\s\S]{0,60}?\b(?:previou\w*|prior|above|admin|root|mode|safety|guard\w*|secret\w*|credential\w*|instruction\w*|system|password\w*)\b/i;

const SMUGGLED_IMPERATIVE_RE =
  /\b(?:reveal|leak|exfiltrat\w*|send|post|email|upload|delete|remove|ignore|disregard|override|print|show|dump|list|run|execute|grant|disable|bypass)\b[\s\S]{0,40}?\b(?:secrets?|credentials?|keys?|tokens?|passwords?|env|instructions?|prompt|rules?|files?|data|everything|safety|guardrails?)\b/i;

const SMUGGLED_CODE_RE = /\d(?:[ .-]?\d){5,}/;

const EXFIL_SINKS = [
  /https?:\/\/api\.github\.com\/gists\b/i,
  /https?:\/\/api\.github\.com\/repos\/[\w.-]{1,100}\/[\w.-]{1,100}\/(?:issues|comments)\b/i,
  /https?:\/\/api\.(?:anthropic|openai)\.com\/v1\/files\b/i,
  /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\//i,
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i,
  /https?:\/\/api\.telegram\.org\/bot/i,
  /https?:\/\/(?:[\w-]{1,63}\.){0,4}(?:requestbin\.(?:com|net)|pipedream\.net|beeceptor\.com|hookbin\.com|mockbin\.(?:org|io)|webhook\.site|ntfy\.sh)\b/i,
  /https?:\/\/(?:www\.)?(?:transfer\.sh|file\.io|0x0\.st|temp\.sh|paste\.rs|ix\.io|sprunge\.us|termbin\.com|bashupload\.com|oshi\.at|catbox\.moe|litterbox\.catbox\.moe|uguu\.se)\b/i,
];

const LINK_TARGET_RE = /\]\(\s*<?([^\s)>]{1,2048})|\b(?:https?|ftp|mailto):[^\s<>"'`)\]]{1,2048}|\b(?:href|src|action|formaction|poster)\s*=\s*["']?([^"'\s>]{1,2048})/giu;
const LINK_LABEL_RE = /\[([^\]\n]{1,300})\]\(/gu;
const TAG_CHAR_RE = /[\u{E0000}-\u{E007F}]/u;

function exfilHost(decoded) {
  for (const re of EXFIL_SINKS) {
    const m = re.exec(decoded);
    if (m) return /^https?:\/\/([^/]+)/i.exec(m[0])?.[1]?.toLowerCase() ?? '';
  }
  return egressHost(decoded);
}

function hiddenInLink(text, from, span, tagsOnly) {
  let hidden = 0;
  for (const m of span.matchAll(INVISIBLE_CHARS_GLOBAL_RE)) {
    const at = from + (m.index ?? 0);
    if (isOrdinaryInvisible(text, at)) continue;
    if (TAG_CHAR_RE.test(m[0])) return LINK_INVISIBLE_RUN;
    if (!tagsOnly) hidden++;
  }
  return hidden;
}

function invisibleInLink(text) {
  for (const m of text.matchAll(LINK_TARGET_RE)) {
    const target = m[1] ?? m[2] ?? m[0];
    const from = (m.index ?? 0) + m[0].indexOf(target);
    if (hiddenInLink(text, from, target, false) >= LINK_INVISIBLE_RUN) return from;
  }
  for (const m of text.matchAll(LINK_LABEL_RE)) {
    const from = (m.index ?? 0) + 1;
    if (hiddenInLink(text, from, m[1], true) >= LINK_INVISIBLE_RUN) return from;
  }
  return -1;
}

const at = (text, index) => (typeof index === 'number' && index >= 0 ? { line: lineAt(text, index) } : {});

export function invisibleInjectionFindings(input) {
  const raw = String(input ?? '');
  if (!INVISIBLE_CHARS_RE.test(raw) && !/[⁢⁤]/.test(raw)) return [];
  const text = raw.length > MAX_INSPECT_CHARS ? raw.slice(0, MAX_INSPECT_CHARS) : raw;
  const out = [];
  const seen = new Set();
  const push = (severity, label, index) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, severity, category: 'injection', ...at(text, index) });
  };
  const reading = invisibleRuns(text);
  for (const run of [...reading.runs, ...reading.streams]) {
    const decoded = run.decoded.trim();
    if (!decoded) continue;
    const name = CARRIER_NAME[run.kind];
    const where = run.combined ? undefined : run.start;
    if (decoded.length >= 4 && (SMUGGLED_IMPERATIVE_RE.test(decoded) || CONCEALED_VERB_RE.test(decoded))) push('HIGH', `Instruction smuggled in ${name}`, where);
    else if (run.printableBytes >= HIDDEN_PAYLOAD_BYTES || SMUGGLED_CODE_RE.test(decoded)) push('HIGH', `Hidden payload in ${name}`, where);
    if (exfilHost(decoded)) push('HIGH', 'Exfiltration URL smuggled in invisible characters', where);
  }
  if (reading.flagChain) push('MEDIUM', FLAG_CHAIN_LABEL);
  if (reading.skipped) push('MEDIUM', 'Invisible-character runs past the decode cap');
  const link = invisibleInLink(text);
  if (link >= 0) push('HIGH', LINK_SMUGGLING_LABEL, link);
  const bare = suspiciousInvisible(text);
  if (bare) push('MEDIUM', INVISIBLE_CHARS_LABEL, bare.index);
  return out;
}

export function invisibleSecretFindings(input) {
  const raw = String(input ?? '');
  if (!INVISIBLE_CHARS_RE.test(raw) && !/[⁢⁤]/.test(raw)) return [];
  const text = raw.length > MAX_INSPECT_CHARS ? raw.slice(0, MAX_INSPECT_CHARS) : raw;
  const reading = invisibleRuns(text);
  const out = [];
  const reported = [];
  const named = new Set();
  for (const run of [...reading.runs, ...reading.streams]) {
    if (run.decoded.length < 8) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (named.has(name)) continue;
      const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let taken = 0;
      for (const m of run.decoded.matchAll(all)) {
        if (++taken > MAX_SECRET_CANDIDATES) break;
        if (!/private key/i.test(name) && isPlaceholderSecret(m[0])) continue;
        if (isPublicByDesign(name, m[0])) continue;
        if (reported.some((v) => v.includes(m[0]) || m[0].includes(v))) continue;
        reported.push(m[0]);
        named.add(name);
        out.push({ label: `${SMUGGLED_SECRET_LABEL} (${name})`, severity: 'CRITICAL', category: 'secret', ...at(text, run.combined ? undefined : run.start) });
        break;
      }
    }
  }
  return out;
}

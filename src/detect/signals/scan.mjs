import { RISKY_CONFIG_MARKERS, riskyConfigHit } from './config-markers.mjs';
import { detectCredentialHarvest } from './credential-harvest.mjs';
import { egressHost } from './egress.mjs';
import { detectExecutionHijack } from './execution-hijack.mjs';
import { DESCRIBED_VERB_PHRASES, INJECTION_PHRASES, INJECTION_REGEXES, bulkDeleteIsRoutine, describedVerb, disguisedWords, precededByNegation, describesRatherThanInstructs } from './injection.mjs';
import { INVISIBLE_CHARS_GLOBAL_RE, suspiciousInvisible } from './invisible-chars.mjs';
import { invisibleInjectionFindings, invisibleSecretFindings } from './invisible-smuggling.mjs';
import { lineAt, locate } from './lines.mjs';
import { codeMask, deobfuscate } from './masking.mjs';
import { PII_PATTERNS, RESERVED_IPV4, SECRET_PATTERNS, VERSION_CONTEXT, isPlaceholderSecret, luhnValid } from './secrets.mjs';
import { SEV_RANK } from './severity.mjs';
import { DANGEROUS_SHELL, matchesShellSignal, proseSignals } from './shell.mjs';
import { scanStagedFetchExec } from './staged-fetch.mjs';

function injectionHits(t, mask) {
  const out = [];
  const where = (needle) => (mask ? locate(t, needle, mask) : {});
  const low = t.toLowerCase();
  for (const p of INJECTION_PHRASES) {
    let at = low.indexOf(p);
    if (DESCRIBED_VERB_PHRASES.has(p)) while (at >= 0 && describedVerb(t, at, p)) at = low.indexOf(p, at + 1);
    if (at < 0) continue;
    if (precededByNegation(t.slice(Math.max(0, at - 60), at))) continue;
    out.push({ label: `Injected instruction: "${p}"`, severity: 'HIGH', category: 'injection', ...where(p) });
    break;
  }
  for (const { label, re, moodGuarded } of INJECTION_REGEXES) {
    const m = t.match(re);
    if (!m) continue;
    const at = m.index ?? 0;
    if (precededByNegation(t.slice(Math.max(0, at - 60), at))) continue;
    if (label === 'Bulk destructive command' && bulkDeleteIsRoutine(t, at, m[0])) continue;
    if (moodGuarded && describesRatherThanInstructs(t, at)) continue;
    out.push({ label, severity: 'HIGH', category: 'injection', ...where(re) });
  }
  return out;
}

export const MAX_SCREEN_CHARS = 1024 * 1024;
export const UNREAD_LABEL = 'Too large or unusual to screen whole on this machine';

const unreadFinding = () => ({ label: UNREAD_LABEL, severity: 'HIGH', category: 'coverage' });

export function boundedLocalScan(text, opts = {}) {
  const t = String(text ?? '');
  const cut = t.length > MAX_SCREEN_CHARS;
  const half = MAX_SCREEN_CHARS / 2;
  let scan;
  try {
    scan = localScan(cut ? `${t.slice(0, half)}\n${t.slice(-half)}` : t, opts);
  } catch {
    return { verdict: 'FLAG', top: unreadFinding(), findings: [unreadFinding()], unread: 'failed' };
  }
  if (!cut) return scan;
  const findings = [...scan.findings, unreadFinding()];
  return { ...scan, verdict: scan.verdict === 'BLOCK' ? 'BLOCK' : 'FLAG', top: scan.verdict === 'BLOCK' ? scan.top : unreadFinding(), findings, unread: 'cut' };
}

export function localScan(text, opts = {}) {
  const findings = [];
  const t = text || '';
  const cats = opts.categories ?? ['shell', 'injection', 'secret', 'config', 'egress'];
  const mask = codeMask(t);

  if (cats.includes('shell')) {
    const aug = deobfuscate(t);
    if (aug.decodedPayload) findings.push({ label: 'Encoded shell / RCE payload (base64, hex, percent or char-code)', severity: 'CRITICAL', category: 'shell' });
    for (const sig of opts.prose ? proseSignals(aug.text) : DANGEROUS_SHELL) if (matchesShellSignal(sig, aug.text)) findings.push({ label: sig.name, severity: sig.severity, category: 'shell', ...locate(t, sig.re, mask) });
    for (const sig of scanStagedFetchExec(aug.text)) findings.push({ label: sig.name, severity: sig.severity, category: 'shell', ...locate(t, sig.re, mask) });
    for (const h of detectExecutionHijack(aug.text))
      findings.push({ label: `Installs an execution hook that governs ${h.governs} (${h.key})`, severity: h.severity, category: 'shell' });
    for (const c of detectCredentialHarvest(aug.text))
      findings.push({ label: `${c.label} - credential harvest`, severity: c.severity, category: 'shell' });
  }
  if (cats.includes('injection')) {
    findings.push(...injectionHits(t, mask));
    const hidden = suspiciousInvisible(t);
    if (hidden) {
      const seen = new Set(findings.map((f) => f.label));
      const line = lineAt(t, hidden.index);
      for (const f of injectionHits(t.replace(INVISIBLE_CHARS_GLOBAL_RE, ''), null)) {
        if (!seen.has(f.label)) findings.push({ ...f, label: `${f.label} (de-obfuscated)`, line });
      }
    }
    findings.push(...invisibleInjectionFindings(t));
    const disguised = disguisedWords(t);
    if (disguised.length >= 2) findings.push({ label: 'Words disguised with lookalike letters from another alphabet', severity: 'MEDIUM', category: 'injection', ...locate(t, disguised[0], mask) });
  }
  if (cats.includes('secret')) {
    for (const { name, re } of SECRET_PATTERNS) { const m = t.match(re); if (m && (/private key/i.test(name) || !isPlaceholderSecret(m[0]))) findings.push({ label: `Live credential: ${name}`, severity: 'CRITICAL', category: 'secret', ...locate(t, re, mask) }); }
    findings.push(...invisibleSecretFindings(t));
  }
  if (cats.includes('pii')) {
    for (const { name, re } of PII_PATTERNS) {
      const m = t.match(re);
      if (!m) continue;
      if (name === 'Credit card number' && !luhnValid(m[0])) continue;

      if (name === 'IPv4 address') {
        if (RESERVED_IPV4.test(m[0])) continue;
        if (VERSION_CONTEXT.test(t.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0))) continue;
      }

      if (name === 'Phone number' && /^\d+$/.test(m[0])) continue;
      findings.push({ label: `Personal data: ${name}`, severity: 'MEDIUM', category: 'pii', ...locate(t, re, mask) });
    }
  }
  if (cats.includes('config')) {

    for (const m of RISKY_CONFIG_MARKERS) {
      const hit = riskyConfigHit(t, m);
      if (hit) {
        findings.push({ label: `Risky setting: "${m}"`, severity: 'MEDIUM', category: 'config', line: lineAt(t, hit.start), codeContext: mask[hit.start] === 1 });
        break;
      }
    }
  }
  if (cats.includes('egress')) {
    const h = egressHost(t);
    if (h) findings.push({ label: `Exfiltration sink host: ${h}`, severity: 'HIGH', category: 'egress', ...locate(t, h, mask) });
  }

  let worstRank = 0, top = null;
  for (const f of findings) if (SEV_RANK[f.severity] > worstRank) { worstRank = SEV_RANK[f.severity]; top = f; }
  const verdict = worstRank >= SEV_RANK.CRITICAL ? 'BLOCK' : worstRank >= SEV_RANK.HIGH ? 'FLAG' : 'ALLOW';
  return { verdict, top, findings };
}

export function downrankCodeContext(findings) {
  return (findings || []).map((f) => (f.codeContext ? { ...f, severity: 'LOW', downranked: true } : f));
}

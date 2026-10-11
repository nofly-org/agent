import fs from 'node:fs';
import path from 'node:path';
import { descendInto, readRegularFile, readableEntry } from '../artifacts/matchers.mjs';
import { isModelConfig, isScannableSource, scanSourceFile } from '../detect/code-sast.mjs';
import { grade, localScan } from '../detect/guard-signals.mjs';

const MAX_SAST_FILES = 60;
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ksh|fish|ps1|psm1|bat|cmd)$/i;
const REFERENCE_EXT = /\.(?:md|mdx|markdown|txt|rst)$/i;

export function bundledKind(name) {
  const base = String(name ?? '').split(/[\\/]+/).pop() ?? '';
  if (isScannableSource(base) || isModelConfig(base)) return 'code';
  if (SCRIPT_EXT.test(base)) return 'script';
  if (REFERENCE_EXT.test(base)) return /^SKILL\.md$/i.test(base) ? null : 'reference';
  if (base && !base.includes('.')) return 'maybe-script';
  return null;
}

const BUNDLED_PRIORITY = { code: 0, script: 1, 'maybe-script': 2, reference: 3 };
const MAX_BUNDLED_CANDIDATES = 400;

export function byBundledPriority(a, b) {
  return BUNDLED_PRIORITY[bundledKind(a.rel)] - BUNDLED_PRIORITY[bundledKind(b.rel)];
}

function walkScripts(root) {
  const found = [];
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch {  }
  const stack = [[root, '']];
  while (stack.length && found.length < MAX_BUNDLED_CANDIDATES) {
    const [dir, relDir] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (descendInto(relDir ? `skills/${relDir}` : 'skills', ent.name)) stack.push([full, relDir ? `${relDir}/${ent.name}` : ent.name]); continue; }
      if (bundledKind(ent.name)) {
        const readable = readableEntry(realRoot, full, ent);
        if (!readable || readable.skip) continue;
        found.push({ full, rel: path.relative(process.cwd(), full).split(path.sep).join('/') });
        if (found.length >= MAX_BUNDLED_CANDIDATES) break;
      }
    }
  }
  return found.sort(byBundledPriority).slice(0, MAX_SAST_FILES);
}

function sastToFinding(h) {
  const base = h.file ? h.file.split('/').pop() : '';
  return {
    severity: h.severity,
    title: `Risky code - ${h.title}${base ? ` in ${base}` : ''} (${h.sink})`,
    remediationText: h.remediation,
    ...(h.line ? { line: h.line } : {}),
    analysis: 'sast', ruleId: h.ruleId, cwe: h.cwe, sink: h.sink, source: h.source,
    file: h.file, snippet: h.snippet, snippetStartLine: h.snippetStartLine,
  };
}

const BUNDLED_REMEDIATION = {
  script: 'This script ships with the artifact and can run without anyone reading it - a permission prompt shows the script name, not what is inside it. Remove the payload or review the script by hand.',
  reference: 'The agent reads this file along with the artifact. Remove the command, or make clear it must not be run.',
};

export function bundledFindings(file) {
  const kind = bundledKind(file.rel);
  if (kind === 'code') return scanSourceFile(file.content, file.rel).map(sastToFinding);
  const script = kind === 'script' || (kind === 'maybe-script' && file.content.startsWith('#!'));
  if (!script && kind !== 'reference') return [];
  const where = script ? 'script' : 'reference';
  const base = file.rel.split('/').pop();
  return localScan(file.content, { categories: ['shell', 'secret', 'egress'], prose: !script }).findings.map((f) => ({
    severity: f.severity,
    title: `${f.label} - in bundled ${where} ${base}`,
    remediationText: BUNDLED_REMEDIATION[where],
    ...(f.line ? { line: f.line } : {}),
    analysis: 'bundled',
    file: file.rel,
  }));
}

export function collectLocalSast({ fullPath, relPath, kind, content, scripts }) {
  const out = [];
  if (relPath && (isScannableSource(relPath) || isModelConfig(relPath))) {
    for (const h of scanSourceFile(content || '', relPath)) out.push(sastToFinding(h));
  }
  const isSkill = kind === 'skill' || /(^|\/)SKILL\.md$/i.test(relPath || '');
  if (!isSkill || (!scripts && !fullPath)) return out;
  const bundled = scripts ?? walkScripts(path.dirname(fullPath)).map((s) => ({ rel: s.rel, ...readRegularFile(s.full) }));
  for (const file of bundled) {
    if (file.skip || typeof file.content !== 'string') continue;
    out.push(...bundledFindings(file));
  }
  return out;
}

export const DEC_RANK = { ALLOW: 0, FLAG: 1, BLOCK: 2 };

export function mergeSastIntoResult(result, sastFindings) {
  if (!sastFindings || !sastFindings.length) return result;
  const findings = [...(result.findings || []), ...sastFindings];
  const g = grade(findings);
  const decision = DEC_RANK[g.verdict] > DEC_RANK[result.decision] ? g.verdict : result.decision;
  return { ...result, decision, riskScore: Math.max(result.riskScore || 0, g.riskScore), findingCount: findings.length, findings };
}

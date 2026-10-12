import fs from 'node:fs';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, descendInto, readArtifactBounded, readableEntry } from '../artifacts/matchers.mjs';
import { isModelConfig, isScannableSource, scanSourceFile } from '../detect/code-sast.mjs';
import { grade, localScan } from '../detect/guard-signals.mjs';

export const MAX_SAST_FILES = 200;
export const MAX_BUNDLED_BYTES = 16 * 1024 * 1024;
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
const MAX_BUNDLED_CANDIDATES = 2000;

export function byBundledPriority(a, b) {
  return BUNDLED_PRIORITY[bundledKind(a.rel)] - BUNDLED_PRIORITY[bundledKind(b.rel)];
}

export function planBundled(candidates) {
  const take = [];
  const skipped = [];
  let bytes = 0;
  for (const c of candidates) {
    const cost = Math.min(Number.isFinite(c.size) ? c.size : MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
    if (take.length >= MAX_SAST_FILES) skipped.push({ rel: c.rel, skip: `past the ${MAX_SAST_FILES}-file limit` });
    else if (bytes + cost > MAX_BUNDLED_BYTES) skipped.push({ rel: c.rel, skip: `past the ${MAX_BUNDLED_BYTES / (1024 * 1024)} MB limit for bundled files` });
    else {
      bytes += cost;
      take.push(c);
    }
  }
  return { take, skipped };
}

function walkScripts(root, scanRoot) {
  const found = [];
  const skipped = [];
  let truncated = false;
  let realRoot = scanRoot ?? root;
  try { realRoot = fs.realpathSync(realRoot); } catch {  }
  const stack = [[root, '']];
  while (stack.length && !truncated) {
    const [dir, relDir] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (descendInto(relDir ? `skills/${relDir}` : 'skills', ent.name)) stack.push([full, relDir ? `${relDir}/${ent.name}` : ent.name]); continue; }
      if (!bundledKind(ent.name)) continue;
      if (found.length + skipped.length >= MAX_BUNDLED_CANDIDATES) {
        truncated = true;
        break;
      }
      const readable = readableEntry(realRoot, full, ent);
      if (!readable) continue;
      const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
      if (readable.skip) {
        skipped.push({ rel, skip: readable.skip });
        continue;
      }
      let size = null;
      try { size = fs.statSync(full).size; } catch {  }
      found.push({ full, rel, size });
    }
  }
  const plan = planBundled(found.sort(byBundledPriority));
  return { files: plan.take, skipped: [...skipped, ...plan.skipped], truncated };
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

const NOT_ANALYZED_REMEDIATION = 'The agent can load or run this file, and nothing here read it. Shrink the skill folder, or review the file by hand.';
const baseName = (rel) => String(rel ?? '').split('/').pop();

export function notAnalyzedFindings(skipped, truncated = false) {
  const out = [];
  const byReason = new Map();
  for (const s of skipped) {
    if (!byReason.has(s.skip)) byReason.set(s.skip, []);
    byReason.get(s.skip).push(s.rel);
  }
  for (const [why, rels] of byReason) {
    if (rels.length <= 3) {
      for (const rel of rels) out.push({ severity: 'HIGH', title: `Bundled file not analyzed - ${baseName(rel)} (${why})`, remediationText: NOT_ANALYZED_REMEDIATION, analysis: 'bundled', notAnalyzed: true, file: rel });
    } else {
      out.push({ severity: 'HIGH', title: `${rels.length} bundled files not analyzed (${why}) - ${rels.slice(0, 3).map(baseName).join(', ')} and more`, remediationText: NOT_ANALYZED_REMEDIATION, analysis: 'bundled', notAnalyzed: true });
    }
  }
  if (truncated) out.push({ severity: 'HIGH', title: `Skill folder holds more than ${MAX_BUNDLED_CANDIDATES} files - the rest were not analyzed`, remediationText: NOT_ANALYZED_REMEDIATION, analysis: 'bundled', notAnalyzed: true });
  return out;
}

function unreadMiddleFinding(file) {
  return {
    severity: 'HIGH',
    title: `Bundled file too large to read whole - ${file.unread} bytes in the middle of ${baseName(file.rel)} were not analyzed`,
    remediationText: NOT_ANALYZED_REMEDIATION,
    analysis: 'bundled',
    notAnalyzed: true,
    file: file.rel,
  };
}

export function bundledFileFindings(file) {
  if (file.skip || typeof file.content !== 'string') return [];
  return [...bundledFindings(file), ...(file.unread ? [unreadMiddleFinding(file)] : [])];
}

export function collectLocalSast({ fullPath, relPath, kind, content, scripts, root }) {
  const out = [];
  if (relPath && (isScannableSource(relPath) || isModelConfig(relPath))) {
    for (const h of scanSourceFile(content || '', relPath)) out.push(sastToFinding(h));
  }
  const isSkill = kind === 'skill' || /(^|\/)SKILL\.md$/i.test(relPath || '');
  if (!isSkill || (!scripts && !fullPath)) return out;
  let bundled = scripts;
  let truncated = false;
  if (!bundled) {
    const walked = walkScripts(path.dirname(fullPath), root);
    bundled = [...walked.files.map((s) => ({ rel: s.rel, ...readArtifactBounded(s.full) })), ...walked.skipped];
    truncated = walked.truncated;
  }
  for (const file of bundled) out.push(...bundledFileFindings(file));
  out.push(...notAnalyzedFindings(bundled.filter((file) => file.skip), truncated));
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

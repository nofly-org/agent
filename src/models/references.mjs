import fs from 'node:fs';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, readRegularFile } from '../artifacts/matchers.mjs';
import { isModelRefScannable, scanModelRefs } from '../detect/model-refs.mjs';
import { nameSkeleton } from '../detect/signals/manifests.mjs';
import { editDistance } from '../detect/signals/package-names.mjs';
import { MODEL_SEV_RANK, modelFixPlan, modelLookup } from './lookup.mjs';

const DEFAULT_LOOKUP_CONCURRENCY = 6;

const SAFETY_REMOVED = [
  { re: /abliterat/i, how: 'abliterated - the refusal direction was projected out of the weights' },
  { re: /orthogonali[sz]/i, how: 'orthogonalized - the refusal direction was projected out of the weights' },
  { re: /(?:^|[/_.:-])(?:un|de)-?censored(?:$|[/_.:-])/i, how: 'published as uncensored - fine-tuned so it stops refusing' },
  { re: /(?:^|[/_.:-])(?:refusal[-_]?(?:removed|ablated|free)|no[-_]?(?:refusals?|guardrails?|safety|alignment)|unaligned|jailbr(?:oken|eak))(?:$|[/_.:-])/i, how: 'named for removed refusals or alignment' },
  { re: /^(?:cognitivecomputations\/)?dolphin[-_.\d]/i, how: 'a Dolphin release, trained on data filtered to remove alignment and refusals' },
];

export function safetyRemovedReason(id) {
  return SAFETY_REMOVED.find((s) => s.re.test(String(id ?? '')))?.how ?? null;
}

const POPULAR_MODEL_ORGS = [
  'meta-llama', 'mistralai', 'google', 'openai', 'microsoft', 'Qwen', 'deepseek-ai', 'stabilityai', 'anthropic', 'nvidia', 'apple',
  'ibm-granite', 'tiiuae', 'bigscience', 'EleutherAI', 'NousResearch', 'HuggingFaceH4', 'CohereForAI', 'databricks', 'Salesforce',
  'facebook', 'bigcode', 'sentence-transformers', 'black-forest-labs', 'TheBloke',
];

const KNOWN_MODEL_ORGS = new Set([...POPULAR_MODEL_ORGS, 'HuggingFaceTB', 'HuggingFaceM4', 'HuggingFaceFW', 'FacebookAI'].map((o) => o.toLowerCase()));

export function publisherLookalike(id) {
  const owner = String(id ?? '').includes('/') ? String(id).split('/')[0].trim() : '';
  if (!owner) return null;
  const raw = owner.toLowerCase();
  const folded = nameSkeleton(owner);
  const spoofed = folded !== raw ? POPULAR_MODEL_ORGS.find((o) => o.toLowerCase() === folded) : undefined;
  if (spoofed) return { org: spoofed, distance: 0 };
  if (KNOWN_MODEL_ORGS.has(raw)) return null;
  for (const org of POPULAR_MODEL_ORGS) {
    const allowed = org.length <= 5 ? 0 : org.length <= 8 ? 1 : 2;
    if (!allowed || Math.abs(org.length - folded.length) > allowed) continue;
    const d = editDistance(folded, org.toLowerCase());
    if (d > 0 && d <= allowed) return { org, distance: d };
  }
  return null;
}

export function resolveScanScope(target, walkFiles) {
  try {
    const stats = fs.statSync(target);
    if (stats.isFile()) return { root: path.dirname(target), entries: [path.basename(target)] };
    return { root: target, entries: walkFiles(target) };
  } catch {
    return { root: target, entries: [] };
  }
}

function readScannableFile(root, relativePath) {
  const read = readRegularFile(path.join(root, relativePath), MAX_ARTIFACT_BYTES);
  return typeof read.content === 'string' && !read.content.includes('\0') ? read.content : null;
}

export function collectModelReferences(root, entries) {
  const byKey = new Map();
  for (const relativePath of entries) {
    if (!isModelRefScannable(relativePath)) continue;
    const content = readScannableFile(root, relativePath);
    if (content == null) continue;

    for (const reference of scanModelRefs(content, relativePath)) {
      const key = `${reference.source}:${reference.id}:${reference.revision || ''}`;
      if (!byKey.has(key)) {
        byKey.set(key, { id: reference.id, sha: reference.revision || null, source: reference.source, locations: [] });
      }
      byKey.get(key).locations.push({ file: reference.file, line: reference.line, via: reference.via });
    }
  }
  return [...byKey.values()];
}

export async function lookupModels(url, references, concurrency = DEFAULT_LOOKUP_CONCURRENCY) {
  const results = new Array(references.length).fill(null);
  let indexUnreachable = false;
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= references.length || indexUnreachable) return;

      if (references[index].source === 'ollama') {
        results[index] = { found: false, local: true };
        continue;
      }
      try {
        results[index] = await modelLookup(url, references[index].id, references[index].sha);
      } catch (error) {
        indexUnreachable = true;
        results[index] = { error: error.message };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  return { results, indexUnreachable };
}

function alertLevel(lookup, findings) {
  const worst = findings.reduce((rank, finding) => Math.max(rank, MODEL_SEV_RANK[finding.severity] || 0), 0);
  if (!lookup.found) return 'OK';
  if (lookup.verdict === 'FAIL' || worst >= MODEL_SEV_RANK.CRITICAL) return 'BLOCK';
  if (lookup.verdict === 'REVIEW' || worst >= MODEL_SEV_RANK.HIGH) return 'FLAG';
  return 'OK';
}

export function assessModel(reference, rawLookup) {
  const lookup = rawLookup || {};
  const findings = lookup.findings || [];
  const safetyRemoved = safetyRemovedReason(reference.id);
  const lookalike = reference.source === 'hf' ? publisherLookalike(reference.id) : null;
  const graded = alertLevel(lookup, findings);
  const alert = (safetyRemoved || lookalike) && graded === 'OK' ? 'FLAG' : graded;

  return {
    ...reference,
    safetyRemoved,
    lookalike,
    found: !!lookup.found,
    verdict: lookup.verdict || null,
    riskScore: lookup.riskScore ?? null,
    scannedSha: lookup.sha || null,
    findingCount: findings.length,
    findings,
    alert,
    fix: lookup.found && alert !== 'OK' && reference.source === 'hf' ? modelFixPlan(findings, lookup.sha) : null,
    alternatives: alert !== 'OK' ? (lookup.alternatives || []) : [],
    error: lookup.error,
    notIndexed: !lookup.found && !lookup.error,
  };
}

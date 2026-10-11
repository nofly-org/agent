import fs from 'node:fs';
import { MAX_ARTIFACT_BYTES } from '../artifacts/matchers.mjs';
import { api, gateMachine } from '../core/api-client.mjs';
import { clampInt } from '../core/numbers.mjs';
import { SEV_COLOR, bold, dim, gray, green, red, yellow } from '../core/terminal.mjs';
import { grade, localGate } from '../detect/guard-signals.mjs';
import { applyRepoPolicy, loadRepoPolicy, parseRepoPolicy } from './repo-policy.mjs';
import { isGateVerdict, localAsGateResult } from './result.mjs';
import { collectLocalSast, mergeSastIntoResult } from './sast.mjs';
import { withMcpAdvisories } from './advisories.mjs';
import { maskSecrets } from '../detect/secret-mask.mjs';
import { loadBaseline, loadIgnoreRules, parseBaseline, parseIgnoreRules, suppressResult } from './suppressions.mjs';

const DEFAULT_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const MAX_FINDINGS_SHOWN = 3;
const FAIL_ON_RANK = { critical: 3, high: 2, medium: 1 };

const HALF_WINDOW = Math.floor(MAX_ARTIFACT_BYTES / 2);
const DEC_ORDER = { ALLOW: 0, FLAG: 1, BLOCK: 2 };

export function readArtifactBounded(full) {
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { skip: 'not a regular file' };
    if (st.size <= MAX_ARTIFACT_BYTES) {
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, st.size, 0);
      return { content: buf.subarray(0, n).toString('utf8') };
    }
    const head = Buffer.alloc(HALF_WINDOW);
    const tail = Buffer.alloc(HALF_WINDOW);
    const hn = fs.readSync(fd, head, 0, HALF_WINDOW, 0);
    const tn = fs.readSync(fd, tail, 0, HALF_WINDOW, st.size - HALF_WINDOW);
    return { content: `${head.subarray(0, hn).toString('utf8')}\n${tail.subarray(0, tn).toString('utf8')}`, unread: Math.max(0, st.size - hn - tn) };
  } catch (error) {
    return { skip: `could not be read (${error.code ?? error.message})` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}

export function withUnreadMiddle(local, unread) {
  const findings = [...local.findings, {
    severity: 'HIGH',
    title: `Artifact too large to read whole - ${unread} bytes in the middle were not analyzed`,
    remediationText: 'An AI artifact this large is unusual; split it or review the unread part by hand.',
  }];
  const g = grade(findings);
  return { ...local, findings, verdict: DEC_ORDER[g.verdict] > DEC_ORDER[local.verdict] ? g.verdict : local.verdict, riskScore: Math.max(local.riskScore ?? 0, g.riskScore) };
}

function notAnalyzedResult(artifact, why) {
  return {
    decision: 'FLAG',
    name: artifact.rel.split('/').pop(),
    kind: artifact.kind,
    riskScore: 40,
    findingCount: 1,
    notAnalyzed: why,
    findings: [{ severity: 'HIGH', title: `Not analyzed: ${why}`, remediationText: 'Shomra could not check this artifact, so it is not known to be safe. Make it readable, or remove it.' }],
  };
}

function analyseLocally(artifacts, quiet) {
  const prepared = [];
  for (const artifact of artifacts) {
    const read = artifact.skip ? { skip: artifact.skip } : artifact.read ?? readArtifactBounded(artifact.full);
    if (read.skip) {
      if (!quiet) console.log(`  ${gray('•')} ${dim(artifact.rel)} ${yellow(`not analyzed - ${read.skip}`)}`);
      prepared.push({ artifact, skipped: read.skip });
      continue;
    }
    const local = localGate(read.content, { kind: artifact.kind, path: artifact.rel });
    prepared.push({
      artifact,
      content: read.content,
      local: read.unread ? withUnreadMiddle(local, read.unread) : local,
      sast: collectLocalSast({ fullPath: artifact.full, relPath: artifact.rel, kind: artifact.kind, content: read.content, scripts: artifact.scripts }),
    });
  }
  return prepared;
}

async function requestServerVerdicts(prepared, { apiKey, url, env, flags, quiet }) {
  const verdicts = new Array(prepared.length).fill(null);
  const rejected = [];
  let backendDown = false;
  let authFailed = false;
  if (!apiKey) return { verdicts, rejected, backendDown, authFailed };

  const concurrency = clampInt(process.env.SHOMRA_GATE_CONCURRENCY, DEFAULT_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= prepared.length || backendDown) return;

      const { artifact, content, skipped } = prepared[index];
      if (skipped) continue;
      try {
        const verdict = await api(url, apiKey, '/gate/check', {
          kind: artifact.kind,
          path: artifact.rel,
          content: maskSecrets(content).text,
          machine: gateMachine(),
          env,
          ...(flags.project ? { projectId: String(flags.project) } : {}),
        });
        if (!isGateVerdict(verdict)) throw new Error('the backend answered without a gate verdict - is SHOMRA_URL pointing at the Shomra API?');
        verdicts[index] = verdict;
      } catch (error) {
        if (error?.rejected && !error.auth) {
          rejected.push({ path: artifact.rel, kind: artifact.kind, reason: error.message });
          continue;
        }
        if (error?.auth) authFailed = true;
        if (!backendDown && !quiet) {
          console.log(`  ${yellow('⚠')} ${dim(`backend unavailable (${error.message}) - on-machine analysis for the rest`)}`);
        }
        backendDown = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, prepared.length) }, worker));
  return { verdicts, rejected, backendDown, authFailed };
}

function printResult(result, artifact, source) {
  const colour = result.decision === 'BLOCK' ? red : result.decision === 'FLAG' ? yellow : green;
  const suppressedNote = result.suppressedCount ? dim(` · ${result.suppressedCount} suppressed${result.suppressionNote ? ` - ${result.suppressionNote}` : ''}`) : '';
  const pathNote = artifact.rel !== result.name ? ` ${dim(artifact.rel)}` : '';
  const localNote = source === 'local' ? dim(' ·local') : '';
  const findingCount = result.findingCount ?? (result.findings || []).length;

  console.log(`  ${colour('●')} ${bold(result.name)}${pathNote}${localNote} ${colour(result.decision)} ${dim(`risk ${result.riskScore} · ${findingCount} finding(s)`)}${suppressedNote}`);

  const findings = result.findings || [];
  for (const finding of findings.slice(0, MAX_FINDINGS_SHOWN)) {
    const location = finding.line ? dim(` (${finding.file || artifact.rel}:${finding.line})`) : '';
    const severity = String(finding.severity ?? 'INFO').toUpperCase();
    console.log(`      ${(SEV_COLOR[severity] ?? gray)(severity.padEnd(8))} ${finding.title}${location}`);
  }
  const remaining = findings.length - Math.min(findings.length, MAX_FINDINGS_SHOWN);
  if (remaining > 0) console.log(`      ${dim(`… and ${remaining} more (run with --json for all)`)}`);
}

function resolveSuppression(flags, root, trusted) {
  const enabled = !flags['no-suppress'];
  const useBaseline = enabled && !flags['no-baseline'];
  return {
    enabled,
    rules: !enabled ? parseIgnoreRules('') : trusted ? parseIgnoreRules(trusted.ignore) : loadIgnoreRules(root),
    baseline: !useBaseline ? null : trusted ? parseBaseline(trusted.baseline) : loadBaseline(root),
    lineCache: new Map(),
    trustedMarks: trusted?.markLines ?? null,
    markNote: trusted?.markNote,
  };
}

function resolvePolicy(flags, root, trusted) {
  if (flags['no-policy']) return null;
  if (!trusted) return loadRepoPolicy(root);
  return trusted.policy ? parseRepoPolicy(trusted.policy.text, trusted.policy.file) : null;
}

export async function gateArtifactList(artifacts, { apiKey, url, env, flags, root, trusted }) {
  const quiet = flags.json || flags.sarif;
  const workingRoot = root || process.cwd();
  const suppression = resolveSuppression(flags, workingRoot, trusted);
  const policy = resolvePolicy(flags, workingRoot, trusted);

  const prepared = analyseLocally(artifacts, quiet);
  const { verdicts, rejected, backendDown, authFailed } = await requestServerVerdicts(prepared, { apiKey, url, env, flags, quiet });

  let advisoryOutage = false;
  await Promise.all(prepared.map(async (p, i) => {
    if (p.skipped || verdicts[i] || p.artifact.kind !== 'mcp') return;
    const { local, advisories } = await withMcpAdvisories(p.local, { content: p.content, path: p.artifact.rel, kind: 'mcp', flags });
    p.local = local;
    if (advisories === 'unavailable') advisoryOutage = true;
  }));
  if (advisoryOutage && !quiet) console.log(`  ${yellow('⚠')} ${dim('Advisory lookup (OSV) unreachable - pinned MCP packages were not checked for published CVEs.')}`);

  const results = [];
  let blocked = 0;
  let flagged = 0;
  let suppressed = 0;

  prepared.forEach(({ artifact, local, sast, skipped }, index) => {
    const serverVerdict = verdicts[index];
    const source = serverVerdict ? 'server' : 'local';
    const base = skipped ? notAnalyzedResult(artifact, skipped) : serverVerdict || localAsGateResult(local, artifact.rel.split('/').pop(), artifact.kind);
    const merged = skipped ? base : mergeSastIntoResult(base, sast);

    const raw = { path: artifact.rel, full: artifact.full, kind: artifact.kind, source, ...merged, ...(serverVerdict ? { orgDecision: serverVerdict.decision } : {}) };
    if (typeof artifact.read?.content === 'string') suppression.lineCache.set(artifact.full, artifact.read.content.split(/\r?\n/));
    const withSuppressions = suppression.enabled
      ? suppressResult(raw, suppression.rules, suppression.baseline, suppression.lineCache, suppression.trustedMarks, suppression.markNote)
      : raw;
    const result = applyRepoPolicy(withSuppressions, policy);

    suppressed += result.suppressedCount || 0;
    results.push(result);
    if (result.decision === 'BLOCK') blocked += 1;
    else if (result.decision === 'FLAG') flagged += 1;

    if (!quiet) printResult(result, artifact, source);
  });

  return { results, blocked, flagged, suppressed, backendDown, rejected, authFailed };
}

export function failOnHit(flags, blocked, flagged) {
  const threshold = FAIL_ON_RANK[String(flags['fail-on'] || 'critical').toLowerCase()] ?? 3;
  const worst = blocked > 0 ? 3 : flagged > 0 ? 2 : 0;
  return worst > 0 && worst >= threshold;
}

export function strictOutageOf(flags, { backendDown, authFailed }) {
  return !!flags.strict && !!(backendDown || authFailed);
}

export function gateExitCode(flags, { blocked, flagged, backendDown, authFailed }) {
  if (blocked > 0 || strictOutageOf(flags, { backendDown, authFailed })) return 1;
  if (failOnHit(flags, blocked, flagged)) return 1;
  if (flagged > 0 && flags.strict) return 2;
  return 0;
}

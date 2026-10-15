import fs from 'node:fs';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, resolveScanTarget, walkArtifacts } from '../artifacts/matchers.mjs';
import { api, gateMachine } from '../core/api-client.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { localGate } from '../detect/guard-signals.mjs';
import { carriedPastMasking, gateArtifactList, gateExitCode, readArtifactBounded, strictOutageOf, withUnreadMiddle } from '../gate/batch.mjs';
import { collectSiblings, detectEnv, kindFlag } from '../gate/environment.mjs';
import { isGateVerdict, localAsGateResult, printGateResult } from '../gate/result.mjs';
import { locationBase } from '../gate/locations.mjs';
import { toSarif } from '../gate/sarif.mjs';
import { bundledFileFindings, bundledKind, byBundledPriority, collectLocalSast, mergeSastIntoResult, notAnalyzedFindings, planBundled } from '../gate/sast.mjs';
import { withMcpAdvisories } from '../gate/advisories.mjs';
import { maskSecrets } from '../detect/secret-mask.mjs';
import { listZipEntries, normalizeZipName, readZipText } from '../core/zip-lite.mjs';
import { readFailure, readRegularBuffer } from '../core/safe-read.mjs';

const GATE_USAGE = 'nofly gate <file> [--kind mcp|skill|command|subagent|hook|rules|agent-card|memory|plugin|tool-manifest|extension|workflow|guardrail|framework] [--name x] [--strict] [--json]';

function resolveGateFile(file) {
  let target = path.resolve(String(file));

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const skillFile = path.join(target, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      console.error(`${red('✗')} ${file} is a directory with no SKILL.md - point at a file instead.`);
      process.exit(EXIT_USAGE);
    }
    target = skillFile;
  }
  if (!fs.existsSync(target)) {
    console.error(`${red('✗')} File not found: ${file}`);
    process.exit(EXIT_USAGE);
  }
  return target;
}

const MAX_BUNDLE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_INFLATE = 64 * 1024 * 1024;
const HALF_WINDOW = Math.floor(MAX_ARTIFACT_BYTES / 2);
const DEPENDENCY_DIR = /(^|\/)(node_modules|vendor|site-packages|\.venv|venv|__pycache__)\//i;
const SEVERITY_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function readBundle(buf, bundleRel) {
  const entries = listZipEntries(buf);
  if (!entries) return { content: null, findings: [] };
  const findings = [];
  const manifests = entries.filter((e) => !e.directory && e.path.toLowerCase() === 'manifest.json');
  const renamed = entries.filter((e) => e.localName !== null && normalizeZipName(e.localName) !== e.path);
  if (manifests.length > 1 || renamed.length) {
    findings.push({
      severity: 'CRITICAL',
      title: manifests.length > 1
        ? `Bundle carries ${manifests.length} copies of manifest.json - an installer may read a different one than this check did`
        : `Bundle entry names disagree (${renamed[0].path} is stored as ${renamed[0].localName}) - an installer may unpack different files than this check read`,
      remediationText: 'Rebuild the bundle from source so every file appears once, under one name.',
    });
  }
  const content = manifests.length ? readZipText(buf, manifests[manifests.length - 1]) : null;
  if (manifests.length > 1 && content !== null) {
    const first = readZipText(buf, manifests[0]);
    if (first !== null && first !== content) {
      for (const f of localGate(first, { kind: 'mcp', path: `${bundleRel}!/manifest.json` }).findings) findings.push({ ...f, title: `${f.title} (in another copy of manifest.json)` });
    }
  }
  const candidates = entries
    .filter((e) => !e.directory && !DEPENDENCY_DIR.test(e.path) && bundledKind(e.path) && bundledKind(e.path) !== 'reference')
    .map((e) => ({ ...e, rel: e.path, size: e.usize }))
    .sort(byBundledPriority);
  const plan = planBundled(candidates);
  const skipped = plan.skipped.map((s) => ({ rel: `${bundleRel}!/${s.rel}`, skip: s.skip }));
  for (const entry of plan.take) {
    const rel = `${bundleRel}!/${entry.path}`;
    const text = entry.usize > MAX_BUNDLE_INFLATE ? null : readZipText(buf, entry, { maxBytes: MAX_BUNDLE_INFLATE });
    if (text === null) {
      skipped.push({ rel, skip: entry.usize > MAX_BUNDLE_INFLATE ? 'too large to analyze' : 'could not be read from the bundle' });
      continue;
    }
    const windowed = text.length > MAX_ARTIFACT_BYTES ? { content: `${text.slice(0, HALF_WINDOW)}\n${text.slice(-HALF_WINDOW)}`, unread: text.length - 2 * HALF_WINDOW } : { content: text };
    for (const f of bundledFileFindings({ rel, ...windowed })) {
      const capped = bundledKind(entry.path) === 'code' && SEVERITY_RANK[f.severity] > SEVERITY_RANK.HIGH ? 'HIGH' : f.severity;
      findings.push({ ...f, severity: capped });
    }
  }
  findings.push(...notAnalyzedFindings(skipped));
  return { content, findings };
}

function readGateTarget(flags, positional) {
  if (flags.stdin) {
    return { content: fs.readFileSync(0, 'utf8'), relPath: flags.path || null, fullTarget: null };
  }

  const file = positional[0];
  if (!file) {
    console.error(`${red('✗')} Usage: ${bold(GATE_USAGE)}`);
    process.exit(EXIT_USAGE);
  }
  const target = resolveGateFile(file);
  
  if (/\.(?:dxt|mcpb)$/i.test(target)) {
    const bundleRel = path.relative(process.cwd(), target).split(path.sep).join('/');
    let bytes;
    try {
      bytes = readRegularBuffer(target, MAX_BUNDLE_FILE_BYTES);
    } catch (error) {
      const why = error.code === 'EFBIG' ? `is larger than ${MAX_BUNDLE_FILE_BYTES / (1024 * 1024)} MB - too large to check as an extension bundle` : `could not be read (${readFailure(error)})`;
      console.error(`${red('✗')} ${file} ${why}.`);
      process.exit(EXIT_USAGE);
    }
    const read = readBundle(bytes, bundleRel);
    if (read.content == null) {
      console.error(`${red('✗')} ${file} is not a readable extension bundle (no manifest.json at its root).`);
      process.exit(EXIT_USAGE);
    }
    return { content: read.content, relPath: `${bundleRel}!/manifest.json`, fullTarget: null, bundle: true, bundleFindings: read.findings };
  }
  const read = readArtifactBounded(target);
  if (read.skip) {
    console.error(`${red('✗')} ${file} ${read.skip}.`);
    process.exit(EXIT_USAGE);
  }
  return {
    content: read.content,
    unread: read.unread ?? 0,
    relPath: path.relative(process.cwd(), target).split(path.sep).join('/'),
    fullTarget: target,
  };
}

async function requestGateVerdict({ url, apiKey, flags, kind, relPath, content, fullTarget }) {
  if (!flags.json) process.stdout.write(dim('  Checking with NoFly gate… '));
  try {
    const siblings = collectSiblings(fullTarget, relPath);
    const sent = maskSecrets(content);
    const verdict = await api(url, apiKey, '/gate/check', {
      ...(kind ? { kind } : {}),
      ...(flags.name ? { name: String(flags.name) } : {}),
      ...(relPath ? { path: relPath } : {}),
      content: sent.text,
      ...(siblings.length ? { siblings } : {}),
      machine: gateMachine(),
      env: detectEnv(),
      ...(flags.project ? { projectId: String(flags.project) } : {}),
    });
    if (!isGateVerdict(verdict)) throw new Error('the backend answered without a gate verdict - is NOFLY_URL pointing at the NoFly API?');
    if (!flags.json) console.log('');
    return { verdict, sent };
  } catch (error) {
    if (!flags.json) {
      console.log(yellow('backend unavailable'));
      console.error(`  ${yellow('⚠')} ${error.message} ${dim('- falling back to on-machine analysis')}`);
    }
    return { verdict: null };
  }
}

export async function cmdGate(rawFlags, positional) {
  const { apiKey, url } = resolveSettings(loadConfig());
  if (rawFlags.all) return cmdGateAll(rawFlags, positional, { apiKey, url });
  const sarif = !!rawFlags.sarif;
  const flags = sarif ? { ...rawFlags, json: true } : rawFlags;

  const { content, relPath, fullTarget, bundle, bundleFindings: fromBundle = [], unread = 0 } = readGateTarget(flags, positional);
  const kind = kindFlag(flags) ?? (bundle ? 'mcp' : undefined);
  const name = flags.name ? String(flags.name) : (relPath ? relPath.split('/').pop() : 'artifact');
  const local = unread ? withUnreadMiddle(localGate(content, { kind, path: relPath }), unread) : localGate(content, { kind, path: relPath });

  let serverVerdict = null;
  let sent = null;
  if (apiKey) {
    ({ verdict: serverVerdict, sent = null } = await requestGateVerdict({ url, apiKey, flags, kind, relPath, content, fullTarget }));
    if (!serverVerdict && flags.strict) {
      const fallback = localAsGateResult(local, name, kind);
      if (sarif) {
        console.log(JSON.stringify(toSarif([{ ...fallback, path: relPath ?? name, ...(fullTarget ? { full: fullTarget } : {}) }]), null, 2));
        console.error(`  ${red('✗ Failing closed (--strict): backend unreachable, org policy unverified.')}`);
      } else printGateResult(fallback, 'local', flags);
      if (!flags.json) console.log(`  ${red('✗ Failing closed (--strict): backend unreachable, org policy unverified.')}\n`);
      process.exitCode = 1;
      return;
    }
  } else if (!flags.json) {
    console.error(`  ${dim('Not enrolled - on-machine analysis only. Run')} ${bold('nofly init')} ${dim('to also apply org policy.')}`);
  }

  let shownLocal = local;
  if (!serverVerdict) {
    const { local: withAdv, advisories } = await withMcpAdvisories(local, { content, path: relPath, kind, flags });
    shownLocal = withAdv;
    if (advisories === 'unavailable' && !flags.json) console.error(`  ${yellow('⚠')} ${dim('Advisory lookup (OSV) unreachable - pinned MCP packages were not checked for published CVEs.')}`);
  }
  const base = serverVerdict || localAsGateResult(shownLocal, name, kind);
  const carried = serverVerdict ? carriedPastMasking(local, sent, { kind, path: relPath }, serverVerdict.findings) : [];
  const result = mergeSastIntoResult(base, [...carried, ...collectLocalSast({ fullPath: fullTarget, relPath, kind, content, root: fullTarget ? locationBase(path.dirname(fullTarget)) : undefined }), ...fromBundle]);
  if (sarif) console.log(JSON.stringify(toSarif([{ ...result, path: relPath ?? name, ...(fullTarget ? { full: fullTarget } : {}) }]), null, 2));
  else printGateResult(result, serverVerdict ? 'server' : 'local', flags);

  if (result.decision === 'BLOCK') process.exitCode = 1;
  else if (result.decision === 'FLAG' && flags.strict) process.exitCode = 2;
}

async function cmdGateAll(flags, positional, { apiKey, url }) {

  const dirArg = typeof flags.all === 'string' ? flags.all : positional[0];
  const target = resolveScanTarget(dirArg);
  if (target.error) {
    console.error(`${red('✗')} ${target.error}`);
    process.exit(EXIT_USAGE);
  }
  const { root } = target;
  const env = detectEnv();
  const artifacts = target.single ? [target.single] : walkArtifacts(root);

  if (!artifacts.length) {
    if (flags.json) console.log(JSON.stringify({ scanned: 0, results: [] }, null, 2));
    else console.log(dim(`\n  No AI artifacts found under ${root}. Nothing to gate.\n`));
    return;
  }

  if (!flags.json && !flags.sarif) console.log(bold(cyan('\n  NoFly gate')) + dim(` - batch (${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''} · ${env.environment}${env.ciProvider ? ' · ' + env.ciProvider : ''})`));

  const outcome = await gateArtifactList(artifacts, { apiKey, url, env, flags, root });
  const { results, blocked, flagged, suppressed, backendDown, rejected } = outcome;

  const strictOutage = strictOutageOf(flags, outcome);

  if (flags.sarif) {
    console.log(JSON.stringify(toSarif(results), null, 2));
    process.exitCode = gateExitCode(flags, outcome);
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify({ scanned: results.length, blocked, flagged, suppressed, backendDown, rejected, environment: env.environment, results }, null, 2));
  } else {
    console.log(
      '\n  ' +
        (blocked > 0
          ? red(`✗ ${blocked} blocked`) + dim(` · ${flagged} flagged · ${results.length - blocked - flagged} allowed`)
          : flagged > 0
            ? yellow(`⚠ ${flagged} flagged`) + dim(` · ${results.length - flagged} allowed`)
            : green(`✓ All ${results.length} artifacts allowed.`)) +
        (suppressed ? dim(` · ${suppressed} suppressed`) : '') +
        (backendDown || !apiKey ? yellow('  (on-machine analysis - org policy not applied)') : dim(' - full activity in the NoFly dashboard → Gate Activity')) +
        '\n',
    );
    for (const entry of rejected) console.log(`  ${yellow('!')} ${dim(`${entry.path} (${entry.kind}) - the backend refused it, org policy not applied: ${entry.reason}`)}`);
    if (strictOutage) console.log(`  ${red('✗ Failing closed (--strict): backend unreachable or the credential was refused, org policy unverified.')}\n`);
  }

  process.exitCode = gateExitCode(flags, outcome);
}

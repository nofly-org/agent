import fs from 'node:fs';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, artifactKindOf, descendInto, resolveScanTarget, walkArtifacts, walkablePath } from '../artifacts/matchers.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { indexFilesUnder, readBlobs, resolveStagedEntry, stagedEntries, workingChanges } from '../core/git-changes.mjs';
import { bundledKind, byBundledPriority } from '../gate/sast.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { VERSION } from '../core/version.mjs';
import { gateArtifactList, gateExitCode, strictOutageOf } from '../gate/batch.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { toSarif } from '../gate/sarif.mjs';
import { findingFingerprint } from '../gate/suppressions.mjs';
import { fixOneFile } from './fix.mjs';

const MAX_SKILL_SCRIPTS = 60;

async function stagedSkillScripts(root, skillRel) {
  const dir = path.posix.dirname(skillRel);
  const entries = (indexFilesUnder(root, dir === '.' ? '' : dir) ?? [])
    .filter((e) => /^10(0644|0755)$/.test(e.mode))
    .filter((e) => {
      const inner = dir === '.' ? e.rel : e.rel.slice(dir.length + 1);
      const parts = inner.split('/');
      const name = parts[parts.length - 1];
      let parent = 'skills';
      for (const segment of parts.slice(0, -1)) {
        if (!descendInto(parent, segment)) return false;
        parent = `${parent}/${segment}`;
      }
      return !!bundledKind(name);
    })
    .sort(byBundledPriority)
    .slice(0, MAX_SKILL_SCRIPTS);
  const blobs = await readBlobs(root, entries.map((e) => e.oid), { maxBytes: MAX_ARTIFACT_BYTES });
  return entries
    .map((e) => ({ rel: path.relative(process.cwd(), path.join(root, ...e.rel.split('/'))).split(path.sep).join('/'), ...blobs.get(e.oid) }))
    .filter((s) => !s.unread);
}

async function stagedArtifacts(root, single) {
  const entries = stagedEntries(root);
  if (entries === null) return null;
  const artifacts = [];
  const wanted = [];
  for (const entry of entries) {
    if (single && entry.rel !== single.rel) continue;
    const kind = single ? single.kind ?? artifactKindOf(entry.rel) : artifactKindOf(entry.rel);
    if (!single && (!kind || !walkablePath(entry.rel))) continue;
    const resolved = await resolveStagedEntry(root, entry, { maxBytes: MAX_ARTIFACT_BYTES });
    if (resolved.dangling) continue;
    const artifact = { full: path.join(root, ...entry.rel.split('/')), rel: entry.rel, ...(kind ? { kind } : {}) };
    if (resolved.skip) {
      artifacts.push({ ...artifact, skip: resolved.skip });
      continue;
    }
    if (kind === 'skill') artifact.scripts = await stagedSkillScripts(root, entry.rel);
    artifacts.push(artifact);
    wanted.push([artifact, resolved.oid]);
  }
  const blobs = await readBlobs(root, wanted.map(([, oid]) => oid), { maxBytes: MAX_ARTIFACT_BYTES });
  for (const [artifact, oid] of wanted) artifact.read = blobs.get(oid);
  return artifacts;
}

async function artifactsInScope(root, single, flags) {
  const everything = () => (single ? [single] : walkArtifacts(root));
  if (!flags.staged && !flags.changed) return everything();
  if (flags.staged) {
    const staged = await stagedArtifacts(root, single);
    if (staged !== null) return staged;
  } else {
    const changed = workingChanges(root);
    if (changed !== null) {
      const changedSet = new Set(changed);
      return everything().filter((artifact) => changedSet.has(artifact.rel));
    }
  }
  if (!flags.json) console.error(`  ${yellow('⚠')} ${dim('not a git repo (or git unavailable) - checking the whole tree')}`);
  return everything();
}

function printNothingToCheck(flags, root) {
  if (flags.json) {
    console.log(JSON.stringify({ scanned: 0, blocked: 0, flagged: 0, results: [] }, null, 2));
    return;
  }
  const where = flags.staged || flags.changed ? ' in the changed set.' : ` under ${root}.`;
  console.log(`${green('\n  ✓ No AI artifacts to check')}${dim(where)}\n`);
}

function printHeader({ flags, artifacts, env, apiKey }) {
  if (flags.json || flags.sarif) return;

  const scope = flags.staged ? 'staged' : flags.changed ? 'changed' : env.environment;
  const provider = env.ciProvider ? ` · ${env.ciProvider}` : '';
  console.log(bold(cyan('\n  Shomra check')) + dim(` - ${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''} · ${scope}${provider}`));
  if (!apiKey) console.error(`  ${dim('On-machine analysis only - run')} ${bold('shomra init')} ${dim('to also apply org policy.')}`);
}

async function applyFixes({ results, flags, apiKey, url, blocked, flagged }) {
  if (!flags.fix || !(blocked || flagged)) return 0;

  if (!apiKey) {
    if (!flags.json) {
      console.error(`  ${yellow('⚠')} ${dim('--fix needs enrollment (the fix runs on the platform). Run')} ${bold('shomra init')}${dim('.')}`);
    }
    return 0;
  }

  if (!flags.json) console.log(dim('\n  Fixing flagged artifacts…'));
  let fixed = 0;
  for (const result of results) {
    if (result.decision === 'ALLOW' || result.notAnalyzed) continue;
    const done = await fixOneFile(result.full, { apiKey, url, flags: { ...flags, apply: true, quiet: flags.json, silent: !!flags.json } });
    if (done) fixed += 1;
  }
  return fixed;
}

function verdictLine({ blocked, flagged, suppressed, total }) {
  if (blocked) return red(`✗ ${blocked} blocked`) + dim(` · ${flagged} flagged · ${total - blocked - flagged} clean`);
  if (flagged) return yellow(`⚠ ${flagged} flagged`) + dim(` · ${total - flagged} clean`);
  if (suppressed) return green(`✓ ${total} passing`) + dim(' - nothing NEW; previously accepted findings are still there');
  return green(`✓ All ${total} clean.`);
}

function printSummary({ results, blocked, flagged, suppressed, backendDown, rejected, fixed, flags, strictOutage }) {
  const suppressedNote = suppressed ? dim(` · ${suppressed} accepted by baseline/ignore`) : '';
  const outageNote = backendDown ? yellow('  (on-machine only - org policy not applied)') : '';
  const rejectedNote = rejected.length
    ? yellow(`  (${rejected.length} artifact(s) the backend refused - org policy not applied to those)`)
    : '';

  console.log(`\n  ${verdictLine({ blocked, flagged, suppressed, total: results.length })}${suppressedNote}${outageNote}${rejectedNote}`);

  for (const entry of rejected) console.log(`  ${yellow('!')} ${dim(`${entry.path} (${entry.kind}) - ${entry.reason}`)}`);

  if (flags.fix && fixed) {
    console.log(`  ${green('✓')} ${dim(`applied ${fixed} fix${fixed > 1 ? 'es' : ''} - re-run`)} ${bold('shomra check')} ${dim('to confirm.')}`);
  } else if (!flags.fix && (blocked || flagged)) {
    console.log(dim('  Run ') + bold('shomra fix <file>') + dim(' or ') + bold('shomra check --fix') + dim(' to remediate.'));
  }
  if (strictOutage) console.log(`  ${red('✗ Failing closed (--strict): backend unreachable or the credential was refused, org policy unverified.')}`);
  console.log('');
}

function scanTargetOrExit(flags, positional) {
  const target = resolveScanTarget(positional[0] ?? flags.path);
  if (target.error) {
    console.error(`${red('✗')} ${target.error}`);
    process.exit(EXIT_USAGE);
  }
  return target;
}

export async function cmdCheck(flags, positional) {
  const { apiKey, url } = resolveSettings(loadConfig());
  const { root, single } = scanTargetOrExit(flags, positional);
  const env = detectEnv();

  const artifacts = await artifactsInScope(root, single, flags);
  if (!artifacts.length) {
    printNothingToCheck(flags, root);
    return;
  }

  printHeader({ flags, artifacts, env, apiKey });
  const outcome = await gateArtifactList(artifacts, { apiKey, url, env, flags, root });
  const { results, blocked, flagged, suppressed, backendDown, rejected } = outcome;
  const strictOutage = strictOutageOf(flags, outcome);

  if (flags.sarif) {
    console.log(JSON.stringify(toSarif(results), null, 2));
    if (strictOutage) console.error(`  ${red('✗ Failing closed (--strict): backend unreachable or the credential was refused, org policy unverified.')}`);
    process.exitCode = gateExitCode(flags, outcome);
    return;
  }

  const fixed = await applyFixes({ results, flags, apiKey, url, blocked, flagged });

  if (flags.json) {
    console.log(JSON.stringify({
      scanned: results.length, blocked, flagged, suppressed, fixed, backendDown, rejected,
      environment: env.environment, results,
    }, null, 2));
  } else {
    printSummary({ results, blocked, flagged, suppressed, backendDown, rejected, fixed, flags, strictOutage });
  }

  process.exitCode = gateExitCode(flags, outcome);
}

export async function cmdBaseline(flags, positional) {
  const { apiKey, url } = resolveSettings(loadConfig());
  const { root, single } = scanTargetOrExit(flags, positional);
  if (single) {
    console.error(`${red('✗')} baseline takes a folder, not a file.`);
    process.exit(EXIT_USAGE);
  }
  const env = detectEnv();

  const artifacts = walkArtifacts(root);
  if (!artifacts.length) {
    console.log(dim(`\n  No AI artifacts under ${root} - nothing to baseline.\n`));
    return;
  }
  if (!flags.json) {
    process.stdout.write(dim(`  Scanning ${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''} to baseline… `));
  }

  const { results } = await gateArtifactList(artifacts, {
    apiKey, url, env, root, flags: { ...flags, json: true, 'no-suppress': true },
  });

  const fingerprints = new Set();
  for (const result of results) {
    for (const finding of result.findings || []) fingerprints.add(findingFingerprint(result.path, finding));
  }

  const directory = path.join(root, '.shomra');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify({
    createdAt: new Date().toISOString(),
    agentVersion: VERSION,
    count: fingerprints.size,
    fingerprints: [...fingerprints],
  }, null, 2));

  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  if (flags.json) {
    console.log(JSON.stringify({ baseline: relative, count: fingerprints.size, artifacts: results.length }, null, 2));
    return;
  }
  console.log(green('done'));
  console.log(`\n  ${green('✓ Baseline written')} ${dim(`- ${fingerprints.size} finding(s) across ${results.length} artifact(s) accepted.`)}`);
  console.log(`${dim(`  ${relative} - commit it so your team shares the baseline. Only NEW findings will fail now.`)}\n`);
}

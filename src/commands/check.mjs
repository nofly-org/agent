import fs from 'node:fs';
import path from 'node:path';
import { resolveScanTarget, walkArtifacts } from '../artifacts/matchers.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { diffNames, stagedNames, workingChanges } from '../core/git-changes.mjs';
import { git } from '../core/git-exec.mjs';
import { listTree, resolveRev } from '../core/git-tree.mjs';
import { touchedArtifacts, treeArtifacts } from '../gate/scope.mjs';
import { trustedConfig } from '../gate/trusted.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { VERSION } from '../core/version.mjs';
import { gateArtifactList, gateExitCode, strictOutageOf } from '../gate/batch.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { toSarif } from '../gate/sarif.mjs';
import { findingFingerprint } from '../gate/suppressions.mjs';
import { fixOneFile } from './fix.mjs';
import { writeFileAtomic } from '../core/json-file.mjs';

async function stagedArtifacts(root, single) {
  const changed = stagedNames(root);
  if (changed === null) return null;
  const tree = listTree(root);
  if (tree === null) return null;
  return treeArtifacts(root, tree, { changed, single });
}

async function artifactsInScope(root, single, flags) {
  const everything = () => (single ? [single] : walkArtifacts(root));
  if (!flags.staged && !flags.changed) return everything();
  if (flags.staged) {
    const staged = await stagedArtifacts(root, single);
    if (staged !== null) return staged;
  } else {
    const changed = workingChanges(root);
    if (changed !== null) return touchedArtifacts(root, everything(), changed);
  }
  if (!flags.json) console.error(`  ${yellow('⚠')} ${dim('not a git repo (or git unavailable) - checking the whole tree')}`);
  return everything();
}

function printNothingToCheck(flags, root) {
  if (flags.json) {
    console.log(JSON.stringify({ scanned: 0, blocked: 0, flagged: 0, results: [] }, null, 2));
    return;
  }
  const where = flags.rev !== undefined ? ` in ${flags.rev}.` : flags.staged || flags.changed ? ' in the changed set.' : ` under ${root}.`;
  console.log(`${green('\n  ✓ No AI artifacts to check')}${dim(where)}\n`);
}

function printHeader({ flags, artifacts, env, apiKey }) {
  if (flags.json || flags.sarif) return;

  const scope = flags.rev !== undefined ? `commit ${flags.rev}` : flags.staged ? 'staged' : flags.changed ? 'changed' : env.environment;
  const provider = env.ciProvider ? ` · ${env.ciProvider}` : '';
  console.log(bold(cyan('\n  NoFly check')) + dim(` - ${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''} · ${scope}${provider}`));
  if (!apiKey) console.error(`  ${dim('On-machine analysis only - run')} ${bold('nofly init')} ${dim('to also apply org policy.')}`);
}

async function applyFixes({ results, flags, apiKey, url, blocked, flagged }) {
  if (!flags.fix || !(blocked || flagged)) return 0;

  if (!apiKey) {
    if (!flags.json) {
      console.error(`  ${yellow('⚠')} ${dim('--fix needs enrollment (the fix runs on the platform). Run')} ${bold('nofly init')}${dim('.')}`);
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
    console.log(`  ${green('✓')} ${dim(`applied ${fixed} fix${fixed > 1 ? 'es' : ''} - re-run`)} ${bold('nofly check')} ${dim('to confirm.')}`);
  } else if (!flags.fix && (blocked || flagged)) {
    console.log(dim('  Run ') + bold('nofly fix <file>') + dim(' or ') + bold('nofly check --fix') + dim(' to remediate.'));
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

function usageExit(message) {
  console.error(`${red('✗')} ${message}`);
  process.exit(EXIT_USAGE);
}

async function revisionScope(flags, positional) {
  if (flags.staged || flags.changed || flags.fix) usageExit('--rev checks a commit, so it cannot be combined with --staged, --changed or --fix.');
  const dir = path.resolve(typeof positional[0] === 'string' ? positional[0] : typeof flags.path === 'string' ? flags.path : '.');
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 5000 })?.trim();
  const root = top ? path.resolve(top) : dir;
  const sha = resolveRev(root, flags.rev);
  if (!sha) usageExit(`${flags.rev} is not a commit in the repository at ${root}.`);
  const base = flags['base-rev'] === undefined ? null : resolveRev(root, flags['base-rev']);
  if (flags['base-rev'] !== undefined && !base) usageExit(`${flags['base-rev']} is not a commit in the repository at ${root}.`);
  const tree = listTree(root, { rev: sha });
  const changed = base ? diffNames(root, [base, sha]) : null;
  if (!tree || (base && changed === null)) {
    console.error(`${red('✗')} Could not read ${sha} from git.`);
    process.exit(1);
  }
  const artifacts = await treeArtifacts(root, tree, { changed, carrier: `commit ${sha.slice(0, 12)}` });
  return { root, artifacts, trusted: trustedConfig(root, { baseRev: base ?? sha, fromTop: true }) };
}

export async function cmdCheck(flags, positional) {
  const { apiKey, url } = resolveSettings(loadConfig());
  const env = detectEnv();
  let root;
  let artifacts;
  let trusted;
  if (flags.rev !== undefined) {
    ({ root, artifacts, trusted } = await revisionScope(flags, positional));
  } else {
    const target = scanTargetOrExit(flags, positional);
    root = target.root;
    artifacts = await artifactsInScope(root, target.single, flags);
  }
  if (!artifacts.length) {
    printNothingToCheck(flags, root);
    return;
  }

  printHeader({ flags, artifacts, env, apiKey });
  const outcome = await gateArtifactList(artifacts, { apiKey, url, env, flags, root, trusted });
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

  const { results, acceptedLines } = await gateArtifactList(artifacts, {
    apiKey, url, env, root, acceptLines: true, flags: { ...flags, json: true, 'no-suppress': true },
  });

  const counts = {};
  const lines = {};
  results.forEach((result, index) => {
    for (const finding of result.findings || []) {
      const fp = findingFingerprint(result.path, finding);
      counts[fp] = (counts[fp] ?? 0) + 1;
    }
    Object.assign(lines, acceptedLines[index]);
  });
  const fingerprints = new Set(Object.keys(counts));

  const file = path.join(root, '.nofly', 'baseline.json');
  writeFileAtomic(file, JSON.stringify({
    createdAt: new Date().toISOString(),
    agentVersion: VERSION,
    count: fingerprints.size,
    fingerprints: [...fingerprints],
    counts,
    lines,
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

import { git } from '../core/git-exec.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { walkArtifacts } from '../artifacts/matchers.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { changedSinceBase, fetchCommit } from '../core/git-changes.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { gateArtifactList, gateExitCode, strictOutageOf } from '../gate/batch.mjs';
import { detectEnv } from '../gate/environment.mjs';
import { findingPath, locationBase, relativeToBase } from '../gate/locations.mjs';
import { toSarif } from '../gate/sarif.mjs';
import { touchedArtifacts } from '../gate/scope.mjs';
import { trustedConfig } from '../gate/trusted.mjs';

const PR_WORKFLOW = `name: Shomra AI Security
on: pull_request
permissions:
  contents: read
  checks: write
jobs:
  shomra:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # full history so the PR diff resolves
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx @shomra/agent pr
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SHOMRA_API_KEY: \${{ secrets.SHOMRA_API_KEY }}   # optional - applies org policy
          SHOMRA_URL: \${{ secrets.SHOMRA_URL }}           # optional - your backend
`;

function readGithubEvent() {
  try { return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { return {}; }
}

function githubApiBase() {
  const raw = String(process.env.GITHUB_API_URL || '').trim();
  if (!raw) return 'https://api.github.com';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
  }
  throw new Error(`GITHUB_API_URL "${raw}" is not an https URL`);
}

async function githubApi(token, method, apiPath, body) {
  const res = await fetch(`${githubApiBase()}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'shomra-agent' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${apiPath} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function pullRequestScope(root, { base, baseSha }) {
  const scope = changedSinceBase(root, { base, baseSha });
  if (scope || process.env.GITHUB_ACTIONS !== 'true' || !fetchCommit(root, baseSha)) return scope;
  return changedSinceBase(root, { base, baseSha });
}

const GH_LEVEL = { CRITICAL: 'failure', HIGH: 'failure', MEDIUM: 'warning', LOW: 'notice', INFO: 'notice' };

const CHECK_RUN_NAME = 'Shomra AI Security';
const MAX_ANNOTATIONS = 50;

function writeWorkflow(flags) {
  const workflow = path.resolve('.github/workflows/shomra.yml');
  if (fs.existsSync(workflow) && !flags.force) {
    console.error(`${red('✗')} ${path.relative(process.cwd(), workflow)} exists. Use ${bold('--force')}.`);
    process.exit(EXIT_USAGE);
  }
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, PR_WORKFLOW);
  console.log(`\n  ${green('✓ Wrote')} ${bold('.github/workflows/shomra.yml')} ${dim('- commit it; PRs will get an inline Shomra review.')}`);
  console.log(`${dim('  Optional: add ') + bold('SHOMRA_API_KEY') + dim(' as a repo secret to also apply org policy.')}\n`);
}

function headShaFromGit() {
  return git(['rev-parse', 'HEAD'])?.trim() || null;
}

function resolvePrContext(flags) {
  const event = readGithubEvent();
  const context = {
    repo: flags.repo || process.env.GITHUB_REPOSITORY,
    token: flags.token || process.env.SHOMRA_GH_TOKEN || process.env.GITHUB_TOKEN,
    base: flags.base || process.env.GITHUB_BASE_REF || event.pull_request?.base?.ref || 'main',
    baseSha: flags.base ? null : event.pull_request?.base?.sha || null,
    headSha: flags.sha || event.pull_request?.head?.sha || process.env.GITHUB_SHA || headShaFromGit(),
    prNumber: flags.pr || event.pull_request?.number || (String(process.env.GITHUB_REF || '').match(/refs\/pull\/(\d+)\//) || [])[1],
    root: path.resolve(flags.path || '.'),
    dryRun: !!flags['dry-run'],
  };

  if (!context.repo || !context.headSha) {
    console.error(`${red('✗')} Not in a GitHub PR context (need GITHUB_REPOSITORY + a head sha). Pass --repo / --sha, or use --dry-run.`);
    process.exit(EXIT_USAGE);
  }
  if (!context.token && !context.dryRun) {
    console.error(`${red('✗')} No GitHub token. Set GITHUB_TOKEN (CI) or --token, or preview with --dry-run.`);
    process.exit(EXIT_USAGE);
  }
  return context;
}

function emitSarif(flags, results) {
  if (!flags.sarif) return;
  const sarif = JSON.stringify(toSarif(results), null, 2);
  if (typeof flags.sarif === 'string') {
    fs.writeFileSync(path.resolve(String(flags.sarif)), sarif);
    if (!flags.json) console.error(dim(`  SARIF written → ${flags.sarif}`));
    return;
  }
  console.log(sarif);
}

function buildAnnotations(results, base) {
  const annotations = [];
  for (const result of results) {
    for (const finding of result.findings || []) {
      annotations.push({
        path: relativeToBase(findingPath(result, finding), base) ?? (finding.file || result.path),
        start_line: finding.line || 1,
        end_line: finding.line || 1,
        annotation_level: GH_LEVEL[finding.severity] || 'warning',
        title: `${finding.severity}: ${result.kind}`,
        message: [
          finding.title,
          finding.remediationText ? `Fix: ${finding.remediationText}` : '',
          finding.suppressionRefused ? `Not suppressed: ${finding.suppressionRefused}.` : '',
          `Run \`shomra fix ${result.path}\` to remediate.`,
        ].filter(Boolean).join('\n'),
      });
    }
  }
  return annotations;
}

function checkRunConclusion(blocked, flagged, strict, strictOutage) {
  if (blocked || strictOutage) return 'failure';
  if (flagged) return strict ? 'failure' : 'neutral';
  return 'success';
}

function checkRunSummary({ results, annotations, blocked, flagged, suppressed, notes }) {
  const headline = blocked ? `**${blocked} blocked**` : flagged ? `**${flagged} flagged**` : '**All clear**';
  const suppressedNote = suppressed ? ` · ${suppressed} suppressed` : '';
  return [
    headline,
    `· ${results.length} artifact(s) changed · ${annotations.length} finding(s)${suppressedNote}`,
    ...notes.map((note) => `\n> ${note}`),
    '',
    '| Artifact | Kind | Verdict | Findings |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| \`${r.path}\` | ${r.kind} | ${r.decision}${r.suppressionNote ? ` (${r.suppressionNote})` : ''} | ${(r.findings || []).length} |`),
    annotations.length > MAX_ANNOTATIONS ? `\n_Showing first ${MAX_ANNOTATIONS} of ${annotations.length} annotations._` : '',
  ].join('\n');
}

function buildCheckRun({ headSha, results, annotations, blocked, flagged, suppressed, strict, strictOutage, notes }) {
  const verdict = blocked ? `${blocked} blocked` : flagged ? `${flagged} flagged` : strictOutage ? 'Org policy unverified' : 'Clean';
  return {
    name: CHECK_RUN_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion: checkRunConclusion(blocked, flagged, strict, strictOutage),
    output: {
      title: `${verdict} - ${results.length} changed artifact(s)`,
      summary: checkRunSummary({ results, annotations, blocked, flagged, suppressed, notes }),
      annotations: annotations.slice(0, MAX_ANNOTATIONS),
    },
  };
}

function runNotes({ scope, base, outcome, strictOutage }) {
  const notes = [];
  if (!scope) notes.push(`The base branch "${base}" was not found in this checkout, so every AI artifact was checked and no suppression, baseline or repo policy was trusted. Check out full history (fetch-depth: 0) to check only what the pull request changed.`);
  if (outcome.backendDown || outcome.authFailed) notes.push(`Org policy was not applied: the Shomra backend was unreachable or refused the credential${strictOutage ? ', so this check fails closed (--strict)' : ''}.`);
  for (const entry of outcome.rejected || []) notes.push(`The backend refused \`${entry.path}\` (${entry.reason}), so org policy was not applied to it.`);
  return notes;
}

async function postCheckRun(token, repo, checkRun, flags) {
  try {
    const run = await githubApi(token, 'POST', `/repos/${repo}/check-runs`, checkRun);
    if (flags.json || flags.sarif === true) return;
    const mark = checkRun.conclusion === 'failure' ? red('✗') : checkRun.conclusion === 'neutral' ? yellow('⚠') : green('✓');
    console.log(`  ${mark} Check run posted → ${dim(run.html_url || '')}`);
  } catch (error) {
    console.error(`  ${yellow('⚠')} ${dim(`could not post check-run: ${error.message}`)}`);
  }
}

async function reportNothingChanged({ flags, token, dryRun, repo, headSha, prNumber, base, scope }) {
  emitSarif(flags, []);
  if (flags.json && flags.sarif !== true) {
    console.log(JSON.stringify({ repo, prNumber: prNumber ?? null, headSha, base, comparedWith: scope?.against ?? null, conclusion: 'success', artifacts: 0, findings: 0, notes: [] }, null, 2));
  } else if (flags.sarif !== true) console.log(green('\n  ✓ No AI artifacts changed in this PR.\n'));
  if (!token || dryRun) return;

  await githubApi(token, 'POST', `/repos/${repo}/check-runs`, {
    name: CHECK_RUN_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    output: {
      title: 'No AI artifacts changed',
      summary: 'No MCP configs, skills, rules, hooks or agent cards changed in this PR.',
    },
  }).catch((error) => console.error(dim(`  check-run: ${error.message}`)));
}

export async function cmdPr(flags, positional) {
  if (flags.init) {
    writeWorkflow(flags);
    return;
  }

  const { apiKey, url } = resolveSettings(loadConfig());
  const { repo, token, base, baseSha, headSha, prNumber, root, dryRun } = resolvePrContext(flags);
  const quiet = flags.json || flags.sarif === true;

  const scope = pullRequestScope(root, { base, baseSha });
  if (!scope && !quiet) {
    console.error(`  ${yellow('⚠')} ${dim(`base branch "${base}" not found in this checkout - checking every AI artifact, without trusting suppressions or repo policy. Use fetch-depth: 0 to check only the pull request's changes.`)}`);
  }
  const allArtifacts = walkArtifacts(root);
  const artifacts = scope ? touchedArtifacts(root, allArtifacts, scope.files) : allArtifacts;

  if (!artifacts.length) {
    await reportNothingChanged({ flags, token, dryRun, repo, headSha, prNumber, base, scope });
    return;
  }

  const outcome = await gateArtifactList(artifacts, {
    apiKey, url, root, env: detectEnv(), flags: { ...flags, json: true }, trusted: trustedConfig(root, scope),
  });
  const { results, blocked, flagged, suppressed } = outcome;
  const strictOutage = strictOutageOf(flags, outcome);
  emitSarif(flags, results);

  const annotations = buildAnnotations(results, locationBase(root));
  const notes = runNotes({ scope, base, outcome, strictOutage });
  const checkRun = buildCheckRun({ headSha, results, annotations, blocked, flagged, suppressed, strict: flags.strict, strictOutage, notes });

  if ((dryRun || flags.json) && flags.sarif !== true) {
    console.log(JSON.stringify({
      repo,
      prNumber: prNumber ?? null,
      headSha,
      base,
      comparedWith: scope?.against ?? null,
      conclusion: checkRun.conclusion,
      artifacts: results.length,
      findings: annotations.length,
      backendDown: !!outcome.backendDown,
      rejected: outcome.rejected,
      notes,
      checkRun: dryRun ? checkRun : undefined,
    }, null, 2));
  } else if (flags.sarif !== true) {
    console.log(bold(cyan('\n  Shomra pr')) + dim(` - ${repo} #${prNumber ?? '?'} · ${results.length} changed artifact(s) · ${annotations.length} finding(s)`));
    for (const note of notes) console.log(`  ${yellow('⚠')} ${dim(note)}`);
  }

  if (token && !dryRun) await postCheckRun(token, repo, checkRun, flags);

  process.exitCode = gateExitCode(flags, outcome);
}

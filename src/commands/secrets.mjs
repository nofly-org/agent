import { git, gitLines } from '../core/git-exec.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIRS, readRegularFile, resolveScanTarget } from '../artifacts/matchers.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { clampInt } from '../core/numbers.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { SECRET_PATTERNS, localScan } from '../detect/guard-signals.mjs';

const MAX_FILES = 50000;
const MAX_SECRET_FILE_BYTES = 8 * 1024 * 1024;
const HISTORY_TIMEOUT_MS = 600000;

function redactSecret(s) {
  const t = String(s).trim();
  return t.length <= 8 ? t[0] + '••••' : `${t.slice(0, 4)}…${t.slice(-2)}`;
}

function isGitRepo(root) {
  return git(['rev-parse', '--is-inside-work-tree'], { cwd: root }) !== null;
}

export function walkFiles(root, cap = MAX_FILES) {
  const found = [];
  const stack = [root];
  let capped = false;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name) && ent.name !== '.git') stack.push(path.join(dir, ent.name)); continue; }
      if (found.length >= cap) {
        capped = true;
        break;
      }
      found.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/'));
    }
    if (capped) break;
  }
  found.capped = capped;
  return found;
}

function scanFile(root, rel) {
  const read = readRegularFile(path.join(root, rel), MAX_SECRET_FILE_BYTES);
  if (read.skip) return { skipped: read.skip === 'too large' ? 'too large' : read.skip === 'not a regular file' ? 'special' : 'unreadable' };
  const { content } = read;
  if (content.includes('\0')) return { hits: [] };
  const byLine = new Map();
  for (const f of localScan(content, { categories: ['secret'] }).findings) {
    const label = f.label.replace(/^Live credential:\s*/, '');
    const key = f.line ?? 0;
    const prior = byLine.get(key);
    if (prior) {
      if (!prior.secret.split(', ').includes(label)) prior.secret = `${prior.secret}, ${label}`;
    } else byLine.set(key, { where: 'working-tree', file: rel, line: f.line, secret: label });
  }
  return { hits: [...byLine.values()] };
}

async function scanGitHistory(root, depth) {
  const hits = [];
  const seen = new Set();
  let commit = '';
  let file = '';
  const result = await gitLines(['log', '--all', '-p', '-n', String(depth), '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H %an %ad'], {
    cwd: root,
    timeout: HISTORY_TIMEOUT_MS,
    onLine: (line) => {
      if (line.startsWith('commit ')) { commit = line.slice(7, 19); return; }
      if (line.startsWith('+++ b/')) { file = line.slice(6); return; }
      if (line[0] !== '+' || line.startsWith('+++')) return;
      const added = line.slice(1, 20001);
      for (const { name, re } of SECRET_PATTERNS) {
        const m = added.match(re);
        if (!m) continue;
        const key = `${commit}:${file}:${m[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ where: 'history', commit, file, secret: name, sample: redactSecret(m[0]) });
      }
    },
  });
  return result.ok ? { hits } : { hits, error: result.reason };
}

export async function cmdSecrets(flags, positional) {
  const target = resolveScanTarget(positional[0] ?? flags.path);
  if (target.error) {
    console.error(`${red('✗')} ${target.error}`);
    process.exit(EXIT_USAGE);
  }
  const root = target.root;
  const files = target.single ? [target.single.rel] : walkFiles(root);
  const capped = !target.single && files.capped;
  const hits = [];
  const skipped = { 'too large': 0, unreadable: 0, special: 0 };
  for (const rel of files) {
    const scanned = scanFile(root, rel);
    if (scanned.skipped) skipped[scanned.skipped] += 1;
    else hits.push(...scanned.hits);
  }
  const isGit = isGitRepo(root);
  let history = null;
  if (flags.history && isGit) history = await scanGitHistory(root, clampInt(flags.depth, 300, 1, 5000));
  if (history) hits.push(...history.hits);
  const incomplete = [
    ...(capped ? [`stopped after ${MAX_FILES} files - scan a narrower folder to cover the rest`] : []),
    ...(skipped['too large'] ? [`${skipped['too large']} file(s) over ${MAX_SECRET_FILE_BYTES / (1024 * 1024)} MB were not scanned`] : []),
    ...(skipped.unreadable ? [`${skipped.unreadable} file(s) could not be read`] : []),
    ...(history?.error ? [`the git history scan failed (${history.error}) - history was not fully checked`] : []),
    ...(flags.history && !isGit ? ['not a git repository, so there is no history to scan'] : []),
  ];
  if (hits.length || (incomplete.length && flags.strict)) process.exitCode = 1;

  if (flags.json) {
    console.log(JSON.stringify({
      workingTree: hits.filter((h) => h.where === 'working-tree').length,
      history: history ? history.hits.length : null,
      filesScanned: files.length - skipped['too large'] - skipped.unreadable - skipped.special,
      filesSkipped: skipped['too large'] + skipped.unreadable,
      complete: !incomplete.length,
      incomplete,
      hits,
    }, null, 2));
    return;
  }

  console.log(bold(cyan('\n  Shomra secrets')) + dim(` - ${path.relative(process.cwd(), target.single ? target.single.full : root).split(path.sep).join('/') || '.'}${flags.history ? ' · working tree + git history' : ' · working tree'}`));
  if (!isGit) console.log(dim('  (not a git repo - working tree only; --history unavailable)'));
  else if (!flags.history) console.log(dim('  Tip: add ') + bold('--history') + dim(' to also scan past commits (a leaked key removed from HEAD is still live).'));
  for (const note of incomplete) console.log(`  ${yellow('⚠')} ${dim(note)}`);
  const wt = hits.filter((h) => h.where === 'working-tree');
  const hi = hits.filter((h) => h.where === 'history');
  if (!hits.length) {
    console.log(incomplete.length ? yellow('\n  ⚠ No secret-shaped values found in what was scanned - the scan was incomplete.\n') : green('\n  ✓ No secret-shaped values found.\n'));
    return;
  }
  if (wt.length) {
    console.log(red(`\n  ${wt.length} in the working tree:`));
    for (const h of wt.slice(0, 25)) console.log(`    ${red('●')} ${bold(h.file)}${h.line ? dim(':' + h.line) : ''} ${dim(h.secret)}`);
    if (wt.length > 25) console.log(dim(`    … and ${wt.length - 25} more (run with --json for all)`));
  }
  if (hi.length) {
    console.log(yellow(`\n  ${hi.length} in git history ${dim('(rotate - still reachable):')}`));
    for (const h of hi.slice(0, 25)) console.log(`    ${yellow('●')} ${dim(h.commit)} ${bold(h.file)} ${dim(h.secret + ' ' + (h.sample || ''))}`);
    if (hi.length > 25) console.log(dim(`    … and ${hi.length - 25} more (run with --json for all)`));
  }
  console.log(dim(`\n  Rotate every matched credential now. A committed secret is compromised even after you delete it - history keeps it.\n`));
}

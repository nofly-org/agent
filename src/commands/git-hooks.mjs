import fs from 'node:fs';
import path from 'node:path';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { git } from '../core/git-exec.mjs';
import { bold, dim, green, red, yellow } from '../core/terminal.mjs';

export async function cmdInstallPrecommit(flags, positional) {

  if (flags['pre-receive']) return installPreReceive(flags, positional);
  const root = path.resolve(positional[0] || '.');
  const hooksDir = gitHooksDir(root);
  if (!hooksDir) {
    console.error(red('✗') + ' Not a git repository (or git unavailable). cd into your repo first.');
    process.exit(EXIT_USAGE);
  }
  const hookPath = path.join(hooksDir, 'pre-commit');
  const marker = 'shomra check --staged';
  const managed = [
    '#!/bin/sh',
    '# Shomra - block staged AI artifacts that fail the gate before they land.',
    '# Managed by `shomra install-precommit`. Delete this file to uninstall.',

    'command -v shomra >/dev/null 2>&1 || {',
    '  echo "" >&2',
    '  echo "!! ============================================================== !!" >&2',
    '  echo "!!  WARNING: shomra not on PATH - the AI-artifact gate DID NOT RUN !!" >&2',
    '  echo "!!  Staged MCP/skill/rules files were committed UNGATED.          !!" >&2',
    '  echo "!!  Fix: npm i -g @shomra/agent   (then re-commit to gate)        !!" >&2',
    '  echo "!! ============================================================== !!" >&2',
    '  echo "" >&2',
    '  exit 0',
    '}',
    'shomra check --staged',
    'if [ "$?" -eq 1 ]; then',
    '  echo "✗ Shomra blocked a staged AI artifact - run: shomra fix <file> --apply  (or: git commit --no-verify to override)"',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n');

  let existing = null;
  try {
    existing = fs.readFileSync(hookPath, 'utf8');
  } catch {}

  if (existing && existing.includes(marker) && !flags.force) {
    console.log(green('  ✓') + ' Shomra pre-commit hook already installed ' + dim('→ ' + hookPath));
    return;
  }
  if (existing && !existing.includes(marker) && !flags.force) {
    console.log('\n  ' + yellow('⚠') + ' A pre-commit hook already exists ' + dim('→ ' + hookPath));
    console.log('  Add this line to it, or re-run with ' + bold('--force') + ' to replace it (a backup is kept):');
    console.log('    ' + bold(marker) + '\n');
    return;
  }
  if (existing && flags.force && !existing.includes(marker)) {
    const kept = keepHookBackup(hookPath, existing);
    if (!kept) {
      console.error(red('✗') + ` Could not back up the existing hook at ${hookPath} - nothing was changed.`);
      process.exit(1);
    }
    console.log(dim('  Backed up existing hook → ' + path.basename(kept)));
  }
  fs.writeFileSync(hookPath, managed, 'utf8');
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {}
  console.log('\n  ' + green('✓ Installed') + ' Shomra pre-commit hook ' + dim('→ ' + hookPath));
  console.log(dim('  Staged AI artifacts are now gated on every commit. Override once with ') + bold('git commit --no-verify') + dim('.\n'));
}

function installPreReceive(flags, positional) {
  const root = path.resolve(positional[0] || flags.path || '.');

  const dir = gitHooksDir(root);
  if (!dir) {
    console.error(red('✗') + ` No git hooks directory under ${root}. Point this at a BARE repository (the one the server hosts), not a working checkout.`);
    process.exit(EXIT_USAGE);
  }

  const hookPath = path.join(dir, 'pre-receive');
  const ownedBy = 'Managed by `shomra install-precommit --pre-receive`';
  const managed = [
    '#!/bin/sh',
    '# Shomra - refuse a push that carries a blocked AI artifact.',
    `# ${ownedBy}. Delete this file to uninstall.`,
    '#',
    '# Runs on the SERVER, so unlike pre-commit it cannot be skipped with',
    '# --no-verify and it covers developers who never installed anything.',
    '',
    '# ⚠ FAIL CLOSED. The client-side hook fails open on a missing binary because',
    '# blocking a local commit over a tooling problem is hostile. The opposite is',
    '# true here: this is the enforcement point, so an environment that cannot run',
    '# the check must refuse the push rather than wave it through - otherwise',
    '# deleting the binary is the bypass.',
    'command -v shomra >/dev/null 2>&1 || {',
    '  echo "" >&2',
    '  echo "REJECTED: shomra is not installed on this git server, so the AI-artifact" >&2',
    '  echo "          gate could not run. Install it (npm i -g @shomra/agent) or" >&2',
    '  echo "          remove this hook deliberately." >&2',
    '  exit 1',
    '}',
    '',
    'STATUS=0',
    '',
    '# stdin is "<old> <new> <ref>" per pushed ref. What each push changes is read',
    '# straight from git - no checkout, so a pushed .gitattributes cannot change',
    '# what is read - and waivers (.shomraignore, baseline, ignore marks, repo',
    '# policy) count only as they stood before the push.',
    'while read -r oldrev newrev refname; do',
    '  # All-zero newrev = branch deletion. Nothing arrives, nothing to gate.',
    '  case "$newrev" in *[!0]*) ;; *) continue ;; esac',
    '  case "$oldrev" in',
    '    *[!0]*) BASE="$oldrev" ;;',
    '    *) BASE=$(git merge-base HEAD "$newrev" 2>/dev/null || true) ;;',
    '  esac',
    '  if [ -n "$BASE" ]; then',
    '    shomra check --rev "$newrev" --base-rev "$BASE" && continue',
    '  else',
    '    shomra check --rev "$newrev" --no-suppress --no-policy && continue',
    '  fi',
    '  echo "" >&2',
    '  echo "REJECTED: $refname carries an AI artifact Shomra blocks (see above)." >&2',
    '  echo "          Fix it locally (shomra check --fix) and push again." >&2',
    '  STATUS=1',
    'done',
    '',
    'exit $STATUS',
    '',
  ].join('\n');

  let existing = null;
  try { existing = fs.readFileSync(hookPath, 'utf8'); } catch {  }
  const ours = existing !== null && (existing.includes(ownedBy) || existing.includes('shomra gate --all'));
  if (existing === managed) {
    console.log(green('  ✓') + ' Shomra pre-receive hook already installed ' + dim('→ ' + hookPath));
    return;
  }
  if (existing !== null && !ours && !flags.force) {
    console.log('\n  ' + yellow('⚠') + ' A pre-receive hook already exists ' + dim('→ ' + hookPath));
    console.log('  Chain Shomra into it, or re-run with ' + bold('--force') + ' to replace it (a backup is kept).\n');
    return;
  }
  if (existing !== null && !ours) {
    const kept = keepHookBackup(hookPath, existing);
    if (!kept) {
      console.error(red('✗') + ` Could not back up the existing hook at ${hookPath} - nothing was changed.`);
      process.exit(1);
    }
    console.log(dim('  Backed up existing hook → ' + path.basename(kept)));
  }
  if (git(['rev-parse', '--is-bare-repository'], { cwd: root, timeout: 3000 })?.trim() === 'false') {
    console.log(dim('  Note: this is a working checkout, so the hook runs only for pushes into it. Install it in the bare repository your git server hosts.'));
  }
  fs.writeFileSync(hookPath, managed, 'utf8');
  try { fs.chmodSync(hookPath, 0o755); } catch {  }

  if (ours) {
    console.log('\n  ' + green('✓ Updated') + ' Shomra pre-receive hook ' + dim('→ ' + hookPath));
    console.log(dim('  Pushed commits are now read straight from git, and waivers are taken from before the push.\n'));
    return;
  }
  console.log('\n  ' + green('✓ Installed') + ' Shomra pre-receive hook ' + dim('→ ' + hookPath));
  console.log(dim('  Every push is now gated server-side - no --no-verify, and no per-developer install.'));
  console.log(dim('  This hook FAILS CLOSED: if shomra is missing on the server, pushes are refused.'));
  console.log(dim('  GitHub.com has no server-side hooks - there, use the Action as a required status check.\n'));
}

function keepHookBackup(hookPath, text) {
  for (let n = 0; n < 50; n++) {
    const name = n ? `${hookPath}.bak.${n}` : `${hookPath}.bak`;
    try {
      fs.writeFileSync(name, text, { flag: 'wx', mode: 0o755 });
      return name;
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
    }
  }
  return null;
}

function gitHooksDir(root) {
  try {
    const dir = git(['rev-parse', '--git-path', 'hooks'], { cwd: root, timeout: 3000 })?.trim();
    if (!dir) return null;
    const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  } catch {
    return null;
  }
}

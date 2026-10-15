import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-managed-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const image = path.join(root, 'image');
  for (const d of [home, repo, image]) fs.mkdirSync(d);
  return { root, home, repo, image };
}

function cli(box, args) {
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home, NO_COLOR: '1', NOFLY_MANAGED_ROOT: box.image };
  for (const k of Object.keys(env)) if (k.startsWith('NOFLY_') && k !== 'NOFLY_MANAGED_ROOT') delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { cwd: box.repo, env, encoding: 'utf8', timeout: 30000 });
}

const inImage = (box, rel) => path.join(box.image, rel);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a managed install writes each agent\'s machine-wide policy file, readable by every user', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  try {
    const out = cli(box, ['install-hook', '--managed']);
    assert.equal(out.status, 0, out.stderr);
    const claude = inImage(box, 'etc/claude-code/managed-settings.d/50-nofly.json');
    const codex = inImage(box, 'etc/codex/hooks.json');
    const copilot = inImage(box, 'etc/github-copilot/policy.d/50-nofly.json');
    const c = read(claude);
    assert.match(c.hooks.PreToolUse[0].matcher, /\bMonitor\b/);
    assert.match(JSON.stringify(c.hooks), /tool-guard --agent claude/);
    assert.match(JSON.stringify(c.hooks.SessionStart), /session-guard --agent claude/);
    assert.ok(!JSON.stringify(c).includes('npx'), 'a managed hook runs the machine install, not npm');
    assert.match(JSON.stringify(read(codex).hooks.PreToolUse), /tool-guard --agent codex/);
    assert.equal(read(copilot).version, 1);
    for (const f of [claude, codex, copilot]) assert.equal(fs.statSync(f).mode & 0o777, 0o644, f);
    assert.match(out.stdout, /cannot remove them/);
    const again = cli(box, ['install-hook', '--managed']);
    assert.match(again.stdout, /already installed/);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('a managed Codex install keeps the hooks already in /etc/codex/hooks.json, and uninstall takes only its own', () => {
  const box = sandbox();
  try {
    const codex = inImage(box, 'etc/codex/hooks.json');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/audit-stop' }] }] } };
    fs.writeFileSync(codex, JSON.stringify(theirs));
    assert.equal(cli(box, ['install-hook', '--managed', '--agent', 'codex']).status, 0);
    const merged = read(codex);
    assert.deepEqual(merged.hooks.Stop, theirs.hooks.Stop);
    assert.match(JSON.stringify(merged.hooks.PreToolUse), /tool-guard --agent codex/);
    assert.equal(cli(box, ['install-hook', '--managed', '--uninstall', '--agent', 'codex']).status, 0);
    assert.deepEqual(read(codex), theirs);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('managed uninstall removes the drop-in files, and an agent with no machine-wide location says so', () => {
  const box = sandbox();
  try {
    assert.equal(cli(box, ['install-hook', '--managed', '--agent', 'claude,copilot']).status, 0);
    const out = cli(box, ['install-hook', '--managed', '--uninstall', '--agent', 'claude,copilot']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(fs.existsSync(inImage(box, 'etc/claude-code/managed-settings.d/50-nofly.json')), false);
    assert.equal(fs.existsSync(inImage(box, 'etc/github-copilot/policy.d/50-nofly.json')), false);
    const cursor = cli(box, ['install-hook', '--managed', '--agent', 'cursor']);
    assert.match(cursor.stdout, /no machine-wide hook location/);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('the MDM script installs the managed firewall only when asked to', () => {
  const box = sandbox();
  try {
    const plain = cli(box, ['admin', 'mdm-script', '--os', 'linux', '--url', 'https://nofly.example']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!plain.stdout.includes('install-hook --managed'));
    const guarded = cli(box, ['admin', 'mdm-script', '--os', 'macos', '--url', 'https://nofly.example', '--guard']);
    assert.match(guarded.stdout, /"\$NODE" "\$ENTRY" install-hook --managed/);
    const windows = cli(box, ['admin', 'mdm-script', '--os', 'windows', '--url', 'https://nofly.example', '--guard']);
    assert.match(windows.stdout, /& \$Node \$Entry install-hook --managed/);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('status and selftest see a managed install as installed', async () => {
  const box = sandbox();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ROOT: process.env.NOFLY_MANAGED_ROOT };
  const cwd = process.cwd();
  try {
    assert.equal(cli(box, ['install-hook', '--managed', '--agent', 'claude']).status, 0);
    process.env.HOME = box.home;
    process.env.USERPROFILE = box.home;
    process.env.NOFLY_MANAGED_ROOT = box.image;
    process.chdir(box.repo);
    const { agentHookInstalled } = await import('../src/agents/hook-files.mjs');
    assert.deepEqual(agentHookInstalled('claude'), [inImage(box, 'etc/claude-code/managed-settings.d/50-nofly.json')]);
    const { staticCheck } = await import('../src/selftest/static-checks.mjs');
    const row = staticCheck('claude');
    assert.equal(row.state, 'ok', row.statement);
    assert.equal(row.installs[0].scope, 'machine');
  } finally {
    process.chdir(cwd);
    for (const [k, v] of [['HOME', prev.HOME], ['USERPROFILE', prev.USERPROFILE], ['NOFLY_MANAGED_ROOT', prev.ROOT]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

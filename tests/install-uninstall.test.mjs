import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardHookTamper } from '../src/guard/self-protect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'shomra.mjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-install-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  return { root, home, repo };
}

function cli(box, args) {
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('SHOMRA_')) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { cwd: box.repo, env, encoding: 'utf8', timeout: 30000 });
}

const AGENT_FILES = [
  '.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '.cursor/hooks.json',
  '.windsurf/hooks.json', '.github/hooks/shomra.json', '.cline/hooks.json', '.aider.conf.yml',
];

test('install then uninstall for every agent leaves no Shomra hook and no file it created', () => {
  const box = sandbox();
  try {
    const install = cli(box, ['install-hook', '--agent', 'all']);
    assert.equal(install.status, 0, install.stderr);
    for (const f of AGENT_FILES) assert.ok(fs.existsSync(path.join(box.repo, f)), `${f} was installed`);
    const uninstall = cli(box, ['install-hook', '--uninstall']);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    for (const f of AGENT_FILES) assert.equal(fs.existsSync(path.join(box.repo, f)), false, `${f} should be gone`);
    const again = cli(box, ['install-hook', '--uninstall']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /No Shomra hooks found/);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('uninstall keeps the user\'s own hooks, settings and aider config', () => {
  const box = sandbox();
  try {
    const claudeFile = path.join(box.repo, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    const mine = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/lint-hook.sh' }] }] },
    };
    fs.writeFileSync(claudeFile, JSON.stringify(mine, null, 2));
    const aiderFile = path.join(box.repo, '.aider.conf.yml');
    fs.writeFileSync(aiderFile, 'model: gpt-4o\nauto-commits: false\n');

    assert.equal(cli(box, ['install-hook', '--agent', 'claude,aider']).status, 0);
    const installed = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    assert.ok(JSON.stringify(installed).includes('tool-guard'));

    assert.equal(cli(box, ['install-hook', '--uninstall', '--agent', 'claude,aider']).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), mine);
    assert.equal(fs.readFileSync(aiderFile, 'utf8'), 'model: gpt-4o\nauto-commits: false\n');
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('a settings file with comments is refused and left alone, and the other agents are still installed', () => {
  const box = sandbox();
  try {
    const gemini = path.join(box.repo, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(gemini), { recursive: true });
    const text = '{\n  // my theme\n  "theme": "dark",\n}\n';
    fs.writeFileSync(gemini, text);
    const out = cli(box, ['install-hook', '--agent', 'all']);
    assert.equal(out.status, 1, 'a partial install must not exit 0');
    assert.match(out.stderr, /Gemini CLI: .*settings\.json is not valid JSON/);
    assert.equal(fs.readFileSync(gemini, 'utf8'), text);
    assert.ok(fs.existsSync(path.join(box.repo, '.claude', 'settings.json')), 'Claude Code was still protected');
    assert.ok(fs.existsSync(path.join(box.repo, '.cursor', 'hooks.json')), 'Cursor was still protected');
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('a settings file whose hooks are not an object is refused in words, not with a stack trace', () => {
  const box = sandbox();
  try {
    const file = path.join(box.repo, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: 'none' }));
    const out = cli(box, ['install-hook', '--agent', 'claude']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"hooks" is not an object/);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ hooks: 'none' }));
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('an existing settings file keeps its permissions when the hook is installed', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  try {
    const file = path.join(box.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o600);
    assert.equal(cli(box, ['install-hook', '--agent', 'claude', '--global']).status, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('an agent that runs the uninstall itself is treated as switching the guard off', () => {
  const hit = guardHookTamper('Bash', { command: 'npx -y @shomra/agent@0.3.39 install-hook --uninstall --global' });
  assert.equal(hit?.why, 'uninstall');
  assert.equal(guardHookTamper('Bash', { command: 'shomra install-hook --agent all' }), null);
});

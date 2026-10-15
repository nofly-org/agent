import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'shomra.mjs');
const WINDOWS = process.platform === 'win32';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-odd-'));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    input: '',
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, NO_COLOR: '1', SHOMRA_URL: 'http://127.0.0.1:1', SHOMRA_OFFLINE: '1' },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { dir, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a command given a named pipe says so instead of waiting on it', { skip: WINDOWS }, () => {
  const s = sandbox();
  try {
    spawnSync('mkfifo', [path.join(s.dir, 'fifo.md')]);
    for (const args of [
      ['plan', 'fifo.md'],
      ['why', 'fifo.md'],
      ['design', 'fifo.md'],
      ['add', 'skill', 'fifo.md'],
      ['mcp', 'list', '--config', 'fifo.md'],
      ['mcp', 'add', 'x', 'node', 's.js', '--config', 'fifo.md'],
      ['mcp', 'guard', '--config', 'fifo.md'],
    ]) {
      const r = s.run(args);
      assert.equal(r.signal, null, `${args.join(' ')} finished on its own`);
      assert.match(r.stdout + r.stderr, /not a regular file/, args.join(' '));
      assert.notEqual(r.status, 0, args.join(' '));
    }
    assert.doesNotMatch(s.run(['mcp', 'guard', '--config', 'fifo.md']).stdout, /now starts through Shomra/, 'nothing was guarded, so nothing is claimed');
  } finally {
    s.done();
  }
});

test('a folder or a config that is not an object gets a plain answer', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(path.join(s.dir, 'adir'));
    fs.writeFileSync(path.join(s.dir, 'null.json'), 'null\n');
    fs.writeFileSync(path.join(s.dir, 'broken.json'), '{"mcpServers": {');
    const plan = s.run(['plan', 'adir']);
    assert.equal(plan.status, 3);
    assert.match(plan.stderr, /could not be read \(it is a folder\)/);
    const nul = s.run(['mcp', 'list', '--config', 'null.json']);
    assert.equal(nul.status, 3);
    assert.match(nul.stderr, /does not hold a JSON object/);
    const broken = s.run(['mcp', 'list', '--config', 'broken.json']);
    assert.equal(broken.status, 3, 'a config that cannot be parsed is not listed as empty');
    assert.match(broken.stderr, /not valid JSON/);
  } finally {
    s.done();
  }
});

test('mcp list reads comments and skips entries that are not servers', () => {
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.dir, 'mcp.json'), '{\n  // shared servers\n  "servers": { "a": null, "b": { "command": "npx", "args": "x" }, "c": { "command": "uvx", "args": ["tool"] } }\n}\n');
    const r = s.run(['mcp', 'list', '--config', 'mcp.json']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /● b npx/);
    assert.match(r.stdout, /● c uvx tool/);
  } finally {
    s.done();
  }
});

test('a Shomra config that is a pipe, a folder or holds non-text keys never stops a command or a hook', { skip: WINDOWS }, () => {
  const s = sandbox();
  try {
    const cfg = path.join(s.dir, '.shomra', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    spawnSync('mkfifo', [cfg]);
    const hook = spawnSync(process.execPath, [CLI, 'tool-guard', '--agent', 'claude'], {
      cwd: s.dir,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 's' }),
      env: { PATH: process.env.PATH, HOME: s.dir, USERPROFILE: s.dir, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(hook.signal, null, 'the hook finished on its own');
    assert.equal(hook.status, 0);
    assert.match(hook.stderr, /could not be read \(it is not a regular file\)/);
    assert.equal(s.run(['status']).signal, null);

    fs.rmSync(cfg);
    fs.mkdirSync(cfg);
    const init = s.run(['init', '--key', 'shm_live_aaaaaaaaaaaaaaaaaaaaaaaa', '--url', 'http://127.0.0.1:1']);
    assert.notEqual(init.status, 0);
    assert.match(init.stderr, /could not be written \(it is a folder\)/);
    assert.doesNotMatch(init.stderr, /EISDIR/);

    fs.rmSync(cfg, { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ apiKey: 5, url: 7, machineId: [] }));
    const status = s.run(['status']);
    assert.equal(status.status, 0);
    assert.match(status.stderr, /"apiKey" is not text/);
    assert.doesNotMatch(status.stdout + status.stderr, /is not a function/);
  } finally {
    s.done();
  }
});

test('repo files linked to an endless device are skipped, not read forever', { skip: WINDOWS || !fs.existsSync('/dev/zero') }, () => {
  const s = sandbox();
  try {
    spawnSync('git', ['init', '-q', s.dir]);
    fs.symlinkSync('/dev/zero', path.join(s.dir, '.shomraignore'));
    fs.mkdirSync(path.join(s.dir, '.shomra'));
    fs.symlinkSync('/dev/zero', path.join(s.dir, '.shomra', 'policy.yml'));
    fs.mkdirSync(path.join(s.dir, '.claude'));
    fs.symlinkSync('/dev/zero', path.join(s.dir, '.claude', 'settings.json'));
    fs.writeFileSync(path.join(s.dir, 'AGENTS.md'), '# Rules\nUse pnpm.\n');
    for (const args of [['check'], ['ledger'], ['doctor'], ['rules']]) {
      const r = s.run(args);
      assert.equal(r.signal, null, `${args.join(' ')} finished on its own`);
    }
  } finally {
    s.done();
  }
});

test('rules never overwrites an instructions file it could not read', { skip: WINDOWS }, () => {
  const s = sandbox();
  try {
    spawnSync('mkfifo', [path.join(s.dir, 'CLAUDE.md')]);
    const r = s.run(['rules', '--write', '--agent', 'claude', '--no-policy']);
    assert.equal(r.signal, null);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not be read \(it is not a regular file\); nothing was changed/);
    assert.ok(fs.lstatSync(path.join(s.dir, 'CLAUDE.md')).isFIFO(), 'the file was left as it was');
  } finally {
    s.done();
  }
});

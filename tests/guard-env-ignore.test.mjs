import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardPathAllowlisted, droppedGuardIgnoreGlobs } from '../src/guard/ignore.mjs';
import { guardHookTamper } from '../src/guard/self-protect.mjs';

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-env-ignore-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function withEnvIgnore(value, fn) {
  const prev = process.env.NOFLY_GUARD_IGNORE;
  process.env.NOFLY_GUARD_IGNORE = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.NOFLY_GUARD_IGNORE;
    else process.env.NOFLY_GUARD_IGNORE = prev;
  }
}

test('a match-everything env glob allowlists nothing', () => {
  for (const g of ['**', '*', '**/*', '/', '..']) {
    const root = freshRoot();
    try {
      withEnvIgnore(g, () => {
        assert.equal(guardPathAllowlisted(root, 'src/app.js'), false, `glob ${g} must not allowlist`);
        assert.deepEqual(droppedGuardIgnoreGlobs(root), [g]);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('an absolute or home-rooted env glob allowlists nothing', () => {
  for (const g of ['/etc/**', '~/.ssh/*', '/*']) {
    const root = freshRoot();
    try {
      withEnvIgnore(g, () => {
        assert.equal(guardPathAllowlisted(root, 'src/app.js'), false);
        assert.deepEqual(droppedGuardIgnoreGlobs(root), [g]);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('an ordinary in-repo env glob still allowlists in-repo files only', () => {
  const root = freshRoot();
  try {
    withEnvIgnore('src/**', () => {
      assert.equal(guardPathAllowlisted(root, 'src/app.js'), true);
      assert.equal(droppedGuardIgnoreGlobs(root).length, 0);
      assert.equal(guardPathAllowlisted(root, path.join(os.homedir(), '.bashrc')), false);
      assert.equal(guardPathAllowlisted(root, '../escape.sh'), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an in-repo env glob never reaches outside the repo through a symlink', () => {
  const root = freshRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-env-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'vendor', 'link'), 'dir');
    withEnvIgnore('vendor/**', () => {
      assert.equal(guardPathAllowlisted(root, 'vendor/link/new.sh'), false);
    });
  } catch (e) {
    if (e.code === 'EPERM') return;
    throw e;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a write that sets a guard variable in a shell profile is flagged', () => {
  const root = freshRoot();
  try {
    const hit = guardHookTamper('Write', { file_path: path.join(root, '.bashrc'), content: 'export NOFLY_GUARD_IGNORE=**\n' }, { cwd: root, home: root });
    assert.ok(hit, 'a profile write setting a guard var should be flagged');
    assert.equal(hit.why, 'guard-env-persist');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a shell append of a guard variable into a profile is flagged', () => {
  const root = freshRoot();
  try {
    const hit = guardHookTamper('Bash', { command: "printf 'export NOFLY_GUARD_LOCAL=0\\n' >> ~/.zshrc" }, { cwd: root, home: root });
    assert.ok(hit);
    assert.equal(hit.why, 'guard-env-persist');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a settings env block setting a guard var is flagged by the server-side scanner', async () => {
  const mod = new URL('../../Dragox.Backend/src/modules/discovery/bundle/checks/surfaces/guard-tamper.ts', import.meta.url);
  let guardEnvSwitches;
  try { ({ guardEnvSwitches } = await import(mod.href)); } catch { return; }
  const hits = guardEnvSwitches({ NOFLY_GUARD_IGNORE: '**', PATH: '/usr/bin' });
  assert.ok(hits.some((h) => /GUARD_IGNORE/i.test(h.key)));
});

test('a write that only mentions a guard variable in a doc is not flagged', () => {
  const root = freshRoot();
  try {
    const hit = guardHookTamper('Write', { file_path: path.join(root, 'README.md'), content: 'Set NOFLY_GUARD_IGNORE=** to skip screening.\n' }, { cwd: root, home: root });
    assert.equal(hit, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

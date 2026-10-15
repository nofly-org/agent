import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLedgerStore } from '../src/guard/ledger.mjs';
import { redactLocally } from '../src/detect/local-redact.mjs';
import { restoreRefusal, restoreVerdict } from '../src/guard/memory-restore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'shomra.mjs');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function runHook(cmd, payload, { home, cwd, env }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, cmd, '--agent', 'claude'], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout });
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('a ledger window with an unreadable start still reports its unscreened calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-ledger-'));
  try {
    const store = makeLedgerStore(dir);
    fs.writeFileSync(store.file, JSON.stringify({ open: { openedAt: 'yesterday', reason: 'timeout', unscreened: '2', local: 3 }, pending: [{ opened_at: 'garbage' }] }));
    store.count('unscreened', 'timeout');
    assert.doesNotThrow(() => store.close());
    const { gaps } = store.envelope();
    assert.equal(gaps.length, 1, 'the unreadable old gap is dropped, the window is reported');
    assert.equal(gaps[0].unscreened_calls, 1);
    assert.equal(gaps[0].locally_decided_calls, 3);
    assert.equal(gaps[0].closed_at, undefined, 'a window whose start was not recorded has no measurable length');
    assert.match(gaps[0].reason, /start not recorded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local masking covers every match, however many there are', () => {
  const emails = Array.from({ length: 6000 }, (_, i) => `user${i}@corp.example`).join(' ');
  const out = redactLocally(emails);
  assert.equal((out.text.match(/@corp\.example/g) ?? []).length, 0);
});

test('a rollback never writes agent configuration, scripts or plugin manifests, wherever they sit', () => {
  for (const p of [
    '/home/u/.claude/plugins/cache/market/memory/1.0.0/hooks/hooks.json',
    '/home/u/.claude/plugins/cache/market/memory/1.0.0/.mcp.json',
    '/home/u/.gemini/extensions/memory/gemini-extension.json',
    '/home/u/.claude/memory/run.sh',
    '/home/u/.claude/memory/.claude-plugin/notes.md',
  ]) assert.ok(restoreRefusal(p), p);
  for (const p of ['/home/u/.codex/memories/notes.md', '/home/u/.claude/projects/p/memory/MEMORY.md', '/home/u/proj/memory-bank/activeContext.md']) {
    assert.equal(restoreRefusal(p), null, p);
  }
  const before = '{}';
  const after = '{"note":"x"}';
  const verdict = restoreVerdict(
    { path: '/home/u/.claude/plugins/cache/market/memory/1.0.0/hooks/hooks.json', content: after, hash: sha(after), replaces: sha(before) },
    { read: () => before, ledger: () => ({ hashes: [sha(before)] }) },
  );
  assert.equal(verdict.ok, false);
});

test('a rollback already in place is acknowledged as applied, not as a refusal', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-restore-ack-'));
  const file = path.join(home, 'work', 'CLAUDE.md');
  const old = '# Notes\n- version two\n';
  const wanted = '# Notes\n- version one\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, old);
  fs.mkdirSync(path.join(home, '.shomra', 'memory-ledger'), { recursive: true });
  fs.writeFileSync(path.join(home, '.shomra', 'config.json'), JSON.stringify({ machineId: 'abcd1234ffff', apiKey: 'shm_test_key_0000000000000000' }));
  const key = crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex');
  fs.writeFileSync(path.join(home, '.shomra', 'memory-ledger', `${key}.json`), JSON.stringify({ path: file, hashes: [sha(old)] }));
  let ackStatus = 500;
  const acks = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url.startsWith('/memory/restores/pending')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ restores: [{ storeId: 's1', path: file, content: wanted, hash: sha(wanted), replaces: sha(old) }] }));
      }
      if (req.url.includes('/ack')) acks.push({ status: ackStatus, body: JSON.parse(b) });
      res.writeHead(req.url.includes('/ack') ? ackStatus : 200);
      return res.end('{}');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const env = { SHOMRA_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    await runHook('memory-restore', '{}', { home, cwd: home, env });
    assert.equal(fs.readFileSync(file, 'utf8'), wanted, 'the rollback was written');
    assert.equal(acks[0]?.body.applied, true);
    ackStatus = 200;
    acks.length = 0;
    await runHook('memory-restore', '{}', { home, cwd: home, env });
    assert.equal(acks.length, 1);
    assert.equal(acks[0].body.applied, true, 'after a lost acknowledgement the restore still reads as applied');
    assert.equal(acks[0].body.contentHash, sha(wanted));
  } finally {
    await new Promise((done) => server.close(done));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a memory change reported while the server is down is sent again once it answers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-oob-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const file = path.join(repo, 'CLAUDE.md');
  fs.writeFileSync(file, '# rules\n- run tests\n');
  fs.mkdirSync(path.join(home, '.shomra'), { recursive: true });
  fs.writeFileSync(path.join(home, '.shomra', 'config.json'), JSON.stringify({ machineId: 'abcd1234ffff', apiKey: 'shm_test_key_0000000000000000' }));
  let status = 200;
  const ingests = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/memory/restores/pending')) return res.end(JSON.stringify({ restores: [] }));
      if (req.url === '/memory/ingest') {
        ingests.push({ status, writer: JSON.parse(b || '{}').writer });
        res.writeHead(status);
        return res.end('{}');
      }
      return res.end('{}');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const env = { SHOMRA_URL: `http://127.0.0.1:${server.address().port}` };
  const session = () => runHook('session-guard', { session_id: 's', cwd: repo }, { home, cwd: repo, env });
  try {
    await session();
    assert.ok(ingests.some((i) => i.writer === 'SCAN'), 'the file is baselined');
    fs.writeFileSync(file, '# rules\n- run tests\n- added outside the agent\n');
    ingests.length = 0;
    status = 503;
    await session();
    assert.deepEqual(ingests.map((i) => i.writer), ['UNKNOWN']);
    ingests.length = 0;
    status = 200;
    await session();
    assert.deepEqual(ingests.map((i) => i.writer), ['UNKNOWN'], 'the change the server did not receive is reported again');
    ingests.length = 0;
    await session();
    assert.deepEqual(ingests, [], 'and only until it was received');
  } finally {
    await new Promise((done) => server.close(done));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

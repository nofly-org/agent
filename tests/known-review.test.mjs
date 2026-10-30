import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOnly, withKnownReview } from '../src/gate/known.mjs';
import { REWORDING_NOT_RUN, localAsGateResult } from '../src/gate/result.mjs';
import { contentSha256 } from '../src/detect/signals/ai-verdict.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'nofly.mjs');
const SKILL = '---\nname: notes\ndescription: Keeps notes.\n---\nWrite a short summary of the meeting.\n';
const HELD = { severity: 'HIGH', class: 'PROMPT_INJECTION', title: 'Reworded instruction to send the notes elsewhere', remediationText: 'Remove it.' };

test('a held review adds its findings and clears the "reworded instructions were not looked for" note', () => {
  const base = localAsGateResult({ verdict: 'ALLOW', riskScore: 0, findings: [] }, 'SKILL.md', 'skill');
  const held = withKnownReview(base, { known: true, findings: [HELD] });
  assert.equal(held.knownReview, 'held');
  assert.notEqual(held.decision, 'ALLOW');
  assert.ok(held.findings.some((f) => f.title === HELD.title));
  assert.equal(held.notAttempted.some((n) => n.check === REWORDING_NOT_RUN.check), false);
  const none = withKnownReview(base, { known: false, findings: [] });
  assert.equal(none.knownReview, 'none');
  assert.ok(none.notAttempted.some((n) => n.check === REWORDING_NOT_RUN.check), 'no review held means it was still not looked for');
  assert.equal(withKnownReview(base, null), base);
});

test('hash-only is chosen by the flag or by NOFLY_UPLOAD_CONTENT=0', () => {
  assert.equal(hashOnly({}), false);
  assert.equal(hashOnly({ 'hash-only': true }), true);
  process.env.NOFLY_UPLOAD_CONTENT = '0';
  try {
    assert.equal(hashOnly({}), true);
  } finally {
    delete process.env.NOFLY_UPLOAD_CONTENT;
  }
});

test('the same bytes hash the same whatever line endings the checkout has', () => {
  assert.equal(contentSha256('a\r\nb\r\n'), contentSha256('a\nb\n'));
  assert.notEqual(contentSha256('a\nb\n'), contentSha256('a\nc\n'));
});

function gate(home, cwd, env, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'gate', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

test('nofly gate --hash-only sends the hash and never the file, and shows the review the server holds', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-known-'));
  const file = path.join(home, 'SKILL.md');
  fs.writeFileSync(file, SKILL);
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push({ url: req.url, body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/gate/known' ? { known: true, findings: [HELD] } : { decision: 'ALLOW' }));
    });
  });
  await new Promise((d) => server.listen(0, '127.0.0.1', d));
  const env = { NOFLY_URL: `http://127.0.0.1:${server.address().port}`, NOFLY_API_KEY: 'shm_test_key_0000000000000000', NOFLY_OFFLINE: '1' };
  try {
    const out = await gate(home, home, env, [file, '--hash-only', '--json']);
    const result = JSON.parse(out.stdout);
    assert.equal(result.knownReview, 'held', out.stdout);
    assert.ok(result.findings.some((f) => f.title === HELD.title));
    assert.deepEqual(seen.map((s) => s.url).filter((u) => u.startsWith('/gate/')), ['/gate/known'], 'only the hash lookup reached the server');
    const sent = JSON.parse(seen.find((s) => s.url === '/gate/known').body);
    assert.equal(sent.sha256, contentSha256(SKILL));
    assert.equal(JSON.stringify(sent).includes('summary of the meeting'), false, 'no part of the file was sent');

    const strict = await gate(home, home, env, [file, '--hash-only', '--strict']);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /--strict needs the server to apply org policy/);
  } finally {
    await new Promise((d) => server.close(d));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

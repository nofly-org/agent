import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');

const RUN = { label: 'Run', targetKind: 'llm-guard', status: 'COMPLETED', resilience: 92, scenarioCount: 10, attemptCount: 30, breachedCount: 0, blockedCount: 30, regressedCount: 0, results: [{ title: 'a', breached: false }] };

async function backend(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

function run(args, url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-redteam-'));
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', NOFLY_URL: url, NOFLY_API_KEY: 'shm_ci_test000000000000000000000000' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      done({ code, out });
    });
  });
}

test('the server gate decides the exit code, and the threshold travels to it', async () => {
  const failing = await backend({ ...RUN, gate: { passed: false, reasons: ['Resilience is 92/100 over the attempts that could be graded, but 4 could not be.'], ungradedCount: 4 } });
  const passing = await backend({ ...RUN, gate: { passed: true, reasons: [], ungradedCount: 0 } });
  try {
    const bad = await run(['redteam', '--min', '90'], failing.url);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /4 could not be/);
    assert.doesNotMatch(bad.out, /All scenarios defended/, 'ungraded attempts are not defended ones');
    assert.equal(failing.seen[0].minResilience, 90);
    assert.equal(failing.seen[0].failOnRegression, false);
    const good = await run(['redteam'], passing.url);
    assert.equal(good.code, 0);
    assert.match(good.out, /All scenarios defended/);
  } finally {
    await Promise.all([failing.close(), passing.close()]);
  }
});

test('a stopped run has no score, prints none, and never passes', async () => {
  const stopped = await backend({ ...RUN, status: 'CANCELLED', resilience: 0, gate: null, error: 'Stopped after 3 of 10 scenarios.' });
  try {
    const r = await run(['redteam'], stopped.url);
    assert.equal(r.code, 1);
    assert.match(r.out, /Resilience —/);
    assert.doesNotMatch(r.out, /0\/100|All scenarios defended/);
    assert.match(r.out, /no resilience score/);
  } finally {
    await stopped.close();
  }
});

test('a threshold that is not a number is refused instead of switching the gate off', async () => {
  const old = await backend({ ...RUN, resilience: 70 });
  try {
    const typo = await run(['redteam', '--min', '8O'], old.url);
    assert.equal(typo.code, 3);
    assert.match(typo.out, /--min must be a number from 0 to 100/);
    assert.equal(old.seen.length, 0, 'nothing was run on a bad threshold');
    const below = await run(['redteam', '--min', '80'], old.url);
    assert.equal(below.code, 1, 'an older server with no gate is still held to --min');
    assert.equal((await run(['campaign', '--turns', '40'], old.url)).code, 3);
  } finally {
    await old.close();
  }
});

test('a playbook run that reports anything but COMPLETED is not a pass', async () => {
  const running = await backend({ playbookName: 'Ship gate', playbookId: 'ship', status: 'RUNNING', steps: [] });
  const done = await backend({ playbookName: 'Ship gate', playbookId: 'ship', status: 'COMPLETED', steps: [] });
  try {
    const r = await run(['run', 'ship'], running.url);
    assert.equal(r.code, 1);
    assert.match(r.out, /did not finish/);
    assert.equal((await run(['run', 'ship'], done.url)).code, 0);
  } finally {
    await Promise.all([running.close(), done.close()]);
  }
});

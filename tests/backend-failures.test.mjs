import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFetchError } from '../src/core/keyed-fetch.mjs';
import { okBody } from '../src/core/api-client.mjs';
import { fitReport } from '../src/commands/scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'shomra.mjs');
const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });

test('a network failure is named in plain words, with the proxy hint only where a proxy applies', () => {
  assert.match(describeFetchError(failed('ECONNREFUSED'), 'http://127.0.0.1:3010', {}), /nothing answered at http:\/\/127\.0\.0\.1:3010 \(connection refused\)/);
  assert.match(describeFetchError(failed('ENOTFOUND'), 'https://shomra.corp.example', {}), /shomra\.corp\.example could not be found \(DNS lookup failed\)/);
  assert.match(describeFetchError(failed('UND_ERR_SOCKET'), 'https://a.example', {}), /closed before it answered/);
  assert.match(describeFetchError(failed('SELF_SIGNED_CERT_IN_CHAIN'), 'https://a.example', {}), /NODE_EXTRA_CA_CERTS/);
  assert.match(describeFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'https://a.example', {}), /did not answer in time/);
  const proxied = { HTTPS_PROXY: 'http://proxy.corp:8080' };
  assert.match(describeFetchError(failed('ENOTFOUND'), 'https://shomra.corp.example', proxied), /HTTPS_PROXY is set, but Node uses a proxy only with NODE_USE_ENV_PROXY=1/);
  assert.doesNotMatch(describeFetchError(failed('ENOTFOUND'), 'https://shomra.corp.example', { ...proxied, NODE_USE_ENV_PROXY: '1' }), /HTTPS_PROXY/);
  assert.doesNotMatch(describeFetchError(failed('ENOTFOUND'), 'https://shomra.corp.example', { ...proxied, NO_PROXY: '.corp.example' }), /HTTPS_PROXY/);
  assert.doesNotMatch(describeFetchError(failed('ECONNREFUSED'), 'http://localhost:3010', { HTTP_PROXY: 'http://p:1' }), /PROXY/);
  assert.equal(describeFetchError(new Error('HTTP 500'), 'https://a.example', {}), 'HTTP 500');
});

test('an answer that is not a JSON object is refused in words, never handed to the command', () => {
  assert.deepEqual(okBody('', undefined, 'https://a.example'), {});
  assert.deepEqual(okBody('{"a":1}', { a: 1 }, 'https://a.example'), { a: 1 });
  assert.throws(() => okBody('null', null, 'https://a.example'), /cannot read/);
  assert.throws(() => okBody('7', 7, 'https://a.example'), /cannot read/);
  assert.throws(() => okBody('<!DOCTYPE html><title>Sign in</title>', undefined, 'https://a.example'), /web page instead of data/);
});

async function backend(handler) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => handler(req, res));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

function run(args, url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shomra-backend-fail-'));
  fs.writeFileSync(path.join(home, 'w.zip'), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# Rules\nUse pnpm.\n');
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', SHOMRA_URL: url, SHOMRA_API_KEY: 'shm_live_test0000000000000000000000', SHOMRA_API_TIMEOUT_MS: '5000' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      done({ code, out });
    });
  });
}

test('commands answered with null, a web page or an HTML error say so instead of crashing', async () => {
  const nul = await backend((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  const page = await backend((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><html><body>Sign in to continue</body></html>'); });
  const broken = await backend((req, res) => { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><html><body><h1>Internal Server Error</h1></body></html>'); });
  try {
    for (const args of [['redteam'], ['report'], ['agent-identity', 'register', '--name', 'x', '--no-save'], ['scan-zip', 'w.zip']]) {
      const r = await run(args, nul.url);
      assert.notEqual(r.code, 0, args.join(' '));
      assert.match(r.out, /cannot read/, args.join(' '));
      assert.doesNotMatch(r.out, /Cannot read properties/, args.join(' '));
    }
    assert.match((await run(['redteam'], page.url)).out, /web page instead of data/);
    const zip = await run(['scan-zip', 'w.zip'], broken.url);
    assert.match(zip.out, /500 Internal Server Error/);
    assert.doesNotMatch(zip.out, /<html|DOCTYPE/);
  } finally {
    await Promise.all([nul.close(), page.close(), broken.close()]);
  }
});

test('a memory scan whose uploads all failed says nothing was checked and exits 1', async () => {
  const down = await backend((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"message":"Service Unavailable"}'); });
  try {
    const r = await run(['memory-scan', 'CLAUDE.md'], down.url);
    assert.equal(r.code, 1);
    assert.match(r.out, /could not be sent for checking - nothing was checked/);
    assert.doesNotMatch(r.out, /No memory poisoning found/);
  } finally {
    await down.close();
  }
});

test('an inventory report too big for the server drops whole artifacts and lists them as skipped', () => {
  const skill = (n) => ({ kind: 'skill', name: `s${n}`, path: `skills/s${n}/SKILL.md`, content: 'x'.repeat(1_000_000), files: [], metadata: {} });
  const body = { machine: {}, assets: [], artifacts: Array.from({ length: 8 }, (_, i) => skill(i)), capped: [{ reason: 'byte-budget', path: 'a' }], available: [] };
  const { body: fitted, left } = fitReport(body);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 5 * 1024 * 1024 - 256 * 1024);
  assert.equal(left, 8 - fitted.artifacts.length);
  assert.equal(fitted.capped.filter((c) => c.reason === 'report-size').length, left);
  assert.equal(fitted.capped[0].reason, 'byte-budget', 'earlier caps are kept');
  assert.equal(fitReport({ machine: {}, assets: [], artifacts: [skill(1)] }).left, 0);
  assert.equal(fitReport({ machine: {}, assets: [{ name: 'x'.repeat(6 * 1024 * 1024) }], artifacts: [] }), null);
});

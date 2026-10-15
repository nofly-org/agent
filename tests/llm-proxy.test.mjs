import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BodyTooLarge, readBody } from '../src/commands/llm-proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');
const sleep = (ms) => new Promise((d) => { setTimeout(d, ms); });

async function freePort() {
  const s = net.createServer();
  await new Promise((d) => s.listen(0, '127.0.0.1', d));
  const { port } = s.address();
  await new Promise((d) => s.close(d));
  return port;
}

async function startBackend() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let n = 0;
        const timer = setInterval(() => {
          if (res.destroyed || n++ > 50) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(`data: ${n}\n\n`);
        }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((d) => server.listen(0, '127.0.0.1', d));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(backendUrl, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-proxy-'));
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('NOFLY_')) delete base[k];
  const child = spawn(process.execPath, [CLI, 'llm-proxy', '--port', String(port)], {
    env: { ...base, HOME: home, USERPROFILE: home, NO_COLOR: '1', NOFLY_API_KEY: 'shm_test_proxy', NOFLY_URL: backendUrl },
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 50 && !/Listening on/.test(output) && child.exitCode === null; i++) await sleep(50);
  return { child, output: () => output };
}

function get(port, route) {
  return new Promise((done, fail) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => done({ status: res.statusCode, body }));
    }).on('error', fail);
  });
}

test('a client that disconnects mid-request or mid-stream does not take the proxy down', async () => {
  const backend = await startBackend();
  const port = await freePort();
  const proxy = await startProxy(backend.url, port);
  try {
    assert.match(proxy.output(), /Listening on/);
    await new Promise((done) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('POST /openai/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"partial":');
        setTimeout(() => { sock.destroy(); done(); }, 100);
      });
    });
    await new Promise((done) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/openai/v1/stream', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.once('data', () => { req.destroy(); done(); });
      });
      req.on('error', () => {});
    });
    await sleep(300);
    assert.equal(proxy.child.exitCode, null, proxy.output());
    const next = await get(port, '/openai/v1/models');
    assert.equal(next.status, 200);
    assert.equal(next.body, '{"ok":true}');
  } finally {
    proxy.child.kill();
    backend.server.close();
  }
});

test('a port that is already taken is reported in words, not as a stack trace', async () => {
  const blocker = net.createServer();
  await new Promise((d) => blocker.listen(0, '127.0.0.1', d));
  const port = blocker.address().port;
  const proxy = await startProxy('http://127.0.0.1:9', port);
  try {
    for (let i = 0; i < 50 && proxy.child.exitCode === null; i++) await sleep(50);
    assert.equal(proxy.child.exitCode, 1);
    assert.match(proxy.output(), /already in use/);
  } finally {
    proxy.child.kill();
    blocker.close();
  }
});

test('a request body over the limit is refused instead of buffered without bound', async () => {
  const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
  await assert.rejects(readBody(big, 1000), BodyTooLarge);
  const small = await readBody(Readable.from([Buffer.from('hello')]), 1000);
  assert.equal(small.toString(), 'hello');
});

test('a request body sent in chunks is forwarded, and headers meant for one hop stop at the proxy', async () => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    let size = 0;
    req.on('data', (d) => { size += d.length; });
    req.on('end', () => {
      seen.push({ size, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close, x-backend-hop', 'x-backend-hop': 'internal' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((d) => backend.listen(0, '127.0.0.1', d));
  const port = await freePort();
  const proxy = await startProxy(`http://127.0.0.1:${backend.address().port}`, port);
  try {
    const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const answer = await new Promise((done, fail) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/openai/v1/chat/completions',
        headers: { 'content-type': 'application/json', connection: 'keep-alive, x-client-hop', 'x-client-hop': 'private' },
      }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', fail);
      req.write(body.slice(0, 10));
      req.end(body.slice(10));
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(seen[0].size, Buffer.byteLength(body));
    assert.equal(seen[0].headers['transfer-encoding'], undefined);
    assert.equal(seen[0].headers['x-client-hop'], undefined, 'a header the client named in Connection is not forwarded');
    assert.equal(answer.headers['x-backend-hop'], undefined, 'a header the backend named in Connection is not relayed');
  } finally {
    proxy.child.kill();
    await new Promise((d) => backend.close(d));
  }
});

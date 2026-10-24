import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { endpointOf, priorMcpServersField, priorServers } from '../src/guard/prior-mcp.mjs';

const CONFIG = JSON.stringify({
  mcpServers: {
    wiki: { type: 'http', url: 'https://wiki.acme.example/mcp', headers: { Authorization: 'Bearer abcdefghijklmnop' } },
    files: { command: 'npx', args: ['-y', '@acme/files-mcp@1.2.0', '--root', '/srv/data'], env: { API_TOKEN: 'tok-123' } },
  },
  projects: { '/work/app': { mcpServers: { local: { command: '/usr/bin/node', args: ['server.js'] } } } },
  oauthAccount: { emailAddress: 'dev@acme.example' },
});

test('the prior map carries identity only - no env, headers, tokens, arguments or account fields', () => {
  const servers = priorServers(CONFIG, '.claude.json');
  assert.deepEqual(servers, [
    { name: 'wiki', host: 'wiki.acme.example', endpoint: 'https://wiki.acme.example/mcp' },
    { name: 'files', command: 'npx', pkg: '@acme/files-mcp' },
    { name: 'local', scope: '/work/app', command: 'node' },
  ]);
  const sent = JSON.stringify(servers);
  for (const leak of ['Bearer', 'tok-123', '/srv/data', 'dev@acme.example', '1.2.0']) assert.ok(!sent.includes(leak), leak);
});

test('a write to a governed MCP config sends the file as it was before the call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-prior-'));
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), CONFIG);
    const field = priorMcpServersField('Write', { file_path: '.mcp.json', content: '{}' }, { cwd: dir });
    assert.equal(field.prior_mcp_servers?.length, 1);
    assert.equal(field.prior_mcp_servers[0].path, '.mcp.json');
    assert.equal(field.prior_mcp_servers[0].servers.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing is sent when the file is missing, unreadable, unparseable or not an MCP config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-prior-'));
  try {
    assert.deepEqual(priorMcpServersField('Write', { file_path: '.mcp.json', content: '{}' }, { cwd: dir }), {});
    fs.writeFileSync(path.join(dir, '.mcp.json'), 'not json at all {');
    assert.deepEqual(priorMcpServersField('Write', { file_path: '.mcp.json', content: '{}' }, { cwd: dir }), {});
    fs.writeFileSync(path.join(dir, 'notes.json'), CONFIG);
    assert.deepEqual(priorMcpServersField('Write', { file_path: 'notes.json', content: '{}' }, { cwd: dir }), {});
    assert.deepEqual(priorMcpServersField('Write', { file_path: '.mcp.json' }, { cwd: dir }, () => { throw new Error('EACCES'); }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell write the endpoint attributes to an MCP config carries the prior map too', () => {
  const field = priorMcpServersField('Bash', { command: "cat > .mcp.json <<'EOF'\n{}\nEOF" }, { cwd: '/work' }, () => CONFIG);
  assert.equal(field.prior_mcp_servers?.[0]?.path, '.mcp.json');
});

test('the endpoint is scheme, host, non-default port and path - written the same way however the URL is spelled', () => {
  const same = ['https://Wiki.Acme.Example/mcp', 'https://wiki.acme.example:443/mcp/', 'https://user:pw@wiki.acme.example/mcp?x=1#frag'];
  for (const url of same) assert.equal(endpointOf(url), 'https://wiki.acme.example/mcp', url);
  assert.equal(endpointOf('https://wiki.acme.example:8443/mcp'), 'https://wiki.acme.example:8443/mcp');
  assert.equal(endpointOf('http://wiki.acme.example:80'), 'http://wiki.acme.example');
  assert.equal(endpointOf('not a url'), null);
  assert.equal(endpointOf(''), null);
});

test('an endpoint whose path would carry a credential is left out, and the host still goes', () => {
  const cfg = JSON.stringify({ mcpServers: { hooked: { type: 'http', url: 'https://hooks.acme.example/v1/ghp_' + 'Q7vX2mK9pL4sR8tW1yZ3bN6cD0fH5jG2kM8n' } } });
  const [server] = priorServers(cfg, '.mcp.json');
  assert.equal(server.host, 'hooks.acme.example');
  assert.equal(server.endpoint, undefined);
});

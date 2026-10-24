import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localPortOf, mcpListen } from '../src/inventory/discovery/mcp-servers.mjs';

test('only an http(s) MCP URL on this machine has a local port to check', () => {
  assert.equal(localPortOf('http://localhost:3000/mcp'), 3000);
  assert.equal(localPortOf('http://127.0.0.1:8080/sse'), 8080);
  assert.equal(localPortOf('https://localhost/mcp'), 443);
  assert.equal(localPortOf('http://[::1]:7000/mcp'), 7000);
  assert.equal(localPortOf('https://mcp.example.com/mcp'), null);
  assert.equal(localPortOf('http://10.0.0.5:3000/mcp'), null);
  assert.equal(localPortOf('stdio'), null);
  assert.equal(localPortOf(null), null);
});

test('the listening socket on that port decides the scope, and nothing is claimed without one', () => {
  const listeners = [
    { address: '0.0.0.0', port: 3000, pid: 7, command: 'node' },
    { address: '127.0.0.1', port: 8080, pid: 8, command: 'python' },
  ];
  assert.deepEqual(mcpListen('http://localhost:3000/mcp', listeners), { address: '0.0.0.0', port: 3000, scope: 'all-interfaces', basis: 'socket', process: 'node' });
  assert.equal(mcpListen('http://127.0.0.1:8080/sse', listeners).scope, 'loopback');
  assert.equal(mcpListen('http://localhost:9999/mcp', listeners), null);
  assert.equal(mcpListen('http://localhost:3000/mcp', null), null);
  assert.equal(mcpListen('https://mcp.example.com/mcp', listeners), null);
  const both = [{ address: '127.0.0.1', port: 3000 }, { address: '::', port: 3000 }];
  assert.equal(mcpListen('http://localhost:3000/mcp', both).scope, 'all-interfaces');
});

test('agentic browsers are inventoried from their macOS app bundles, and nowhere they were not seen', async () => {
  const { agenticBrowsers } = await import('../src/inventory/discovery/ai-tools.mjs');
  const present = new Set(['/Applications/Comet.app', '/Users/dev/Applications/ChatGPT Atlas.app']);
  const exists = (p) => present.has(p.replace(/\\/g, '/'));
  const found = agenticBrowsers({ home: '/Users/dev', own: true, platform: 'darwin', exists });
  assert.deepEqual(found.map((a) => [a.vendor, a.metadata.category]).sort(), [['chatgpt-atlas', 'agentic-browser'], ['perplexity-comet', 'agentic-browser']]);
  assert.deepEqual(agenticBrowsers({ home: '/Users/dev', own: false, platform: 'darwin', exists }).map((a) => a.vendor), ['chatgpt-atlas']);
  assert.deepEqual(agenticBrowsers({ home: 'C:/Users/dev', own: true, platform: 'win32', exists: () => true }), []);
});

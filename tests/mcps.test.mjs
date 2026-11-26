import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMcpCodeRefs } from '../src/mcp/code-references.mjs';
import { assessMcpInventory, collectMcpInventory } from '../src/mcp/inventory.mjs';
import { highestVersion } from '../src/commands/mcps.mjs';
import { walkFiles } from '../src/commands/secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-mcps-home-'));

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-mcps-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function inventory(dir) {
  return collectMcpInventory(dir, walkFiles(dir), { machine: false });
}

function run(args) {
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('NOFLY_')) delete env[k];
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: fakeHome, timeout: 60_000 });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function osvStub(pkg, { severity = 'HIGH', fixed = '1.2.0' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (String(url).endsWith('/querybatch')) {
      const queries = JSON.parse(opts.body).queries;
      return { ok: true, json: async () => ({ results: queries.map((q) => (q.package.name === pkg ? { vulns: [{ id: 'GHSA-test-mcps-0001' }] } : {})) }) };
    }
    return {
      ok: true,
      json: async () => ({
        id: 'GHSA-test-mcps-0001',
        aliases: ['CVE-2099-0001'],
        summary: 'Command injection in a tool',
        database_specific: { severity },
        affected: [{ package: { name: pkg }, ranges: [{ events: [{ introduced: '0' }, { fixed }] }] }],
      }),
    };
  };
  return { fetchImpl, calls };
}

test('launch specs are read out of TypeScript objects, Python dicts and keyword arguments', () => {
  const ts = [
    "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';",
    'const servers = {',
    "  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'] },",
    '};',
  ].join('\n');
  assert.deepEqual(scanMcpCodeRefs(ts, 'src/a.ts').map((r) => [r.kind, r.name, r.command, r.args.join(' '), r.line]), [
    ['stdio', 'github', 'npx', '-y @modelcontextprotocol/server-github@2025.4.8', 3],
  ]);

  const py = [
    'from agents.mcp import MCPServerStdio',
    'server = MCPServerStdio(name="Files", params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./data"]})',
    'git = StdioServerParameters(command="uvx", args=["mcp-server-git@2025.1.0"])',
  ].join('\n');
  assert.deepEqual(scanMcpCodeRefs(py, 'tools.py').map((r) => [r.name, r.command, r.args.join(' ')]), [
    ['Files', 'npx', '-y @modelcontextprotocol/server-filesystem ./data'],
    [null, 'uvx', 'mcp-server-git@2025.1.0'],
  ]);
});

test('remote MCP endpoints are found by transport, server_url and an /mcp path, and documentation links are not', () => {
  const ts = [
    "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
    "const t = new StreamableHTTPClientTransport(new URL('https://mcp.acme.example/mcp'));",
    "const tools = [{ type: 'mcp', server_label: 'crm', server_url: 'https://crm.acme.example/v1/sse' }];",
    "const docs = 'https://github.com/acme/agent/tree/main/mcp';",
    'const dynamic = `https://${host}/mcp`;',
  ].join('\n');
  assert.deepEqual(scanMcpCodeRefs(ts, 'src/remote.ts').map((r) => [r.kind, r.url, r.via]), [
    ['remote', 'https://mcp.acme.example/mcp', 'MCP transport'],
    ['remote', 'https://crm.acme.example/v1/sse', 'server_url'],
  ]);
});

test('a file that never mentions MCP, and command objects that launch nothing, stay silent', () => {
  assert.deepEqual(scanMcpCodeRefs("spawnLater({ command: 'npx', args: ['-y', 'left-pad@1.3.0'] });", 'src/build.ts'), []);
  const cli = "// mcp helper CLI\nprogram.command({ command: 'serve', args: ['--port', '3000'] });\nconst task = { command: 'build', args: ['--watch'] };";
  assert.deepEqual(scanMcpCodeRefs(cli, 'src/cli.ts'), []);
});

test('config and code servers are merged, a known-vulnerable pin blocks offline, and code URLs are not accused of missing auth', async () => {
  const dir = project({
    '.mcp.json': JSON.stringify({ mcpServers: { bridge: { command: 'npx', args: ['-y', 'mcp-remote@0.1.10', 'https://example.com/sse'] } } }),
    'src/agent.ts': [
      "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
      "const bridge = { command: 'npx', args: ['-y', 'mcp-remote@0.1.10', 'https://example.com/sse'] };",
      "const remote = new StreamableHTTPClientTransport(new URL('https://mcp.acme.example/mcp'));",
    ].join('\n'),
  });
  const records = inventory(dir);
  const bridge = records.find((r) => r.package?.name === 'mcp-remote');
  assert.deepEqual(bridge.locations.map((l) => l.origin).sort(), ['code', 'config']);
  const state = await assessMcpInventory(records, { offline: true });
  assert.deepEqual(state, { advisories: 'skipped', index: 'not-configured' });
  assert.equal(bridge.alert, 'BLOCK');
  assert.deepEqual(bridge.knownVulns.map((v) => [v.ids[0], v.fixed[0], v.source]), [['CVE-2025-6514', '0.1.16', 'nofly']]);
  const remote = records.find((r) => r.kind === 'remote');
  assert.equal(remote.alert, 'OK');
  assert.equal(remote.findings.some((f) => /authentication/i.test(f.title)), false);
});

test('a pinned package with an OSV advisory is reported with its ids and the release that fixes it', async () => {
  const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'npx', args: ['-y', 'nofly-test-mcp-server@1.0.0'] } } }) });
  const records = inventory(dir);
  const { fetchImpl, calls } = osvStub('nofly-test-mcp-server');
  const state = await assessMcpInventory(records, { fetchImpl });
  assert.equal(state.advisories, 'checked');
  assert.ok(calls.some((u) => String(u).endsWith('/querybatch')));
  const [demo] = records;
  assert.equal(demo.alert, 'BLOCK');
  assert.deepEqual(demo.knownVulns.map((v) => [v.ids, v.fixed, v.source, v.summary]), [[['CVE-2099-0001', 'GHSA-test-mcps-0001'], ['1.2.0'], 'osv', 'Command injection in a tool']]);
  assert.deepEqual(demo.checks, ['nofly', 'osv']);
});

test('an unreachable OSV says so instead of reading as clean, and an unpinned package is never sent', async () => {
  const dir = project({
    '.mcp.json': JSON.stringify({ mcpServers: { pinned: { command: 'npx', args: ['-y', 'nofly-test-mcp-down@2.0.0'] }, loose: { command: 'npx', args: ['-y', 'nofly-test-mcp-loose'] } } }),
  });
  const records = inventory(dir);
  const sent = [];
  const state = await assessMcpInventory(records, {
    fetchImpl: async (url, opts) => {
      sent.push(opts?.body ?? '');
      throw new Error('offline');
    },
  });
  assert.equal(state.advisories, 'unavailable');
  assert.equal(sent.join('').includes('nofly-test-mcp-loose'), false);
  assert.deepEqual(records.find((r) => r.name === 'pinned').checks, ['nofly']);
});

test('the MCP Security Index verdict raises the alert, and local servers are never looked up', async () => {
  const dir = project({
    '.mcp.json': JSON.stringify({ mcpServers: { indexed: { command: 'npx', args: ['-y', 'nofly-test-mcp-indexed'] }, mine: { command: 'node', args: ['./server.js'] }, lan: { url: 'http://localhost:8080/mcp' } } }),
  });
  const records = inventory(dir);
  const asked = [];
  const state = await assessMcpInventory(records, {
    url: 'https://nofly.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    lookup: async (url, id) => {
      asked.push(id);
      return { found: true, scanned: true, slug: id, verdict: 'REVIEW', riskScore: 55, findings: [{ severity: 'HIGH', title: 'A tool description reaches for ~/.ssh' }] };
    },
  });
  assert.equal(state.index, 'checked');
  assert.deepEqual(asked, ['nofly-test-mcp-indexed']);
  assert.equal(records.find((r) => r.name === 'indexed').alert, 'FLAG');
});

test('secrets on a launch line never reach the printed command or the JSON', () => {
  const secret = 'kq8Zr2mXv9TbW4nLp7Ys';
  const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { crm: { command: 'npx', args: ['-y', 'nofly-test-mcp-crm@1.0.0', '--api-key', secret] } } }) });
  const [crm] = inventory(dir);
  assert.equal(crm.command.includes(secret), false);
  assert.equal(JSON.stringify(crm).includes(secret), false);
});

test('highestVersion picks the release that clears every advisory', () => {
  assert.equal(highestVersion(['3.5.0', '3.7.0', '3.6.0']), '3.7.0');
  assert.equal(highestVersion(['2025.7.1', '0.6.3']), '2025.7.1');
  assert.equal(highestVersion([]), null);
});

test('nofly mcp list with no --config lists servers from every agent config on the machine and in the folder', () => {
  fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'cursor-gh': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } } }));
  fs.writeFileSync(path.join(fakeHome, '.mcp.json'), '{}');
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('NOFLY_')) delete env[k];
  const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'node', args: ['./server.js'] } } }) });
  const list = spawnSync(process.execPath, [CLI, 'mcp', 'list', '--json'], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });
  assert.equal(list.status, 0, list.stderr);
  const names = JSON.parse(list.stdout).servers.map((s) => s.name).sort();
  assert.deepEqual(names, ['cursor-gh', 'local']);
  const own = spawnSync(process.execPath, [CLI, 'mcp', 'list', '--no-machine'], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });
  assert.match(own.stdout, /local/);
  assert.doesNotMatch(own.stdout, /cursor-gh/);
  fs.rmSync(path.join(fakeHome, '.cursor'), { recursive: true, force: true });
});

test('nofly mcps exits 1 on a known-vulnerable server, 0 on a dry run, and lists what it found as JSON', () => {
  const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { bridge: { command: 'npx', args: ['-y', 'mcp-remote@0.1.10', 'https://example.com/sse'] } } }) });
  const scan = run(['mcps', dir, '--offline', '--no-machine', '--json']);
  assert.equal(scan.code, 1, scan.stderr);
  const out = JSON.parse(scan.stdout);
  assert.equal(out.detected, 1);
  assert.equal(out.blocked, 1);
  assert.equal(out.servers[0].knownVulns[0].ids[0], 'CVE-2025-6514');
  const dry = run(['mcps', dir, '--dry-run', '--no-machine']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /bridge/);
  const empty = run(['mcps', project({ 'README.md': '# nothing here\n' }), '--no-machine', '--offline']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /No MCP servers found/);
});

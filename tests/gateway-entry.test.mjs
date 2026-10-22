import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clientServerKey, gatewayEntryKey, MAX_ENTRY_LENGTH } from '../src/guard/gateway-entry.mjs';
import { buildGuardBody } from '../src/guard/report.mjs';
import { platformPath } from './_platform.mjs';

const URL_BASE = 'https://nofly.example';
const TOOL = 'mcp__nofly__github__push_files';
const gateway = { type: 'http', url: `${URL_BASE}/mcp`, headers: { Authorization: 'Bearer ${NOFLY_AGENT}' } };
const stdio = { command: 'node', args: ['evil.js'] };

function machine({ user, local, project, managed, claudeRaw } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-gw-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work', 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const claude = { ...(user ? { mcpServers: user } : {}), ...(local ? { projects: { [cwd]: { mcpServers: local } } } : {}) };
  fs.writeFileSync(path.join(home, '.claude.json'), claudeRaw ?? JSON.stringify(claude));
  if (project) fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: project }));
  const managedFile = path.join(root, 'managed-mcp.json');
  if (managed) fs.writeFileSync(managedFile, JSON.stringify({ mcpServers: managed }));
  return { home, cwd, managedFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function entryFor(tool, setup, { url = URL_BASE, env = {} } = {}) {
  const m = machine(setup);
  try {
    return gatewayEntryKey(tool, { url, cwd: m.cwd, home: m.home, env, managedFile: m.managedFile });
  } finally {
    m.cleanup();
  }
}

test('the entry `claude mcp add` writes for this project is recognised as the gateway', () => {
  assert.equal(entryFor(TOOL, { local: { nofly: gateway } }), 'nofly');
});

test('a user-scope or project-scope entry is recognised too', () => {
  assert.equal(entryFor(TOOL, { user: { nofly: gateway } }), 'nofly');
  assert.equal(entryFor(TOOL, { project: { nofly: gateway } }), 'nofly');
  assert.equal(entryFor('mcp__corp-gw__github__push_files', { user: { 'corp-gw': gateway } }), 'corp-gw');
});

test('⚠ a NAME proves nothing: an entry called nofly that runs something else is never the gateway', () => {
  assert.equal(entryFor(TOOL, { project: { nofly: stdio } }), null);
  assert.equal(entryFor(TOOL, { user: { nofly: { type: 'http', url: 'https://attacker.example/mcp' } } }), null);
});

test('⚠ one other definition of the same name anywhere Claude Code reads is enough to refuse', () => {
  assert.equal(entryFor(TOOL, { user: { nofly: gateway }, project: { nofly: stdio } }), null);
  assert.equal(entryFor(TOOL, { local: { nofly: gateway }, managed: { nofly: stdio } }), null);
});

test('only the aggregated endpoint counts - a per-server route or another path is not it', () => {
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: `${URL_BASE}/mcp/github` } } }), null);
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: `${URL_BASE}/gateway/inspect` } } }), null);
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, type: 'sse' } } }), null);
});

test('the address is compared as an address: host case, a trailing slash and a query do not matter', () => {
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: 'https://NoFly.Example/mcp/' } } }), 'nofly');
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: `${URL_BASE}/mcp?client=claude` } } }), 'nofly');
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: 'http://nofly.example/mcp' } } }), null);
});

test('${VAR} in the url expands the way Claude Code expands it, and an unset one is never guessed', () => {
  const templated = { nofly: { ...gateway, url: '${NOFLY_URL}/mcp' } };
  assert.equal(entryFor(TOOL, { user: templated }, { env: { NOFLY_URL: URL_BASE } }), 'nofly');
  assert.equal(entryFor(TOOL, { user: templated }, { env: {} }), null);
  assert.equal(entryFor(TOOL, { user: { nofly: { ...gateway, url: '${GW:-https://nofly.example}/mcp' } } }), 'nofly');
});

test('a gateway entry with no server segment after it is not an aggregated call', () => {
  assert.equal(entryFor('mcp__nofly__push_files', { user: { nofly: gateway } }), null);
  assert.equal(entryFor('Bash', { user: { nofly: gateway } }), null);
});

test('two entries that both prefix the call are ambiguous, and neither is claimed', () => {
  assert.equal(entryFor('mcp__no__fly__github__x', { user: { no: stdio, no__fly: gateway } }), null);
});

test('a config that cannot be read is no evidence either way', () => {
  assert.equal(entryFor(TOOL, { claudeRaw: '{ not json' }), null);
  assert.equal(entryFor(TOOL, { local: { nofly: gateway } }, { url: null }), null);
});

test('an entry the backend would refuse is never sent', () => {
  const long = 'g'.repeat(MAX_ENTRY_LENGTH + 1);
  assert.equal(entryFor(`mcp__${long}__github__push_files`, { user: { [long]: gateway } }), null);
  assert.equal(clientServerKey('my gateway.prod'), 'my_gateway_prod');
});

test('the guard body carries the entry only when one was verified', () => {
  assert.equal(buildGuardBody({ tool_name: TOOL, tool_input: {}, mcp_gateway: 'nofly' }, 'claude').mcp_gateway, 'nofly');
  assert.equal('mcp_gateway' in buildGuardBody({ tool_name: TOOL, tool_input: {} }, 'claude'), false);
});

test('both hooks resolve the entry before they ask the server', () => {
  const src = (p) => fs.readFileSync(new URL(`../src/guard/${p}`, import.meta.url), 'utf8');
  assert.match(src('tool-guard.mjs'), /gatewayEntryKey\(tool, \{ url, cwd: normalized\.cwd \}\)/);
  assert.match(src('result-guard.mjs'), /gatewayEntryKey\(normalized\.tool_name, \{ url, cwd: normalized\.cwd \}\)/);
  assert.match(src('result-guard.mjs'), /mcp_gateway: normalized\.mcp_gateway/);
});

const DTO = platformPath('src', 'modules', 'runtime', 'gate', 'dto', 'tool-guard.dto.ts');
const RESULT_DTO = platformPath('src', 'modules', 'runtime', 'gate', 'dto', 'tool-result-guard.dto.ts');

test('the server accepts the field under the same name and the same characters', { skip: !(DTO && RESULT_DTO) && 'platform checkout not present' }, () => {
  for (const file of [DTO, RESULT_DTO]) {
    assert.match(fs.readFileSync(file, 'utf8'), /@Matches\(\/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\)\s*\n\s*mcp_gateway\?: string;/);
  }
  assert.equal(MAX_ENTRY_LENGTH, 64);
});

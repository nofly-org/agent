import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFindings } from '../src/detect/guard-signals.mjs';
import { localGate } from '../src/detect/signals/gate.mjs';
import { SNAPSHOT_INTEL, loadPackageIntel } from '../src/detect/signals/package-names.mjs';

const FIXTURE = [
  { ecosystem: 'npm', name: 'event-stream', versions: ['3.3.6'], id: 'FIXTURE-1', modified: '2018-11-26T00:00:00Z', summary: 'flatmap-stream' },
  { ecosystem: 'pypi', name: 'torchtriton', versions: null, id: 'FIXTURE-2', modified: '2022-12-31T00:00:00Z', summary: 'dependency confusion' },
  { ecosystem: 'pypi', name: 'litellm', versions: ['1.82.8'], id: 'FIXTURE-3', modified: '2026-03-30T00:00:00Z', summary: 'credential stealer' },
];
const withFixture = () => loadPackageIntel({ ...SNAPSHOT_INTEL, malicious: [...SNAPSHOT_INTEL.malicious, ...FIXTURE] }, 'fixture');
const snapshotMalicious = SNAPSHOT_INTEL.malicious.find((m) => m.ecosystem === 'npm' && !m.versions && /^[a-z][a-z0-9-]{2,40}$/.test(m.name));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-install-screen-'));

function guard(command) {
  const base = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  for (const k of Object.keys(base)) if (k.startsWith('NOFLY_')) delete base[k];
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'tool-guard', '--agent', 'claude'], { env: base, cwd: home });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    child.on('close', () => {
      let body = null;
      try {
        body = JSON.parse(stdout || '{}');
      } catch {
        body = null;
      }
      done({ stdout, decision: body?.hookSpecificOutput?.permissionDecision ?? null, reason: body?.hookSpecificOutput?.permissionDecisionReason ?? '' });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: home }));
  });
}

test('a typo of a popular package is flagged offline, with two letters swapped', () => {
  const [f, ...rest] = installFindings('pip install reqeusts');
  assert.equal(rest.length, 0);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.label, 'Possible typosquat dependency: reqeusts');
  assert.match(f.detail, /"requests"/);
});

test('the real package and ordinary installs stay silent', () => {
  for (const cmd of ['pip install requests', 'npm install express react', 'python -m pip install -r requirements.txt', 'uv add pydantic', 'npm ci', 'cargo add serde']) {
    assert.deepEqual(installFindings(cmd), [], cmd);
  }
});

test('a malicious package and a compromised release from the feed are critical, and only that release', () => {
  withFixture();
  assert.equal(installFindings('pip install torchtriton')[0]?.label, 'Malicious dependency: torchtriton');
  assert.equal(installFindings('npm i event-stream@3.3.6')[0]?.severity, 'CRITICAL');
  assert.deepEqual(installFindings('npm i event-stream@3.3.4'), []);
  assert.equal(installFindings('pip install litellm==1.82.8')[0]?.severity, 'CRITICAL');
  assert.deepEqual(installFindings('pip install litellm==1.82.6'), []);
  loadPackageIntel(SNAPSHOT_INTEL, 'snapshot');
});

test('the package lists come from the API snapshot, not from a typed-in list', () => {
  assert.ok(SNAPSHOT_INTEL.npm.length > 1000 && SNAPSHOT_INTEL.pypi.length > 1000, 'the snapshot carries the downloaded popularity lists');
  for (const legit of ['npm i ms', 'npm i preact', 'npm i vuex', 'pip install boto', 'pip install pipx', 'pip install scapy']) assert.deepEqual(installFindings(legit), [], legit);
});

test('a lookalike of a public npm scope is flagged', () => {
  assert.match(installFindings('npm install @anthropic-al/sdk')[0]?.label ?? '', /Possible typosquat dependency: @anthropic-al\/sdk/);
});

test('with no server configured, the hook asks before installing a typo of a popular package', async () => {
  const out = await guard('pip install reqeusts');
  assert.equal(out.decision, 'ask', out.stdout);
  assert.match(out.reason, /Possible typosquat dependency: reqeusts/);
});

test('with no server configured, the hook refuses a malicious package from the shipped feed and lets the real one through', async () => {
  assert.ok(snapshotMalicious, 'the shipped snapshot carries at least one malicious npm package');
  const bad = await guard(`npm install ${snapshotMalicious.name}`);
  assert.equal(bad.decision, 'deny', bad.stdout);
  assert.match(bad.reason, new RegExp(`Malicious dependency: ${snapshotMalicious.name}`));
  assert.equal((await guard('pip install requests')).decision, null);
});

test('an MCP server launching a package with two letters swapped is flagged, like on the server', () => {
  const doc = JSON.stringify({ mcpServers: { web: { command: 'npx', args: ['-y', 'exrpess@4.18.2'] } } });
  const titles = localGate(doc, { kind: 'mcp', path: '.mcp.json' }).findings.map((f) => f.title);
  assert.ok(titles.some((t) => /Possible typosquat in "web": exrpess/.test(t)), titles.join(' | '));
});

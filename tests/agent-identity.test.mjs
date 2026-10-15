import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from '../src/cli/flags.mjs';
import { credentialTarget, exportSignIn, identityStatus, inCi, ownerEmail, registrationBody, registrationWorkload } from '../src/commands/agent-identity.mjs';
import { saveAgentCredential, storedAgentCredential } from '../src/core/config.mjs';
import { readCachedCredential, workloadCredential, workloadKey, writeCachedCredential } from '../src/core/workload-identity.mjs';
import { unauthenticatedNote } from '../src/guard/tool-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-id-'));
const AGT = 'shm_agt_AbCdEfGhIjKlMnOpQrStUvWx01234567';

function cli(args, env = {}) {
  const home = env.HOME ?? tmpDir();
  const base = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  for (const k of Object.keys(base)) if (k.startsWith('NOFLY_') || k.startsWith('GITHUB_') || k.startsWith('ACTIONS_') || k === 'CI' || k === 'GITLAB_CI') delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, ...env, HOME: home, USERPROFILE: home }, cwd: home });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, home }));
  });
}

async function serve(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const [status, payload] = routes[key] ? routes[key](parsed, req) : [404, { message: 'no route' }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((d) => server.close(d)) };
}

test('the registration flags are known, so `--owner` no longer exits before anything runs', () => {
  const { flags, unknown } = parseFlags(['--owner', 'dana@acme.com', '--no-owner', '--purpose', 'Sorts the inbox', '--for', 'claude', '--workload', 'github', '--audience', 'shomra:org:o1', '--static', '--no-save', '--print-credential']);
  assert.deepEqual(unknown, []);
  assert.equal(flags.owner, 'dana@acme.com');
  assert.equal(flags.purpose, 'Sorts the inbox');
  assert.equal(flags['no-owner'], true);
});

test('an explicit owner wins, and --no-owner sends none', () => {
  assert.equal(ownerEmail({ owner: ' dana@acme.com ' }), 'dana@acme.com');
  assert.equal(ownerEmail({ 'no-owner': true }), undefined);
});

test('the purpose travels as the description the server grades calls against', () => {
  assert.equal(registrationBody({ name: 'Inbox Triage', purpose: '  Sorts and labels the support inbox ' }).description, 'Sorts and labels the support inbox');
  assert.equal(registrationBody({ name: 'x', purpose: '   ' }).description, undefined);
});

test('registration goes keyless on its own where the platform can prove the workload', () => {
  assert.equal(registrationWorkload({}, { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' }), 'github');
  assert.equal(registrationWorkload({}, { GITHUB_ACTIONS: 'true' }), null, 'a job without id-token permission cannot prove itself');
  assert.equal(registrationWorkload({}, { GITLAB_CI: 'true', NOFLY_ID_TOKEN: 'gl' }), 'gitlab');
  assert.equal(registrationWorkload({}, { NOFLY_WORKLOAD: 'kubernetes' }), 'kubernetes');
  assert.equal(registrationWorkload({ workload: 'okta' }, {}), 'okta');
  assert.equal(registrationWorkload({ workload: 'jenkins' }, {}), undefined);
  assert.equal(registrationWorkload({ static: true }, { NOFLY_WORKLOAD: 'github' }), null, '--static forces a stored credential');
});

test('CI is recognised by the variables CI systems set', () => {
  assert.equal(inCi({ CI: 'true' }), true);
  assert.equal(inCi({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(inCi({ CI: 'false' }), false);
  assert.equal(inCi({}), false);
});

test('a credential can be kept per coding agent, and a bad name falls back to the default slot', () => {
  assert.equal(credentialTarget({ for: 'Claude' }), 'claude');
  assert.equal(credentialTarget({ for: '../etc' }), 'default');
  assert.equal(credentialTarget({}), 'default');
});

test('a saved credential is owner-only, keeps the rest of the config, and is found per agent before the default', () => {
  const file = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'shm_live_x', url: 'https://api.example' }));
  saveAgentCredential('default', { credential: AGT, slug: 'mine', url: 'https://api.example' }, file);
  saveAgentCredential('claude', { credential: `${AGT}c`, slug: 'claude-one', url: 'https://api.example' }, file);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.apiKey, 'shm_live_x');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(storedAgentCredential(cfg, 'claude', 'https://api.example'), `${AGT}c`);
  assert.equal(storedAgentCredential(cfg, 'cursor', 'https://api.example'), AGT);
  assert.equal(storedAgentCredential(cfg, 'claude', 'https://other.example'), null, 'a credential for another backend is never presented');
  assert.equal(storedAgentCredential({ agentCredentials: { default: { credential: 'billing-bot' } } }, null, null), null, 'only a real credential is ever presented from the config');
});

test('status names where the identity comes from, and calls a bare handle what it is', () => {
  assert.match(identityStatus({}, null, { NOFLY_AGENT: AGT }), /credential shm_agt_AbCdEf…/);
  assert.match(identityStatus({}, null, { NOFLY_AGENT: 'billing-bot' }), /a name anyone can type/);
  assert.match(identityStatus({}, null, { NOFLY_WORKLOAD: 'github' }), /keyless via GitHub Actions/);
  assert.match(identityStatus({ agentCredentials: { claude: { credential: AGT, slug: 'claude-one' } } }, null, {}), /saved credential for claude \(claude-one\)/);
  assert.equal(identityStatus({}, null, {}), null);
});

test('later steps of a GitHub job sign in on their own, and nothing secret is written to the job env', () => {
  const file = path.join(tmpDir(), 'github_env');
  assert.equal(exportSignIn('github', 'shomra:org:o1', { GITHUB_ACTIONS: 'true', GITHUB_ENV: file }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'NOFLY_WORKLOAD=github\nNOFLY_AUDIENCE=shomra:org:o1\n');
  assert.equal(exportSignIn('github', 'a', {}), false);
});

test('a refusal says WHICH credential was refused and why, instead of always blaming the API key', () => {
  const agent = unauthenticatedNote(403, { reason: 'This agent is awaiting approval.', agentCredential: true });
  assert.match(agent, /rejected this agent’s credential \(HTTP 403: This agent is awaiting approval\.\)/);
  assert.match(agent, /awaiting approval/);
  const key = unauthenticatedNote(401, {});
  assert.match(key, /rejected this API key \(HTTP 401\)/);
  assert.match(key, /nofly init --key/);
});

test('⚠ a workload credential cached by one CI job is never reused by another job on the same runner', async () => {
  const file = path.join(tmpDir(), 'workload-credential.json');
  const jobA = { NOFLY_WORKLOAD: 'github', NOFLY_AUDIENCE: 'shomra:org:o1', GITHUB_REPOSITORY_ID: '11', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'build', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/t?v=2', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' };
  const jobB = { ...jobA, GITHUB_REPOSITORY_ID: '22', GITHUB_RUN_ID: '200', GITHUB_JOB: 'deploy' };
  const original = globalThis.fetch;
  let minted = 0;
  globalThis.fetch = async (url) => {
    const body = String(url).startsWith('https://gh.example') ? { value: 'gh-oidc' } : { credential: `shm_agt_job${++minted}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(await workloadCredential({ url: 'https://api.example', env: jobA, file }), 'shm_agt_job1');
    assert.equal(await workloadCredential({ url: 'https://api.example', env: jobA, file }), 'shm_agt_job1', 'the same job reuses its session');
    assert.equal(await workloadCredential({ url: 'https://api.example', env: jobB, file }), 'shm_agt_job2', 'another job mints its own');
  } finally {
    globalThis.fetch = original;
  }
});

test('a cluster workload is keyed by the subject its own token names', () => {
  const dir = tmpDir();
  const tok = (sub) => `x.${Buffer.from(JSON.stringify({ iss: 'https://k8s', sub })).toString('base64url')}.y`;
  fs.writeFileSync(path.join(dir, 'a'), tok('system:serviceaccount:agents:a'));
  fs.writeFileSync(path.join(dir, 'b'), tok('system:serviceaccount:agents:b'));
  const a = workloadKey('kubernetes', { NOFLY_TOKEN_FILE: path.join(dir, 'a') });
  const b = workloadKey('kubernetes', { NOFLY_TOKEN_FILE: path.join(dir, 'b') });
  assert.notEqual(a, b);
  const file = path.join(dir, 'cache.json');
  writeCachedCredential(file, { url: 'u', source: 'kubernetes', audience: 'aud', workload: a, credential: AGT, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(readCachedCredential(file, { url: 'u', source: 'kubernetes', audience: 'aud', workload: a }), AGT);
  assert.equal(readCachedCredential(file, { url: 'u', source: 'kubernetes', audience: 'aud', workload: b }), null);
});

test('register on a laptop saves the credential instead of printing it, and sends the purpose and owner', async () => {
  const s = await serve({
    'POST /agents/register': (body) => [201, { id: 'a1', slug: 'inbox-triage', name: 'Inbox Triage', type: 'coding-agent', status: 'ACTIVE', description: body.description, owner: { email: body.ownerEmail }, credential: AGT, credentialPrefix: AGT.slice(0, 14), reviewDueAt: '2027-04-02T00:00:00.000Z', registration: { existing: false, keyless: false } }],
  });
  try {
    const out = await cli(['agent-identity', 'register', '--name', 'Inbox Triage', '--type', 'coding-agent', '--purpose', 'Sorts and labels the support inbox', '--owner', 'dana@acme.com', '--for', 'claude'], { NOFLY_URL: s.url, NOFLY_API_KEY: 'shm_live_test' });
    assert.equal(out.code, 0, out.stderr);
    const sent = s.seen.find((x) => x.url === '/agents/register').body;
    assert.equal(sent.description, 'Sorts and labels the support inbox');
    assert.equal(sent.ownerEmail, 'dana@acme.com');
    assert.equal(sent.workloadToken, undefined);
    const cfg = JSON.parse(fs.readFileSync(path.join(out.home, '.nofly', 'config.json'), 'utf8'));
    assert.equal(cfg.agentCredentials.claude.credential, AGT);
    assert.equal(cfg.agentCredentials.claude.url, s.url);
    assert.ok(!out.stdout.includes(AGT), 'the saved credential is not printed');
    assert.match(out.stdout, /nothing to export, nothing to restart/);
    assert.match(out.stdout, /Review due 2027-04-02/);
  } finally {
    await s.close();
  }
});

test('⚠ register in CI without a way to prove the workload refuses to mint a secret into the build log', async () => {
  const s = await serve({});
  try {
    const out = await cli(['agent-identity', 'register', '--name', 'Release Bot'], { NOFLY_URL: s.url, NOFLY_API_KEY: 'shm_ci_test', CI: 'true' });
    assert.equal(out.code, 3);
    assert.match(out.stderr, /mints a new agent and a new secret on every run/);
    assert.match(out.stderr, /id-token: write/);
    assert.equal(s.seen.length, 0, 'nothing was sent');
  } finally {
    await s.close();
  }
});

test('in a GitHub job with id-token permission the workload registers itself, with no secret stored anywhere', async () => {
  const home = tmpDir();
  const githubEnv = path.join(home, 'github_env');
  const s = await serve({
    'GET /gh-token': () => [200, { value: 'gh-oidc-token' }],
    'GET /agents/register/workload': () => [200, { audience: 'shomra:org:o1', exchangePath: '/public/agents/federated-credential', sessionMinutes: 60 }],
    'POST /agents/register': (body) => [
      201,
      {
        id: 'a2', slug: 'release-bot', name: 'Release Bot', type: 'ci', status: 'ACTIVE', description: body.description, owner: null,
        credential: AGT, tokenType: 'agent-session', credentialExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        registration: { existing: false, keyless: true, binding: { provider: 'github', subject: 'repo:acme@1/release@2:environment:production' }, sessionMinutes: 60, warnings: [] },
      },
    ],
  });
  try {
    const out = await cli(['agent-identity', 'register', '--name', 'Release Bot', '--type', 'ci', '--purpose', 'Publishes the release', '--no-owner'], {
      HOME: home,
      NOFLY_URL: s.url,
      NOFLY_API_KEY: 'shm_ci_test',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_ENV: githubEnv,
      GITHUB_RUN_ID: '9',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${s.url}/gh-token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token',
    });
    assert.equal(out.code, 0, out.stderr);
    const gh = s.seen.find((x) => x.url.startsWith('/gh-token'));
    assert.match(gh.url, /audience=shomra%3Aorg%3Ao1/);
    const sent = s.seen.find((x) => x.url === '/agents/register').body;
    assert.equal(sent.workloadProvider, 'github');
    assert.equal(sent.workloadToken, 'gh-oidc-token');
    assert.equal(sent.ownerEmail, undefined);
    assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'NOFLY_WORKLOAD=github\nNOFLY_AUDIENCE=shomra:org:o1\n');
    assert.ok(!fs.existsSync(path.join(home, '.nofly', 'config.json')) || !JSON.parse(fs.readFileSync(path.join(home, '.nofly', 'config.json'), 'utf8')).agentCredentials, 'no long-lived credential is saved');
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.nofly', 'workload-credential.json'), 'utf8'));
    assert.equal(cache.credential, AGT, 'the session is ready for the hook in this job');
    assert.match(cache.workload, /^github\|/);
    assert.match(out.stdout, /with no stored agent credential/);
    assert.ok(!out.stdout.includes(AGT), 'the session credential is not printed');
  } finally {
    await s.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAgentArtifacts } from '../src/inventory/agent-artifacts.mjs';
import { discoverCodingAgents } from '../src/inventory/discovery.mjs';
import { walkWorkspace } from '../src/inventory/discovery/workspace.mjs';
import { bundleHookScripts } from '../src/inventory/artifacts/hook-scripts.mjs';
import { walkRoot } from '../src/inventory/artifacts/walk.mjs';
import { maskDeep } from '../src/detect/secret-mask.mjs';
import { boundedJson, TOO_DEEP } from '../src/core/wire-limits.mjs';
import { maskServerSecrets } from '../src/detect/signals/mcp-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'nofly.mjs');
const GH_TOKEN = 'ghp_Q7rT2mX9vB4nK8wL1pZ6sD3fH5jC0yA2uE4i';
const OPENAI_KEY = 'sk-proj-Wq3Lr8Tz1Xv6Nb4Mk9Pj2Hs7Gd5Fa0Ce3Ry8Ut1Io6';
const URL_PASS = 'Zr8!vQ2pLx';
const WINDOWS = process.platform === 'win32';

function tree() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-inventory-')));
  const write = (rel, text) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    return full;
  };
  const link = (target, rel) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(target, full);
  };
  return { dir, write, link, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runCli(cwd, home, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', NOFLY_URL: 'http://127.0.0.1:1', ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('linked agent folders are scanned, links leaving home are listed, and key files are never read', { skip: WINDOWS }, () => {
  const t = tree();
  try {
    t.write('home/dotfiles/claude/CLAUDE.md', '# Rules\nBe careful.\n');
    t.write('home/dotfiles/claude/commands/hello.md', '---\ndescription: hello\n---\nSay hello.\n');
    t.write('home/dotfiles/claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo\n---\nDo the demo.\n');
    t.write('home/.ssh/id_rsa', 'PRIVATE KEY BYTES\n');
    t.write('outside/away.md', '---\ndescription: away\n---\nOutside text.\n');
    fs.mkdirSync(path.join(t.dir, 'home/.claude'), { recursive: true });
    t.link('../dotfiles/claude/CLAUDE.md', 'home/.claude/CLAUDE.md');
    t.link('../dotfiles/claude/commands', 'home/.claude/commands');
    t.link('../dotfiles/claude/skills', 'home/.claude/skills');
    t.link(path.join(t.dir, 'outside/away.md'), 'home/dotfiles/claude/commands/away.md');
    t.link('../../../.ssh/id_rsa', 'home/dotfiles/claude/commands/key.md');
    t.link('..', 'home/dotfiles/claude/commands/up');
    t.link('missing.md', 'home/dotfiles/claude/commands/gone.md');

    const home = path.join(t.dir, 'home');
    const refused = [];
    const files = walkRoot(path.join(home, '.claude'), { dirs: 100 }, { within: [home], refused });
    const rel = files.map((f) => path.relative(home, f).split(path.sep).join('/')).sort();
    assert.deepEqual(rel, ['.claude/CLAUDE.md', '.claude/commands/hello.md', '.claude/skills/demo/SKILL.md']);
    assert.deepEqual(refused.map((r) => [r.reason, path.basename(r.path)]).sort(), [['link-outside', 'away.md'], ['link-withheld', 'key.md']]);

    const proj = path.join(t.dir, 'proj');
    fs.mkdirSync(proj);
    const found = discoverAgentArtifacts(proj, null, { home });
    const paths = found.artifacts.map((a) => a.path).sort();
    assert.ok(paths.includes('.claude/CLAUDE.md'), 'a linked rules file is found');
    assert.ok(paths.includes('.claude/commands/hello.md'), 'a command in a linked folder is found');
    assert.ok(paths.includes('.claude/skills/demo/SKILL.md'), 'a skill in a linked folder is found');
    const wire = JSON.stringify(found.artifacts);
    assert.ok(!wire.includes('PRIVATE KEY BYTES'), 'a link into .ssh is never read');
    assert.ok(!wire.includes('Outside text'), 'a link leaving home is never read');
    assert.ok(found.capped.some((c) => c.reason === 'link-outside'), 'a link that was not followed is listed as skipped');
  } finally {
    t.done();
  }
});

test('a project link that leaves the project is not read', { skip: WINDOWS }, () => {
  const t = tree();
  try {
    t.write('secret-notes.md', 'Text from outside the project.\n');
    t.write('repo/shared/commands/deploy.md', '---\ndescription: deploy\n---\nShip it.\n');
    fs.mkdirSync(path.join(t.dir, 'repo/.claude'), { recursive: true });
    t.link('../../secret-notes.md', 'repo/.claude/CLAUDE.md');
    t.link('../shared/commands', 'repo/.claude/commands');
    const repo = path.join(t.dir, 'repo');
    const roots = [{ vendor: 'claude-code', scope: 'project', dir: path.join(repo, '.claude') }];
    const found = discoverAgentArtifacts(repo, roots);
    assert.deepEqual(found.artifacts.map((a) => a.path), ['.claude/commands/deploy.md'], 'a link inside the project is followed');
    assert.ok(!JSON.stringify(found.artifacts).includes('outside the project'));
    assert.deepEqual(found.capped.map((c) => c.reason), ['link-outside']);
  } finally {
    t.done();
  }
});

test('hook scripts are judged by the path inside the project, and a script linked to a key is withheld', { skip: WINDOWS }, () => {
  const t = tree();
  try {
    const project = path.join(t.dir, 'password-manager');
    t.write('password-manager/.claude/hooks/lint.sh', '#!/bin/sh\necho lint\n');
    t.write('home/.ssh/deploy_hook.sh', 'echo key material\n');
    t.link(path.join(t.dir, 'home/.ssh/deploy_hook.sh'), 'password-manager/.claude/hooks/run.sh');
    const artifact = {
      path: '.claude/settings.json',
      content: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/lint.sh && bash .claude/hooks/run.sh' }] }] } }),
      files: [],
      metadata: {},
    };
    bundleHookScripts(artifact, path.join(project, '.claude/settings.json'), {
      projectDir: project,
      relPath: (abs) => path.relative(project, abs).split(path.sep).join('/'),
      budget: { bytes: 1_000_000 },
      capped: [],
      mode: 'full',
      home: path.join(t.dir, 'home'),
    });
    const states = Object.fromEntries(artifact.metadata.hookScripts.scripts.map((s) => [s.ref, s.state]));
    assert.equal(states['.claude/hooks/lint.sh'], 'sent', 'a folder named password-manager does not hide its scripts');
    assert.equal(states['.claude/hooks/run.sh'], 'withheld', 'a script that resolves into .ssh is withheld, not reported missing');
    assert.ok(!JSON.stringify(artifact.files).includes('key material'));
  } finally {
    t.done();
  }
});

test('maskDeep masks credentials anywhere in a nested value and survives a cycle-free deep tree', () => {
  const masked = maskDeep({ a: [{ env: { TOKEN: GH_TOKEN } }], b: `Bearer ${OPENAI_KEY}`, n: 3, short: 'ok' });
  const text = JSON.stringify(masked);
  assert.ok(!text.includes(GH_TOKEN));
  assert.ok(!text.includes(OPENAI_KEY));
  assert.equal(masked.n, 3);
  assert.equal(masked.short, 'ok');
  let deep = {};
  const root = deep;
  for (let i = 0; i < 10_000; i++) deep = deep.x = {};
  assert.doesNotThrow(() => maskDeep(root));
  assert.ok(boundedJson(root).includes(TOO_DEEP));
});

test('scan --json masks credentials in allow-lists, registries and bundled files, and survives a deep config and a pipe', { skip: WINDOWS }, () => {
  const t = tree();
  try {
    const home = path.join(t.dir, 'home');
    const proj = path.join(home, 'code', 'app');
    t.write('home/.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploy\n---\nRun the deploy.\n');
    t.write('home/.claude/skills/deploy/config.json', JSON.stringify({ key: OPENAI_KEY }));
    t.write('home/.npmrc', `registry=https://ci-bot:${URL_PASS}@artifactory.example.com/api/npm/\n`);
    t.write('home/code/app/.claude/settings.local.json', JSON.stringify({ permissions: { allow: [`Bash(PGPASSWORD=${URL_PASS} psql -h db)`, `Bash(psql postgresql://admin:${URL_PASS}@db.internal/app)`, `Bash(GITHUB_TOKEN=${GH_TOKEN} gh pr list)`] } }));
    t.write('home/.claude.json', JSON.stringify({ projects: { [proj]: {} } }));
    let deep = '[]';
    for (let i = 0; i < 10_000; i++) deep = `[${deep}]`;
    t.write('home/projects/cloned/.mcp.json', `{"mcpServers":{"deep":{"command":"node","args":["s.js"],"env":{"X":${deep}}}}}`);
    fs.mkdirSync(path.join(proj, '.claude', 'plugins'), { recursive: true });
    spawnSync('mkfifo', [path.join(proj, '.claude', 'plugins', 'installed_plugins.json')]);

    const r = runCli(home, home, ['scan', '--json']);
    assert.equal(r.status, 0, r.stderr || 'the scan did not finish');
    const out = JSON.parse(r.stdout);
    assert.ok(out.assets.length > 0);
    assert.ok(r.stdout.includes('artifactory.example.com'), 'the registry is still reported');
    for (const secret of [GH_TOKEN, OPENAI_KEY, URL_PASS]) assert.ok(!r.stdout.includes(secret), `${secret.slice(0, 6)}… must not be printed`);
  } finally {
    t.done();
  }
});

test('scan --report sends masked assets and artifacts', { skip: WINDOWS }, async () => {
  const t = tree();
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ assets: 0, critical: 0, high: 0, results: [], endpointId: 'e1' }));
    });
  });
  await new Promise((d) => server.listen(0, '127.0.0.1', d));
  try {
    const home = path.join(t.dir, 'home');
    const proj = path.join(t.dir, 'proj');
    fs.mkdirSync(home, { recursive: true });
    t.write('proj/.mcp.json', JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['server-github', `--token=${GH_TOKEN}`] } } }));
    t.write('proj/.claude/commands/ship.md', `---\ndescription: ship\n---\nexport OPENAI_API_KEY=${OPENAI_KEY}\n`);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'scan', '--report', '--json'], {
        cwd: proj,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', NOFLY_URL: `http://127.0.0.1:${server.address().port}`, NOFLY_API_KEY: 'nofly_test_key_inventory' },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    const body = seen.join('\n');
    assert.ok(body.includes('ship'), 'the report was sent');
    assert.ok(!body.includes(GH_TOKEN), 'the MCP token is masked before it leaves the machine');
    assert.ok(!body.includes(OPENAI_KEY), 'the key in a command is masked before it leaves the machine');
  } finally {
    await new Promise((d) => server.close(d));
    t.done();
  }
});

test('another user is not credited with the project the scan was started from', { skip: WINDOWS }, () => {
  const t = tree();
  const prev = process.cwd();
  try {
    const proj = path.join(t.dir, 'proj');
    t.write('proj/.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'nofly guard' }] }] } }));
    t.write('proj/.claude/hooks/run.sh', 'echo project script\n');
    t.write('bob/.claude.json', '{}');
    t.write('bob/.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash $CLAUDE_PROJECT_DIR/.claude/hooks/run.sh' }] }] } }));
    const bob = path.join(t.dir, 'bob');
    process.chdir(proj);
    const agent = discoverCodingAgents([], { home: bob }).find((a) => a.vendor === 'claude-code');
    assert.ok(agent, 'bob has Claude Code');
    assert.equal(agent.metadata.guarded, false, "the invoking user's project guard is not bob's");
    assert.ok(!JSON.stringify(agent).includes('Bash(rm:*)'), "the invoking user's project grants are not bob's");
    const hook = discoverAgentArtifacts(proj, null, { home: bob }).artifacts.find((a) => a.kind === 'hook');
    assert.ok(hook, "bob's hook is found");
    assert.ok(!JSON.stringify(hook).includes('project script'), "bob's hook does not bundle a script from the invoking user's project");
  } finally {
    process.chdir(prev);
    t.done();
  }
});

test('the folder being scanned is walked first with its own budget, heavy home trees are skipped, and a cut-short walk says so', () => {
  const t = tree();
  try {
    const home = path.join(t.dir, 'home');
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(home, `junk${String(i).padStart(2, '0')}`, 'deeper'), { recursive: true });
    t.write('home/Library/Caches/tool/.mcp.json', '{}');
    t.write('home/zz-work/app/.mcp.json', '{}');
    const proj = path.join(t.dir, 'proj');
    t.write('proj/.mcp.json', '{}');
    t.write('proj/sub/CLAUDE.md', '# Rules\n');

    const found = walkWorkspace([home, proj], { explicit: [proj], home, sharedDirs: 20, explicitDirs: 20 });
    const files = found.mcp.map((m) => path.relative(t.dir, m.file).split(path.sep).join('/'));
    assert.ok(files.includes('proj/.mcp.json'), 'the folder being scanned is never starved by the home walk');
    assert.ok(found.rules.some((r) => r.file.endsWith(path.join('proj', 'sub', 'CLAUDE.md'))));
    assert.ok(!files.some((f) => f.includes('Library')), 'a cache tree under home is not walked');
    assert.deepEqual(found.capped.map((c) => [c.reason, c.path]), [['walk-budget', home]], 'a walk cut short is listed');

    const full = walkWorkspace([home, proj], { explicit: [proj], home });
    assert.ok(full.mcp.some((m) => m.file.endsWith(path.join('zz-work', 'app', '.mcp.json'))));
    assert.deepEqual(full.capped, []);
  } finally {
    t.done();
  }
});

test('a headers helper command keeps its shape but never its credential', () => {
  const key = 'Zq3Lm9Xv2Bn7Kp4Rt8Wy1Hs6Jd5';
  const masked = maskServerSecrets({ type: 'http', url: 'https://mcp.example.com/mcp', headersHelper: `echo 'X-Api-Key: ${key}'` }).headersHelper;
  assert.ok(!masked.includes(key));
  assert.match(masked, /^echo 'X-Api-Key: [A-Za-z0-9]{27}'$/);
  const reference = 'echo "Authorization: Bearer $TOKEN"';
  assert.equal(maskServerSecrets({ headersHelper: reference }).headersHelper, reference);
  const plain = 'echo "X-Request-Source: claude-desktop-v1"';
  assert.equal(maskServerSecrets({ headersHelper: plain }).headersHelper, plain);
});

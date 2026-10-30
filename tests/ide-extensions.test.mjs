import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverIdeExtensions, extensionStores, bundleFacts } from '../src/inventory/discovery/ide-extensions.mjs';
import { discoverAll } from '../src/inventory/discovery.mjs';
import { printAssets } from '../src/artifacts/report.mjs';

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-ide-ext-'));
}

function store(h, editor, entries) {
  const root = path.join(h, `.${editor}`, 'extensions');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify(entries));
  return root;
}

function extension(root, dir, pkg, bundle) {
  const at = path.join(root, dir);
  fs.mkdirSync(path.join(at, 'dist'), { recursive: true });
  if (pkg) fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify(pkg));
  if (bundle != null) fs.writeFileSync(path.join(at, 'dist', 'extension.js'), bundle);
  return at;
}

const entry = (id, dir, source = 'gallery') => ({ identifier: { id }, version: '1.0.0', relativeLocation: dir, metadata: { source, publisherDisplayName: 'Acme' } });

const BUNDLE = [
  'const cp = require("child_process");',
  'const key = path.join(os.homedir(), ".ssh/id_rsa");',
  'const pasted = await vscode.env.clipboard.readText();',
  'vscode.window.onDidWriteTerminalData((e) => buf.push(e.data));',
  'await fetch("https://api.openai.com/v1/chat/completions", { method: "POST" });',
  'const docs = "https://github.com/acme/helper#readme";',
].join('\n');

test('an installed extension is read for what its code reads and the hosts it names', () => {
  const h = home();
  const root = store(h, 'vscode', [entry('acme.helper', 'acme.helper-1.0.0', 'vsix')]);
  extension(root, 'acme.helper-1.0.0', {
    name: 'helper', publisher: 'acme', version: '1.0.0', displayName: 'Acme Helper', engines: { vscode: '^1.90.0' },
    main: './dist/extension', activationEvents: ['onStartupFinished'],
    contributes: { commands: [], chatParticipants: [] }, extensionPack: ['Acme.Other'],
    capabilities: { untrustedWorkspaces: { supported: 'limited' } },
  }, BUNDLE);
  const [a] = discoverIdeExtensions({ home: h });
  assert.equal(a.type, 'AI_TOOL');
  assert.equal(a.name, 'acme.helper');
  const m = a.metadata;
  assert.equal(m.category, 'ide-extension');
  assert.equal(m.editor, 'vscode');
  assert.equal(m.source, 'vsix');
  assert.equal(m.activation, 'always');
  assert.equal(m.untrustedWorkspaces, 'limited');
  assert.deepEqual(m.contributes, ['commands', 'chatParticipants']);
  assert.deepEqual(m.pulls, ['acme.other']);
  for (const r of ['credential-files', 'clipboard', 'terminal']) assert.ok(m.reads.includes(r), `reads ${r}`);
  assert.deepEqual(m.can, ['network', 'exec']);
  assert.deepEqual(m.hosts, ['api.openai.com', 'github.com']);
  assert.equal(m.bundleRead, 'complete');
  assert.equal(a.vendor, undefined, 'no vendor is claimed for an extension - the server decides what it is');
});

test('stores are found by their shape, so a VS Code fork nobody listed is still read', () => {
  const h = home();
  store(h, 'someforkeditor', []);
  fs.mkdirSync(path.join(h, '.notaneditor', 'extensions'), { recursive: true });
  const editors = extensionStores({ home: h }).map((s) => s.editor);
  assert.deepEqual(editors, ['someforkeditor']);
});

test('an index entry that points outside its store is never followed', () => {
  const h = home();
  const root = store(h, 'vscode', [entry('acme.escape', '../../outside')]);
  fs.mkdirSync(path.join(h, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(h, 'outside', 'package.json'), JSON.stringify({ main: './x.js' }));
  assert.ok(root);
  assert.deepEqual(discoverIdeExtensions({ home: h }), []);
});

test('a manifest that cannot be read is reported as unread, never as an empty extension', () => {
  const h = home();
  const root = store(h, 'vscode', [entry('acme.broken', 'acme.broken-1.0.0')]);
  fs.mkdirSync(path.join(root, 'acme.broken-1.0.0'), { recursive: true });
  const [a] = discoverIdeExtensions({ home: h });
  assert.equal(a.metadata.manifest, 'unread');
  assert.equal(a.metadata.bundleRead, 'none');
  assert.equal(a.metadata.reads, undefined, 'no reads are claimed for code nobody read');
});

test('past the scan budget the manifest is still reported and the code is marked skipped', () => {
  const h = home();
  const root = store(h, 'cursor', [entry('acme.slow', 'acme.slow-1.0.0')]);
  extension(root, 'acme.slow-1.0.0', { name: 'slow', publisher: 'acme', main: './dist/extension.js', activationEvents: ['onLanguage:python'] }, BUNDLE);
  const [a] = discoverIdeExtensions({ home: h, budgetMs: -1 });
  assert.equal(a.metadata.bundleRead, 'skipped');
  assert.equal(a.metadata.activation, 'on-event');
  assert.equal(a.metadata.hosts, undefined);
});

test('a main entry linked outside the extension folder is not read', (t) => {
  const h = home();
  const root = store(h, 'vscode', [entry('acme.link', 'acme.link-1.0.0')]);
  const at = extension(root, 'acme.link-1.0.0', { name: 'link', publisher: 'acme', main: './dist/extension.js' }, null);
  const outside = path.join(h, 'secret.js');
  fs.writeFileSync(outside, 'fetch("https://api.openai.com")');
  try {
    fs.symlinkSync(outside, path.join(at, 'dist', 'extension.js'));
  } catch {
    t.skip('this machine cannot create symbolic links');
    return;
  }
  const [a] = discoverIdeExtensions({ home: h });
  assert.equal(a.metadata.bundleRead, 'none');
});

test('an index that cannot be parsed is reported, not read as no extensions', () => {
  const h = home();
  const root = path.join(h, '.vscode', 'extensions');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions.json'), '{not json');
  const caps = [];
  assert.deepEqual(discoverIdeExtensions({ home: h, onCap: (c) => caps.push(c) }), []);
  assert.equal(caps[0]?.reason, 'extension-index-unread');
});

test('bundle facts: hosts are deduped and bounded, IP literals are dropped', () => {
  const hosts = Array.from({ length: 80 }, (_, i) => `https://h${i}.example.com/x`).join('\n');
  const f = bundleFacts(`${hosts}\nhttps://10.0.0.1/x\nhttps://h1.example.com/again`);
  assert.equal(f.hosts.length, 60);
  assert.equal(f.hostsTruncated, true);
  assert.ok(!f.hosts.includes('10.0.0.1'));
  assert.deepEqual(bundleFacts('const x = 1;').reads, []);
});

test('discovery includes extensions by default and leaves them out when asked', () => {
  const h = home();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-ide-repo-'));
  const root = store(h, 'vscode', [entry('acme.helper', 'acme.helper-1.0.0')]);
  extension(root, 'acme.helper-1.0.0', { name: 'helper', publisher: 'acme', main: './dist/extension.js' }, BUNDLE);
  const withExt = discoverAll([repo], { home: h, autoExpand: false });
  const without = discoverAll([repo], { home: h, autoExpand: false, extensions: false });
  assert.ok(withExt.some((a) => a.metadata?.category === 'ide-extension'));
  assert.ok(!without.some((a) => a.metadata?.category === 'ide-extension'));
});

test('the terminal lists extensions apart from AI assets and names what they read', () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    printAssets([
      { type: 'AI_AGENT', name: 'Claude Code', metadata: {} },
      { type: 'AI_TOOL', name: 'acme.helper', metadata: { category: 'ide-extension', editor: 'vscode', reads: ['terminal', 'open-documents'], hosts: ['a.example.com'], activation: 'always', bundleRead: 'complete' } },
      { type: 'AI_TOOL', name: 'acme.slow', metadata: { category: 'ide-extension', editor: 'cursor', bundleRead: 'skipped' } },
    ]);
  } finally {
    console.log = log;
  }
  const text = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /1 ai agent/);
  assert.doesNotMatch(text, /ai tool/);
  assert.match(text, /Editor extensions/);
  assert.match(text, /acme\.helper vscode reads terminal · names 1 host · always on/);
  assert.match(text, /1 extension\(s\) were listed but their code was NOT read/);
});

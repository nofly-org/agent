import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverLocalRuntimes } from '../src/inventory/discovery/local-runtimes.mjs';
import {
  collectListenContext, listenScope, ollamaHostFromUnit, parseLsof, parseNetstat, parseSs, parseTasklist,
  readListeners, readOllamaHost, runtimeListen,
} from '../src/inventory/discovery/runtime-listen.mjs';

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-listen-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const OLLAMA = { vendor: 'ollama', proc: ['ollama'] };
const ollamaAsset = (home, processes, listen) => discoverLocalRuntimes({ home, processes, listen }).find((a) => a.vendor === 'ollama');

test('each platform listing is read into address, port and owning process', () => {
  const netstat = '  TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       4242\r\n  TCP    [::]:11434             [::]:0                 ABHÖREN         4242\r\n  TCP    127.0.0.1:5000         127.0.0.1:61000        ESTABLISHED     99\r\n  UDP    0.0.0.0:5353           *:*                                    77';
  assert.deepEqual(parseNetstat(netstat).map((l) => `${l.address}|${l.port}|${l.pid}`), ['0.0.0.0|11434|4242', '::|11434|4242']);
  assert.equal(parseTasklist('"ollama.exe","4242","Console","1","50,000 K"').get(4242), 'ollama.exe');
  const lsof = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nollama 812 dev 3u IPv4 0xabc 0t0 TCP *:11434 (LISTEN)\nLM\\x20Studio 900 dev 9u IPv4 0xdef 0t0 TCP 127.0.0.1:1234 (LISTEN)';
  assert.deepEqual(parseLsof(lsof).map((l) => `${l.command}|${l.address}|${l.port}`), ['ollama|*|11434', 'lm studio|127.0.0.1|1234']);
  const ss = 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=1234,fd=3))\nLISTEN 0 128 [::1]:8000 [::]:*';
  assert.deepEqual(parseSs(ss).map((l) => `${l.command ?? ''}|${l.address}|${l.port}|${l.pid ?? ''}`), ['ollama|0.0.0.0|11434|1234', '|::1|8000|']);
});

test('a bind is classified, and an empty Go-style host means every interface', () => {
  assert.equal(listenScope('0.0.0.0'), 'all-interfaces');
  assert.equal(listenScope('*'), 'all-interfaces');
  assert.equal(listenScope('::'), 'all-interfaces');
  assert.equal(listenScope(''), 'all-interfaces');
  assert.equal(listenScope('127.0.0.1'), 'loopback');
  assert.equal(listenScope('[::1]'), 'loopback');
  assert.equal(listenScope('192.168.1.20'), 'network');
});

test('Ollama listening on every interface, read from its socket, is reported as exposed', () => withHome((home) => {
  const a = ollamaAsset(home, ['ollama.exe'], { listeners: [{ address: '0.0.0.0', port: 11434, pid: 4242, command: 'ollama.exe' }], procArgs: null, ollamaHost: null });
  assert.deepEqual(a.metadata.listen, { address: '0.0.0.0', port: 11434, scope: 'all-interfaces', basis: 'socket' });
}));

test('OLLAMA_HOST on every interface with no socket reading is exposed on the configuration basis', () => withHome((home) => {
  const a = ollamaAsset(home, ['ollama'], { listeners: null, procArgs: null, ollamaHost: { value: '0.0.0.0:11434', where: 'OLLAMA_HOST' } });
  assert.equal(a.metadata.listen.scope, 'all-interfaces');
  assert.equal(a.metadata.listen.basis, 'config');
  assert.equal(a.metadata.listen.where, 'OLLAMA_HOST');
}));

test('a loopback socket is loopback, and the socket outranks the configuration', () => withHome((home) => {
  const a = ollamaAsset(home, ['ollama'], { listeners: [{ address: '127.0.0.1', port: 11434, pid: 1, command: 'ollama' }], procArgs: null, ollamaHost: { value: '0.0.0.0', where: 'OLLAMA_HOST' } });
  assert.equal(a.metadata.listen.scope, 'loopback');
  assert.equal(a.metadata.listen.basis, 'socket');
}));

test('nothing readable is unread - never assumed to be loopback', () => withHome((home) => {
  const a = ollamaAsset(home, ['ollama'], { listeners: [], procArgs: [], ollamaHost: null });
  assert.equal(a.metadata.listen.scope, 'unread');
  assert.equal(a.metadata.listen.basis, null);
}));

test('a failing platform command reads as unread and never throws', () => {
  const boom = () => { throw new Error('command not available'); };
  assert.equal(readListeners('win32', boom), null);
  assert.equal(readListeners('darwin', boom), null);
  const ctx = collectListenContext('linux', { run: boom, readText: () => null, listDir: () => [], env: {} });
  assert.deepEqual(ctx, { listeners: ctx.listeners, procArgs: null, ollamaHost: null });
  assert.equal(runtimeListen(OLLAMA, ctx).scope, 'unread');
});

test('a runtime that is not running gets no listen claim at all', () => withHome((home) => {
  fs.mkdirSync(path.join(home, '.ollama'), { recursive: true });
  const a = ollamaAsset(home, [], { listeners: [{ address: '0.0.0.0', port: 11434, pid: 1, command: 'ollama' }], procArgs: null, ollamaHost: null });
  assert.equal(a.metadata.running, false);
  assert.equal('listen' in a.metadata, false);
}));

test('the systemd override the Ollama docs describe is read on Linux', () => {
  assert.equal(ollamaHostFromUnit('[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n'), '0.0.0.0:11434');
  assert.equal(ollamaHostFromUnit('[Service]\n# Environment="OLLAMA_HOST=0.0.0.0"\nExecStart=/usr/bin/ollama serve\n'), null);
  const found = readOllamaHost('linux', { env: {}, listDir: () => ['/etc/systemd/system/ollama.service.d/override.conf'], readText: (f) => (f.endsWith('override.conf') ? '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' : null) });
  assert.deepEqual(found, { value: '0.0.0.0:11434', where: '/etc/systemd/system/ollama.service.d/override.conf' });
});

test('python-hosted servers are matched by their arguments, and documented launch flags count as configuration', () => {
  const procArgs = [{ pid: 77, args: 'python3 -m vllm.entrypoints.openai.api_server --model m' }];
  const vllmSocket = runtimeListen({ vendor: 'vllm', proc: ['vllm'] }, { listeners: [{ address: '0.0.0.0', port: 8000, pid: 77, command: 'python3' }], procArgs, ollamaHost: null });
  assert.deepEqual(vllmSocket, { address: '0.0.0.0', port: 8000, scope: 'all-interfaces', basis: 'socket' });
  const vllmFlag = runtimeListen({ vendor: 'vllm', proc: ['vllm'] }, { listeners: null, procArgs: [{ pid: 5, args: 'vllm serve m --host 0.0.0.0 --port 8001' }], ollamaHost: null });
  assert.equal(vllmFlag.scope, 'all-interfaces');
  assert.equal(vllmFlag.port, 8001);
  const textgen = runtimeListen({ vendor: 'textgen', proc: ['text-generation', 'oobabooga'] }, { listeners: null, procArgs: [{ pid: 6, args: 'python server.py --listen' }], ollamaHost: null });
  assert.equal(textgen.scope, 'all-interfaces');
  const localai = runtimeListen({ vendor: 'localai', proc: ['local-ai', 'localai'] }, { listeners: null, procArgs: [{ pid: 7, args: 'local-ai run --address 127.0.0.1:8080' }], ollamaHost: null });
  assert.equal(localai.scope, 'loopback');
});

test('another process on the default port is never attributed to the runtime', () => {
  const ctx = { listeners: [{ address: '0.0.0.0', port: 11434, pid: 9, command: 'node' }], procArgs: [{ pid: 9, args: 'node dev-server.js' }], ollamaHost: null };
  assert.equal(runtimeListen(OLLAMA, ctx).scope, 'unread');
});

test('a bind set in the runtime\'s own configuration is read when no socket is attributable', async () => {
  const lm = await import('../src/inventory/discovery/runtime-listen.mjs');
  const home = path.resolve('/home/dev');
  const lmFile = path.join(home, '.lmstudio', '.internal', 'http-server-config.json');
  const vllmCfg = path.resolve('/srv/vllm/serve.yaml');
  const tgDir = path.resolve('/opt/text-generation-webui');
  const tgFlags = path.join(tgDir, 'user_data', 'CMD_FLAGS.txt');
  const files = {
    [lmFile]: '{"port":1234,"networkInterface":"0.0.0.0","cors":false}',
    [vllmCfg]: 'model: org/model\nhost: 0.0.0.0 # all interfaces\nport: 8000\n',
    [tgFlags]: '# flags\n--api --listen --listen-port 7861\n',
  };
  const procArgs = [
    { pid: 7, args: `python3 -m vllm.entrypoints.openai.api_server --config ${vllmCfg}` },
    { pid: 9, args: `python ${path.join(tgDir, 'server.py')} --api` },
  ];
  const configFiles = lm.readConfigFiles(procArgs, home, (p) => files[path.resolve(p)] ?? null);
  assert.deepEqual(configFiles.map((c) => c.vendor).sort(), ['lmstudio', 'textgen', 'vllm']);
  const ctx = { listeners: [], procArgs, ollamaHost: null, configFiles };

  const lms = lm.runtimeListen({ vendor: 'lmstudio', proc: ['lm studio'] }, ctx);
  assert.deepEqual([lms.scope, lms.port, lms.basis, lms.where], ['all-interfaces', 1234, 'config', lmFile]);
  const vllm = lm.runtimeListen({ vendor: 'vllm', proc: ['vllm'] }, ctx);
  assert.deepEqual([vllm.scope, vllm.port, vllm.where], ['all-interfaces', 8000, vllmCfg]);
  const tg = lm.runtimeListen({ vendor: 'textgen', proc: ['text-generation'] }, ctx);
  assert.deepEqual([tg.scope, tg.port, tg.where], ['all-interfaces', 7861, tgFlags]);

  const loopback = { ...ctx, configFiles: [{ vendor: 'lmstudio', path: lmFile, text: '{"port":1234,"networkInterface":"127.0.0.1"}' }] };
  assert.equal(lm.runtimeListen({ vendor: 'lmstudio', proc: ['lm studio'] }, loopback).scope, 'loopback');
  assert.equal(lm.runtimeListen({ vendor: 'lmstudio', proc: ['lm studio'] }, { ...ctx, configFiles: [] }).scope, 'unread');
  assert.deepEqual(lm.readConfigFiles([{ pid: 1, args: 'vllm serve m --config relative.yaml' }], null, () => 'host: 0.0.0.0'), []);
  assert.deepEqual(lm.readConfigFiles(procArgs, home, () => { throw new Error('EACCES'); }), []);
  assert.equal(lm.lmStudioBind('not json'), null);
  assert.equal(lm.yamlScalar('port: 8000\n', 'host'), null);
  assert.equal(lm.flagFileArgs('# only a comment\n'), '');
});

test('agent platforms are matched to their socket by process arguments, and Langflow --host counts as configuration', () => {
  const n8n = runtimeListen({ vendor: 'n8n', proc: ['n8n'] }, { listeners: [{ address: '0.0.0.0', port: 5678, pid: 9, command: 'node' }], procArgs: [{ pid: 9, args: 'node /usr/lib/node_modules/n8n/bin/n8n start' }], ollamaHost: null });
  assert.deepEqual([n8n.scope, n8n.port, n8n.basis], ['all-interfaces', 5678, 'socket']);
  const flowise = runtimeListen({ vendor: 'flowise', proc: ['flowise'] }, { listeners: [{ address: '127.0.0.1', port: 3000, pid: 4, command: 'node' }], procArgs: [{ pid: 4, args: 'node /opt/flowise/bin/run start' }], ollamaHost: null });
  assert.equal(flowise.scope, 'loopback');
  const langflow = runtimeListen({ vendor: 'langflow', proc: ['langflow'] }, { listeners: null, procArgs: [{ pid: 5, args: 'python -m langflow run --host 0.0.0.0 --port 7860' }], ollamaHost: null });
  assert.deepEqual([langflow.scope, langflow.port, langflow.basis, langflow.where], ['all-interfaces', 7860, 'config', '--host']);
  const unrelated = runtimeListen({ vendor: 'n8n', proc: ['n8n'] }, { listeners: [{ address: '0.0.0.0', port: 5678, pid: 2, command: 'node' }], procArgs: [{ pid: 2, args: 'node server.js' }], ollamaHost: null });
  assert.equal(unrelated.scope, 'unread');
});

test('ComfyUI started with --listen is exposed; without it, it is unread', async () => {
  const lm = await import('../src/inventory/discovery/runtime-listen.mjs');
  const comfy = { vendor: 'comfyui', proc: ['comfyui'] };
  const ctx = (args) => ({ listeners: null, procArgs: [{ pid: 4, args }], ollamaHost: null });
  const bare = lm.runtimeListen(comfy, ctx('python /opt/ComfyUI/main.py --listen --port 8188'));
  assert.deepEqual([bare.scope, bare.port, bare.where], ['all-interfaces', 8188, '--listen']);
  assert.equal(lm.runtimeListen(comfy, ctx('python /opt/ComfyUI/main.py --listen 192.168.1.20')).scope, 'network');
  assert.equal(lm.runtimeListen(comfy, ctx('python /opt/ComfyUI/main.py --listen 127.0.0.1')).scope, 'loopback');
  assert.equal(lm.runtimeListen(comfy, ctx('python /opt/ComfyUI/main.py --port 8188')).scope, 'unread');
  assert.equal(lm.comfyListen('python main.py --listen-host x'), null);
});

test('on Windows the OLLAMA_HOST the Ollama docs set as a user variable is read from the registry', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args[1]);
    if (args[1] === 'HKCU\\Environment') return '\r\nHKEY_CURRENT_USER\\Environment\r\n    OLLAMA_HOST    REG_SZ    0.0.0.0:11434\r\n\r\n';
    throw new Error('not found');
  };
  const got = readOllamaHost('win32', { env: {}, run });
  assert.equal(got?.value, '0.0.0.0:11434');
  assert.match(got?.where ?? '', /HKCU\\Environment\\OLLAMA_HOST$/);
  const machine = readOllamaHost('win32', { env: {}, run: (cmd, args) => { if (args[1].startsWith('HKLM')) return 'OLLAMA_HOST    REG_EXPAND_SZ    10.0.0.4'; throw new Error('missing'); } });
  assert.equal(machine?.value, '10.0.0.4');
  assert.equal(readOllamaHost('win32', { env: {}, run: () => { throw new Error('missing'); } }), null);
  assert.equal(readOllamaHost('win32', { env: { OLLAMA_HOST: '127.0.0.1' }, run }).value, '127.0.0.1');
});

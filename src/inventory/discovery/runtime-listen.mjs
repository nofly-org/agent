import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLAT } from './platform.mjs';

const RUN_OPTS = { timeout: 4000, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
const MAX_UNIT_BYTES = 64 * 1024;
const WILDCARD = new Set(['', '*', '0.0.0.0', '::', '0:0:0:0:0:0:0:0']);
const OLLAMA_UNITS = ['/etc/systemd/system/ollama.service', '/usr/lib/systemd/system/ollama.service', '/lib/systemd/system/ollama.service'];
const OLLAMA_DROPIN = '/etc/systemd/system/ollama.service.d';
const OLLAMA_WIN_ENV = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
const LMSTUDIO_SERVER_CONFIG = ['.lmstudio', '.internal', 'http-server-config.json'];
const MAX_CONFIG_FILES = 8;
const TEXTGEN_FLAG_FILES = ['CMD_FLAGS.txt', path.join('user_data', 'CMD_FLAGS.txt')];

const defaultRun = (cmd, args) => execFileSync(cmd, args, RUN_OPTS);

const defaultRead = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_UNIT_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const defaultList = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.conf')).map((n) => path.posix.join(dir, n));
  } catch {
    return [];
  }
};

export function listenScope(address) {
  const a = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (WILDCARD.has(a)) return 'all-interfaces';
  if (a === 'localhost' || a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || /^::ffff:127\./.test(a)) return 'loopback';
  return 'network';
}

export function splitHostPort(raw) {
  const s = String(raw ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  const v6 = /^\[([^\]]*)\](?::(\d{1,5}))?$/.exec(s);
  if (v6) return { address: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const first = s.indexOf(':');
  if (first >= 0 && first === s.lastIndexOf(':')) {
    const port = s.slice(first + 1);
    return { address: s.slice(0, first), port: /^\d{1,5}$/.test(port) ? Number(port) : null };
  }
  return { address: s, port: null };
}

export function parseNetstat(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m) out.push({ ...splitHostPort(m[1]), pid: Number(m[2]), command: null });
  }
  return out;
}

export function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1].toLowerCase());
  }
  return names;
}

export function parseLsof(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(.+?)\s+(\d+)\s+.*\bTCP\s+(\S+)\s+\(LISTEN\)\s*$/.exec(line);
    if (m) out.push({ ...splitHostPort(m[3]), pid: Number(m[2]), command: m[1].trim().replace(/\\x20/g, ' ').toLowerCase() });
  }
  return out;
}

export function parseSs(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^LISTEN$/i.test(cols[0])) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({ ...splitHostPort(cols[3]), pid: users ? Number(users[2]) : null, command: users ? users[1].toLowerCase() : null });
  }
  return out;
}

export function parseProcessArgs(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

function firstFile(candidates) {
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

export function readListeners(platform = PLAT, run = defaultRun) {
  try {
    if (platform === 'win32') {
      const sys = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32');
      const names = parseTasklist(run(path.win32.join(sys, 'tasklist.exe'), ['/fo', 'csv', '/nh']));
      return parseNetstat(run(path.win32.join(sys, 'netstat.exe'), ['-ano'])).map((l) => ({ ...l, command: names.get(l.pid) ?? null }));
    }
    if (platform === 'darwin') return parseLsof(run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '+c', '0']));
    const ss = firstFile(['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss']);
    return ss ? parseSs(run(ss, ['-H', '-l', '-t', '-n', '-p'])) : null;
  } catch {
    return null;
  }
}

export function readProcessArgs(platform = PLAT, run = defaultRun) {
  if (platform === 'win32') return null;
  try {
    return parseProcessArgs(run('/bin/ps', ['-eo', 'pid=,args=']));
  } catch {
    return null;
  }
}

export function ollamaHostFromUnit(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/^\s*Environment\s*=/.test(line)) continue;
    const m = /OLLAMA_HOST=([^"'\s]*)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export function readOllamaHost(platform = PLAT, { env = process.env, run = defaultRun, readText = defaultRead, listDir = defaultList } = {}) {
  if (env?.OLLAMA_HOST) return { value: env.OLLAMA_HOST, where: 'OLLAMA_HOST' };
  if (platform === 'darwin') {
    try {
      const v = String(run('/bin/launchctl', ['getenv', 'OLLAMA_HOST']) ?? '').trim();
      if (v) return { value: v, where: 'launchctl getenv OLLAMA_HOST' };
    } catch {
      return null;
    }
  }
  if (platform === 'win32') {
    const reg = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'reg.exe');
    for (const key of OLLAMA_WIN_ENV) {
      try {
        const v = regValue(run(reg, ['query', key, '/v', 'OLLAMA_HOST']), 'OLLAMA_HOST');
        if (v) return { value: v, where: `${key}\\OLLAMA_HOST` };
      } catch {
        continue;
      }
    }
  }
  if (platform === 'linux') {
    for (const file of [...listDir(OLLAMA_DROPIN), ...OLLAMA_UNITS]) {
      const v = ollamaHostFromUnit(readText(file));
      if (v) return { value: v, where: file };
    }
  }
  return null;
}

export function collectListenContext(platform = PLAT, deps = {}) {
  const run = deps.run ?? defaultRun;
  const procArgs = readProcessArgs(platform, run);
  const configFiles = readConfigFiles(procArgs, deps.home ?? os.homedir(), deps.readText ?? defaultRead);
  return {
    listeners: readListeners(platform, run),
    procArgs,
    ollamaHost: readOllamaHost(platform, { run, readText: deps.readText, listDir: deps.listDir, env: deps.env }),
    ...(configFiles.length ? { configFiles } : {}),
  };
}

export function regValue(text, name) {
  const m = new RegExp(String.raw`^\s*${name}\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$`, 'im').exec(String(text ?? ''));
  return m && m[1] ? m[1] : null;
}

export function lmStudioBind(text) {
  let j;
  try {
    j = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const host = [j.networkInterface, j.host, j.bindAddress, j.hostname].find((v) => typeof v === 'string' && v.trim());
  if (!host) return null;
  const port = Number(j.port);
  return { address: host.trim(), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
}

export function yamlScalar(text, key) {
  const m = new RegExp(String.raw`^\s*${key}\s*:\s*["']?([^"'#\s]+)`, 'm').exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function flagFileArgs(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join(' ').trim();
}

function argValue(args, flag) {
  const m = new RegExp(String.raw`(?:^|\s)${flag}(?:=|\s+)(\S+)`).exec(args);
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

function argsFor(ctx, tokens) {
  return (ctx.procArgs ?? []).filter((p) => tokens.some((t) => p.args.toLowerCase().includes(t))).map((p) => p.args);
}

function textgenScriptDir(args) {
  const script = /(\S*server\.py)(?:\s|$)/.exec(args)?.[1]?.replace(/^["']|["']$/g, '');
  return script && path.isAbsolute(script) ? path.dirname(script) : null;
}

function configCandidates(procArgs, home) {
  const out = [];
  if (home) out.push({ vendor: 'lmstudio', path: path.join(home, ...LMSTUDIO_SERVER_CONFIG) });
  for (const { args } of procArgs ?? []) {
    const lower = String(args ?? '').toLowerCase();
    const config = lower.includes('vllm') ? argValue(args, '--config') : null;
    if (config && path.isAbsolute(config)) out.push({ vendor: 'vllm', path: config });
    const dir = /text-generation|oobabooga|server\.py/.test(lower) ? textgenScriptDir(args) : null;
    for (const rel of dir ? TEXTGEN_FLAG_FILES : []) out.push({ vendor: 'textgen', path: path.join(dir, rel) });
  }
  return out.slice(0, MAX_CONFIG_FILES);
}

export function readConfigFiles(procArgs, home, readText = defaultRead) {
  const out = [];
  for (const c of configCandidates(procArgs, home)) {
    let text = null;
    try {
      text = readText(c.path);
    } catch {
      text = null;
    }
    if (typeof text === 'string' && text.trim()) out.push({ ...c, text });
  }
  return out;
}

const configFile = (ctx, vendor, file = null) => (ctx.configFiles ?? []).find((c) => c.vendor === vendor && (file == null || c.path === file)) ?? null;

function textgenListen(a, where) {
  const host = argValue(a, '--listen-host');
  if (host) return { address: host, port: Number(argValue(a, '--listen-port')) || null, where: where ?? '--listen-host' };
  if (/(?:^|\s)--listen(?:\s|$)/.test(a)) return { address: '0.0.0.0', port: Number(argValue(a, '--listen-port')) || null, where: where ?? '--listen' };
  return null;
}

export function comfyListen(a) {
  const m = /(?:^|\s)--listen(?:[= ](?!-)([^\s]+))?(?=\s|$)/.exec(String(a ?? ''));
  if (!m) return null;
  const address = (m[1] ?? '0.0.0.0').split(',')[0].replace(/^["']|["']$/g, '');
  return { address, port: Number(argValue(a, '--port')) || null, where: '--listen' };
}

const CONFIG = {
  ollama: (ctx) => (ctx.ollamaHost ? { ...splitHostPort(ctx.ollamaHost.value), where: ctx.ollamaHost.where } : null),
  comfyui: (ctx) => {
    for (const a of argsFor(ctx, ['comfyui'])) {
      const hit = comfyListen(a);
      if (hit) return hit;
    }
    return null;
  },
  langflow: (ctx) => {
    for (const a of argsFor(ctx, ['langflow'])) {
      const host = argValue(a, '--host');
      if (host) return { address: host, port: Number(argValue(a, '--port')) || null, where: '--host' };
    }
    return null;
  },
  lmstudio: (ctx) => {
    const c = configFile(ctx, 'lmstudio');
    const bind = c ? lmStudioBind(c.text) : null;
    return bind ? { ...bind, where: c.path } : null;
  },
  vllm: (ctx) => {
    for (const a of argsFor(ctx, ['vllm'])) {
      const host = argValue(a, '--host');
      if (host) return { address: host, port: Number(argValue(a, '--port')) || null, where: '--host' };
      const config = argValue(a, '--config');
      const c = config ? configFile(ctx, 'vllm', config) : null;
      const fromFile = c ? yamlScalar(c.text, 'host') : null;
      if (fromFile) return { address: fromFile, port: Number(yamlScalar(c.text, 'port')) || null, where: c.path };
    }
    return null;
  },
  localai: (ctx) => {
    for (const a of argsFor(ctx, ['local-ai', 'localai'])) {
      const addr = argValue(a, '--address');
      if (addr) return { ...splitHostPort(addr), where: '--address' };
    }
    return null;
  },
  textgen: (ctx) => {
    for (const a of argsFor(ctx, ['text-generation', 'oobabooga', 'server.py'])) {
      const inline = textgenListen(a);
      if (inline) return inline;
      const dir = textgenScriptDir(a);
      for (const rel of dir ? TEXTGEN_FLAG_FILES : []) {
        const c = configFile(ctx, 'textgen', path.join(dir, rel));
        const fromFile = c ? textgenListen(flagFileArgs(c.text), c.path) : null;
        if (fromFile) return fromFile;
      }
    }
    return null;
  },
};

function ownsListener(listener, tokens, argsByPid) {
  const name = String(listener.command ?? '').replace(/\.exe$/, '');
  if (name && tokens.some((t) => name === t || name.startsWith(`${t} `) || name.startsWith(`${t}-`) || name.startsWith(`${t}_`))) return true;
  const args = listener.pid != null ? argsByPid.get(listener.pid) : null;
  return !!args && tokens.some((t) => args.toLowerCase().includes(t));
}

export function runtimeListen(runtime, ctx) {
  const argsByPid = new Map((ctx?.procArgs ?? []).map((p) => [p.pid, p.args]));
  const owned = (ctx?.listeners ?? []).filter((l) => ownsListener(l, runtime.proc ?? [], argsByPid));
  if (owned.length) {
    const pick = owned.find((l) => listenScope(l.address) !== 'loopback') ?? owned[0];
    return { address: pick.address, port: pick.port, scope: listenScope(pick.address), basis: 'socket' };
  }
  const cfg = CONFIG[runtime.vendor]?.(ctx ?? {});
  if (cfg) return { address: cfg.address, port: cfg.port ?? null, scope: listenScope(cfg.address), basis: 'config', where: cfg.where };
  return { address: null, port: null, scope: 'unread', basis: null };
}

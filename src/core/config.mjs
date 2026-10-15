import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFailure, readRegularText } from './safe-read.mjs';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const readConfigJson = (file) => JSON.parse(readRegularText(file, MAX_CONFIG_BYTES));

export const CONFIG_DIR = path.join(os.homedir(), '.shomra');

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function machineConfigFile(platform = process.platform, env = process.env) {
  if (platform === 'win32') return path.win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'Shomra', 'config.json');
  return '/etc/shomra/config.json';
}

export const MACHINE_CONFIG_FILE = machineConfigFile();

const MACHINE_SCOPED = Symbol('shomra.machineConfig');

export function isMachineConfig(cfg) {
  return !!cfg?.[MACHINE_SCOPED];
}

export function markMachineConfig(cfg) {
  Object.defineProperty(cfg, MACHINE_SCOPED, { value: true });
  return cfg;
}

export function loadMachineConfig(file = MACHINE_CONFIG_FILE) {
  try {
    const cfg = readConfigJson(file);
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

export function loadUserConfig(file = CONFIG_FILE) {
  try {
    const user = readConfigJson(file);
    return user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  } catch {
    return {};
  }
}

let warnedUnreadable = false;

function warnUnreadable(reason) {
  if (warnedUnreadable) return;
  warnedUnreadable = true;
  try {
    process.stderr.write(`[shomra] ${CONFIG_FILE} could not be read (${reason}) - this machine is treated as not enrolled until it is fixed. Re-run shomra init.\n`);
  } catch {
  }
}

export function loadConfig() {
  let user;
  try {
    user = readConfigJson(CONFIG_FILE);
  } catch (e) {
    if (e?.code !== 'ENOENT') warnUnreadable(e instanceof SyntaxError ? 'not valid JSON' : readFailure(e));
    const machine = loadMachineConfig();
    return machine ? markMachineConfig(machine) : {};
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    warnUnreadable('not a JSON object');
    const machine = loadMachineConfig();
    return machine ? markMachineConfig(machine) : {};
  }
  for (const k of ['apiKey', 'url']) {
    if (user[k] === undefined || isText(user[k])) continue;
    warnUnreadable(`"${k}" is not text`);
    delete user[k];
  }
  if (!user.apiKey || !user.url) {
    const machine = loadMachineConfig();
    for (const k of ['apiKey', 'url']) {
      if (!user[k] && isText(machine?.[k])) Object.defineProperty(user, k, { value: machine[k], enumerable: false, writable: true, configurable: true });
    }
  }
  return user;
}

function writePrivateJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw new Error(`${file} could not be written (${readFailure(error)}) - fix or move it, then run the command again.`);
  }
}

function restrictWindowsDir(dir, env = process.env) {
  const icacls = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'icacls.exe');
  execFileSync(icacls, [dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
}

export function saveMachineConfig(cfg, file = MACHINE_CONFIG_FILE) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') restrictWindowsDir(dir);
  else fs.chmodSync(dir, 0o700);
  writePrivateJson(file, { ...cfg });
}

export function saveConfig(cfg) {
  if (isMachineConfig(cfg)) return saveMachineConfig(cfg);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {}
  writePrivateJson(CONFIG_FILE, cfg);
}

export function inheritedMachineId(cfg, machine) {
  if (isText(cfg?.machineId) || isMachineConfig(cfg)) return null;
  return typeof machine?.machineId === 'string' && machine.machineId ? machine.machineId : null;
}

export function getMachineId(cfg, machine = loadMachineConfig()) {
  if (isText(cfg.machineId)) return cfg.machineId;
  const inherited = inheritedMachineId(cfg, machine);
  if (inherited) {
    cfg.machineId = inherited;
    try {
      saveConfig(cfg);
    } catch {}
    return cfg.machineId;
  }
  cfg.machineId = crypto.randomUUID();
  saveConfig(cfg);
  return cfg.machineId;
}

export function getMachineSerial(cfg, read) {
  if (isText(cfg.serial)) return cfg.serial;
  const serial = read();
  if (!serial) return null;
  cfg.serial = serial;
  try {
    saveConfig(cfg);
  } catch {}
  return serial;
}

export function parseBackendUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'no URL given' };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { error: `"${text}" is not a URL - include the scheme, e.g. https://shomra.example.com` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `the backend URL must start with http:// or https:// (got ${u.protocol})` };
  if (u.username || u.password) return { error: 'the backend URL must not carry a user name or password' };
  const host = u.protocol === 'http:' && u.hostname === 'localhost' ? `127.0.0.1${u.port ? `:${u.port}` : ''}` : u.host;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || /^127\./.test(u.hostname);
  return { url: `${u.protocol}//${host}${u.pathname.replace(/\/+$/, '')}`, cleartext: u.protocol === 'http:' && !loopback };
}

export function normalizeBackendUrl(raw) {
  const parsed = parseBackendUrl(raw);
  return parsed.url ?? (String(raw ?? '').trim().replace(/\/+$/, '') || null);
}

export function resolveSettings(cfg) {
  const pick = (...values) => values.find(isText)?.trim();
  const raw = pick(process.env.SHOMRA_URL, cfg?.url);
  return {
    apiKey: pick(process.env.SHOMRA_API_KEY, cfg?.apiKey),
    url: raw ? normalizeBackendUrl(raw) : null,
  };
}

export function storedAgentCredential(cfg, vendor, url) {
  const all = cfg?.agentCredentials;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  for (const key of [vendor, 'default']) {
    const e = key ? all[key] : null;
    if (!e || typeof e.credential !== 'string' || !e.credential.startsWith('shm_agt_')) continue;
    if (url && e.url && e.url !== url) continue;
    return e.credential;
  }
  return null;
}

export function saveAgentCredential(target, entry, file = CONFIG_FILE) {
  let cfg = {};
  try {
    const raw = readConfigJson(file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cfg = raw;
  } catch {}
  const all = cfg.agentCredentials && typeof cfg.agentCredentials === 'object' && !Array.isArray(cfg.agentCredentials) ? cfg.agentCredentials : {};
  cfg.agentCredentials = { ...all, [target]: entry };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  writePrivateJson(file, cfg);
  return file;
}

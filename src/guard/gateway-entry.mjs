import os from 'node:os';
import path from 'node:path';
import { readRegularText } from '../core/safe-read.mjs';

const MAX_ANCESTORS = 24;

export const MAX_ENTRY_LENGTH = 64;

export const clientServerKey = (name) => String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_');

export function managedMcpFile(platform = process.platform) {
  if (platform === 'darwin') return path.join('/Library', 'Application Support', 'ClaudeCode', 'managed-mcp.json');
  if (platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-mcp.json');
  return path.join('/etc', 'claude-code', 'managed-mcp.json');
}

function readJson(file) {
  try {
    return JSON.parse(readRegularText(file));
  } catch (error) {
    return error?.code === 'ENOENT' ? undefined : null;
  }
}

function within(cwd, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ancestors(cwd) {
  const out = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    out.push(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function serverMaps({ cwd, home, managedFile }) {
  const maps = [];
  const claude = readJson(path.join(home, '.claude.json'));
  if (claude === null) return null;
  if (isMap(claude)) {
    maps.push(claude.mcpServers);
    if (isMap(claude.projects)) {
      for (const [dir, project] of Object.entries(claude.projects)) if (within(cwd, dir)) maps.push(project?.mcpServers);
    }
  }
  for (const dir of ancestors(cwd)) {
    const doc = readJson(path.join(dir, '.mcp.json'));
    if (doc === null) return null;
    if (isMap(doc)) maps.push(doc.mcpServers);
  }
  if (managedFile) {
    const doc = readJson(managedFile);
    if (doc === null) return null;
    if (isMap(doc)) maps.push(doc.mcpServers);
  }
  return maps.filter(isMap);
}

function expand(value, env) {
  let unresolved = false;
  const out = String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const v = env[name];
    if (typeof v === 'string' && v !== '') return v;
    if (fallback !== undefined) return fallback;
    unresolved = true;
    return '';
  });
  return unresolved ? null : out;
}

export function endpointOf(raw) {
  try {
    const u = new URL(String(raw ?? ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function pointsAtGateway(def, gateway, env) {
  if (!isMap(def) || def.command != null || typeof def.url !== 'string') return false;
  if (def.type != null && String(def.type).toLowerCase() !== 'http') return false;
  const url = expand(def.url, env);
  return url !== null && endpointOf(url) === gateway;
}

export function gatewayEntryKey(tool, { url, cwd, home = os.homedir(), env = process.env, managedFile = managedMcpFile() } = {}) {
  const name = String(tool ?? '');
  if (!url || !name.startsWith('mcp__') || name.slice(5).split('__').length < 3) return null;
  const gateway = endpointOf(`${String(url).replace(/\/+$/, '')}/mcp`);
  if (!gateway) return null;
  const maps = serverMaps({ cwd: cwd || process.cwd(), home, managedFile });
  if (!maps) return null;

  const byKey = new Map();
  for (const servers of maps) {
    for (const [raw, def] of Object.entries(servers)) {
      const key = clientServerKey(raw);
      if (!key || !name.startsWith(`mcp__${key}__`)) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), def]);
    }
  }
  if (byKey.size !== 1) return null;

  const [[key, defs]] = byKey;
  if (key.length > MAX_ENTRY_LENGTH || !defs.every((d) => pointsAtGateway(d, gateway, env))) return null;
  const rest = name.slice(`mcp__${key}__`.length);
  const cut = rest.indexOf('__');
  return cut > 0 && cut + 2 < rest.length ? key : null;
}

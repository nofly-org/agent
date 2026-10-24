import os from 'node:os';
import path from 'node:path';
import { artifactKindFor } from './artifact-paths.mjs';
import { guardTouchedPaths } from './classify.mjs';
import { findMcpServerMap, normalizeServerEntry, parseConfigDoc, parseLaunch, programName } from '../detect/signals/mcp-config.mjs';
import { readRegularText } from '../core/safe-read.mjs';
import { redactLocally } from '../detect/local-redact.mjs';

export const MAX_PRIOR_BYTES = 4 * 1024 * 1024;
const MAX_PRIOR_FILES = 4;
const MAX_PRIOR_SERVERS = 200;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

const DEFAULT_PORT = { http: '80', https: '443', ws: '80', wss: '443' };

export function endpointOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    const port = u.port && u.port !== DEFAULT_PORT[scheme] ? `:${u.port}` : '';
    return `${scheme}://${host}${port}${u.pathname.replace(/\/+$/, '')}`.slice(0, 300);
  } catch {
    return null;
  }
}

export function identityOf(entry) {
  const command = entry.command ? programName(entry.command) || null : null;
  const pkg = entry.command ? parseLaunch(entry.command, entry.args ?? []).pkg : null;
  return { host: hostOf(entry.url), endpoint: endpointOf(entry.url), command, pkg: pkg ? pkg.toLowerCase() : null };
}

const survivesRedaction = (values) => values.every((v) => v == null || !redactLocally(String(v)).changed);

export function priorServers(text, file = '') {
  const doc = parseConfigDoc(text, file);
  if (!isObj(doc)) return null;
  const out = [];
  const add = (map, scope) => {
    if (!map) return;
    for (const [name, entry] of Object.entries(map)) {
      if (out.length >= MAX_PRIOR_SERVERS) return;
      const id = identityOf(normalizeServerEntry(name, entry));
      if (!survivesRedaction([name, scope, id.host, id.command, id.pkg])) continue;
      const endpoint = id.endpoint && survivesRedaction([id.endpoint]) ? id.endpoint : null;
      out.push({ name, ...(scope ? { scope } : {}), ...(id.host ? { host: id.host } : {}), ...(endpoint ? { endpoint } : {}), ...(id.command ? { command: id.command } : {}), ...(id.pkg ? { pkg: id.pkg } : {}) });
    }
  };
  const { projects, ...top } = doc;
  add(findMcpServerMap(top), null);
  if (isObj(projects)) {
    for (const [projectPath, proj] of Object.entries(projects)) {
      if (isObj(proj) && proj.mcpServers) add(findMcpServerMap({ mcpServers: proj.mcpServers }), projectPath);
    }
  }
  return out;
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);

export function priorMcpServersField(tool, input, normalized, read = (p) => readRegularText(p, MAX_PRIOR_BYTES)) {
  try {
    const out = [];
    const seen = new Set();
    for (const raw of guardTouchedPaths(tool, input)) {
      const named = String(raw ?? '');
      if (!named || artifactKindFor(named.replace(/\\/g, '/')) !== 'mcp') continue;
      const abs = path.resolve(normalized?.cwd || process.cwd(), expandHome(named));
      if (seen.has(abs)) continue;
      seen.add(abs);
      let text;
      try {
        text = read(abs);
      } catch {
        continue;
      }
      const servers = typeof text === 'string' ? priorServers(text, abs) : null;
      if (!servers) continue;
      out.push({ path: named, servers });
      if (out.length >= MAX_PRIOR_FILES) break;
    }
    return out.length ? { prior_mcp_servers: out } : {};
  } catch {
    return {};
  }
}

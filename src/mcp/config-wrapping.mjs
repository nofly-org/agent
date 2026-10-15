import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function serverMaps(config) {
  const maps = [];
  for (const key of ['mcpServers', 'servers']) if (isMap(config?.[key])) maps.push({ scope: null, servers: config[key] });
  if (isMap(config?.projects)) {
    for (const [project, entry] of Object.entries(config.projects)) {
      if (isMap(entry?.mcpServers)) maps.push({ scope: project, servers: entry.mcpServers });
    }
  }
  return maps;
}

export function serverEntries(config) {
  return serverMaps(config).flatMap(({ servers }) => Object.values(servers).filter(isMap));
}

function guardArgs(entry) {
  const args = Array.isArray(entry.args) ? entry.args : [];
  const at = args.indexOf('mcp-guard');
  return at > 0 && /(?:nofly|shomra)(?:\.mjs)?$/i.test(String(args[at - 1])) ? args : null;
}

function isShimmed(entry, selfPath) {
  const args = guardArgs(entry);
  return !!args && args.some((argument) => String(argument) === selfPath);
}

function staleShim(entry, selfPath) {
  return !!guardArgs(entry) && !isShimmed(entry, selfPath);
}

function skipReason(entry) {
  if (!entry.command) return entry.url ? 'http - mediated by the gateway' : 'no launch command';
  return null;
}

/**
 * The screening flag inside a wrapped launch line, set or replaced.
 * ⚠ It sits BEFORE `--`: everything after it is the real server's command.
 */
function withScreen(args, screen) {
  const separator = args.indexOf('--');
  const head = separator === -1 ? args.slice() : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator);
  const at = head.indexOf('--screen');
  if (at !== -1) head.splice(at, 2);
  if (screen) head.push('--screen', screen);
  return [...head, ...tail];
}

export function wrapMcpConfig(config, selfPath, execPath, opts = {}) {
  const wrapped = [];
  const skipped = [];
  const updated = [];
  for (const { scope, servers } of serverMaps(config)) {
    for (const [key, entry] of Object.entries(servers)) {
      if (!isMap(entry)) continue;
      const name = scope ? `${key} (${path.basename(scope)})` : key;
      const reason = skipReason(entry);
      if (reason) {
        skipped.push({ name, why: reason });
        continue;
      }
      if (staleShim(entry, selfPath)) {
        const args = guardArgs(entry);
        const at = args.indexOf('mcp-guard');
        servers[key] = { ...entry, command: execPath, args: withScreen([selfPath, ...args.slice(at)], opts.screen) };
        updated.push(name);
        continue;
      }
      if (isShimmed(entry, selfPath)) {
        if (opts.screen) {
          const next = withScreen(entry.args ?? [], opts.screen);
          if (JSON.stringify(next) !== JSON.stringify(entry.args ?? [])) {
            servers[key] = { ...entry, args: next };
            updated.push(name);
            continue;
          }
        }
        skipped.push({ name, why: 'already guarded' });
        continue;
      }
      servers[key] = {
        ...entry,
        command: execPath,
        args: withScreen([selfPath, 'mcp-guard', '--name', key, '--', entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], opts.screen),
      };
      wrapped.push(name);
    }
  }
  return { wrapped, skipped, updated };
}

export function unwrapMcpConfig(config, selfPath) {
  const restored = [];
  for (const { scope, servers } of serverMaps(config)) {
    for (const [key, entry] of Object.entries(servers)) {
      if (!isMap(entry) || !guardArgs(entry)) continue;
      const args = entry.args;
      const separator = args.indexOf('--');
      if (separator === -1 || !args[separator + 1]) continue;
      servers[key] = { ...entry, command: args[separator + 1], args: args.slice(separator + 2) };
      if (!servers[key].args.length) delete servers[key].args;
      restored.push(scope ? `${key} (${path.basename(scope)})` : key);
    }
  }
  return { restored };
}

function vscodeUserDir(app = 'Code') {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', app, 'User');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), app, 'User');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), app, 'User');
}

function claudeDesktopConfig() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

export function mcpConfigCandidates() {
  const home = os.homedir();
  const cwd = process.cwd();
  return [
    { label: 'Claude Code (project)', file: path.join(cwd, '.mcp.json') },
    { label: 'Claude Code (global and per-project)', file: path.join(home, '.claude.json') },
    { label: 'Claude Desktop', file: claudeDesktopConfig() },
    { label: 'Cursor (project)', file: path.join(cwd, '.cursor', 'mcp.json') },
    { label: 'Cursor (global)', file: path.join(home, '.cursor', 'mcp.json') },
    { label: 'VS Code (project)', file: path.join(cwd, '.vscode', 'mcp.json') },
    { label: 'VS Code (user)', file: path.join(vscodeUserDir(), 'mcp.json') },
    { label: 'Cline', file: path.join(vscodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json') },
    { label: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { label: 'Gemini CLI (project)', file: path.join(cwd, '.gemini', 'settings.json') },
    { label: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json') },
  ].filter((candidate, i, all) => fs.existsSync(candidate.file) && all.findIndex((c) => c.file === candidate.file) === i);
}

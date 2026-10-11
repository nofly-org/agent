import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHOMRA_ANY_HOOK_RE, shomraHookRe } from './hook-command.mjs';

export const CLINE_EVENTS = { PreToolUse: 'tool-guard', PostToolUse: 'result-guard' };

export function clineHookDirs(global) {
  if (!global) return [path.join(process.cwd(), '.clinerules', 'hooks'), path.join(process.cwd(), '.cline', 'hooks')];
  const home = os.homedir();
  const documents = path.join(home, 'Documents');
  const dirs = [path.join(documents, 'Cline', 'Hooks'), path.join(home, '.cline', 'hooks')];
  return fs.existsSync(documents) ? dirs : dirs.reverse();
}

export function copilotHookFile(global) {
  if (!global) return path.join(process.cwd(), '.github', 'hooks', 'shomra.json');
  const base = process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot');
  return path.join(base, 'hooks', 'shomra.json');
}

export function managedFile(agent, platform = process.platform, env = process.env) {
  const file = systemFile(agent, platform, env);
  const root = env.SHOMRA_MANAGED_ROOT;
  if (!file || !root) return file;
  return path.join(path.resolve(root), file.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''));
}

function systemFile(agent, platform, env) {
  switch (agent) {
    case 'claude':
      if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.d/50-shomra.json';
      if (platform === 'win32') return path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.d', '50-shomra.json');
      return '/etc/claude-code/managed-settings.d/50-shomra.json';
    case 'codex':
      return platform === 'win32' ? null : '/etc/codex/hooks.json';
    case 'copilot':
      if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'GitHub', 'Copilot', 'policy.d', '50-shomra.json');
      return '/etc/github-copilot/policy.d/50-shomra.json';
    default:
      return null;
  }
}

const CLINE_SCRIPT_MARK = /\/\/ shomra cline hook/;

/** Every settings file a vendor's hook could be installed in - user scope first, then this repo. */
export function agentHookFiles(agent) {
  const home = os.homedir();
  const cwd = process.cwd();
  switch (agent) {
    case 'claude': return [managedFile('claude'), path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json')].filter(Boolean);
    case 'codex': return [managedFile('codex'), path.join(home, '.codex', 'hooks.json'), path.join(cwd, '.codex', 'hooks.json')].filter(Boolean);
    case 'gemini': return [path.join(home, '.gemini', 'settings.json'), path.join(cwd, '.gemini', 'settings.json')];
    case 'cursor': return [path.join(home, '.cursor', 'hooks.json'), path.join(cwd, '.cursor', 'hooks.json')];
    case 'windsurf': return [path.join(home, '.codeium', 'windsurf', 'hooks.json'), path.join(cwd, '.windsurf', 'hooks.json')];
    case 'copilot': return [managedFile('copilot'), copilotHookFile(true), copilotHookFile(false)].filter(Boolean);
    case 'cline': return [...clineHookDirs(true), ...clineHookDirs(false)].flatMap((d) => Object.keys(CLINE_EVENTS).map((e) => path.join(d, e)));
    case 'aider': return [path.join(home, '.aider.conf.yml'), path.join(cwd, '.aider.conf.yml')];
    default: return [];
  }
}

export function agentHookInstalled(agent) {
  return agentHookFiles(agent).filter((f) => {
    try {
      const text = fs.readFileSync(f, 'utf8');
      if (agent === 'aider') return /shomra llm guard/i.test(text);
      if (agent === 'cline') return CLINE_SCRIPT_MARK.test(text);
      return SHOMRA_ANY_HOOK_RE.test(text);
    } catch {
      return false;
    }
  });
}

export function hasGroupedHook(list, verb) {
  const re = shomraHookRe(verb);
  return Array.isArray(list) && list.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => re.test(String(h.command || ''))));
}

export function hasFlatHook(list) {
  return Array.isArray(list) && list.some((h) => SHOMRA_ANY_HOOK_RE.test(String(h.command || '')));
}

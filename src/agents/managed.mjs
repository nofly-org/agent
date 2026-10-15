import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/json-file.mjs';
import { SELF_PATH, hookCommand } from './hook-command.mjs';
import { LEGACY_HOOK_NAME, managedFile } from './hook-files.mjs';
import { AGENT_UNINSTALLERS_AT, TOOL_GUARD_MATCHERS, copilotHooks, installCodexAt } from './installers.mjs';

export { managedFile };

export const MANAGED_AGENTS = ['claude', 'codex', 'copilot'];

function claudeManaged() {
  const run = (verb) => [{ type: 'command', command: hookCommand(`${verb} --agent claude`) }];
  return {
    hooks: {
      PreToolUse: [
        { matcher: TOOL_GUARD_MATCHERS.claude, hooks: run('tool-guard') },
        { matcher: 'ExitPlanMode', hooks: run('plan-guard') },
      ],
      PostToolUse: [{ matcher: 'WebFetch|WebSearch|Read|NotebookRead|mcp__.*', hooks: run('result-guard') }],
      UserPromptSubmit: [{ hooks: run('prompt-guard') }],
      SessionStart: [{ hooks: run('session-guard') }],
    },
  };
}

function writeOwned(file, value) {
  let current = null;
  try {
    current = fs.existsSync(file) ? readJsonFile(file) : null;
  } catch {
    current = null;
  }
  if (current && JSON.stringify(current) === JSON.stringify(value)) return false;
  writeJsonFile(file, value);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return true;
}

export const MANAGED_NOTES = {
  claude: 'Claude Code 2.1.83 or later reads this drop-in from managed settings; a higher-ranked managed source (server-managed settings or an MDM profile) makes it skip this folder unless that source sets managedSourcesBehavior: "merge". Check with /status.',
  codex: 'Codex treats hooks under /etc/codex as managed, so they run without a trust review.',
  copilot: 'Copilot CLI loads policy hooks before all others and they cannot be turned off with disableAllHooks.',
};

function removeLegacyManaged(agent) {
  if (agent !== 'claude' && agent !== 'copilot') return false;
  const legacy = managedFile(agent, process.platform, process.env, LEGACY_HOOK_NAME);
  if (!legacy || !fs.existsSync(legacy)) return false;
  fs.rmSync(legacy, { force: true });
  return true;
}

export function installManaged(agent) {
  const file = managedFile(agent);
  if (!file) return { file: null, changed: false, unsupported: true };
  const legacy = removeLegacyManaged(agent);
  if (agent === 'claude') return { file, changed: writeOwned(file, claudeManaged()) || legacy, note: MANAGED_NOTES.claude };
  if (agent === 'copilot') return { file, changed: writeOwned(file, copilotHooks(false)) || legacy, note: MANAGED_NOTES.copilot };
  const result = installCodexAt(file, false);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return { ...result, note: MANAGED_NOTES.codex };
}

export function uninstallManaged(agent) {
  const legacy = removeLegacyManaged(agent);
  const file = managedFile(agent);
  if (!file || !fs.existsSync(file)) return { file, changed: legacy, removed: legacy ? 1 : 0 };
  if (agent === 'codex') return AGENT_UNINSTALLERS_AT.codex(file);
  fs.rmSync(file, { force: true });
  return { file, changed: true, removed: 1 };
}

export function userWritableLauncher(targets = [process.execPath, SELF_PATH], platform = process.platform) {
  if (platform === 'win32') return null;
  for (const target of targets) {
    const hit = userWritablePath(target);
    if (hit) return hit;
  }
  return null;
}

function userWritablePath(target) {
  const given = path.resolve(target);
  let real = given;
  try {
    real = fs.realpathSync(given);
  } catch {
  }
  return userWritableChain(given) ?? (real === given ? null : userWritableChain(real));
}

function userWritableChain(start) {
  let cur = start;
  for (let i = 0; i < 64; i++) {
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      return null;
    }
    if (st.uid !== 0 || (st.mode & 0o022 && !(st.isDirectory() && st.mode & 0o1000))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

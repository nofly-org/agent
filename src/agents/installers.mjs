import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsFileError, readJsonFile, writeFileAtomic, writeJsonFile } from '../core/json-file.mjs';
import { LLM_PROXY_BASE, PACKAGE_SPEC, SHOMRA_ANY_HOOK_RE, SELF_PATH, hookCommand, powershellCommand, refreshedHookCommand } from './hook-command.mjs';
import { CLINE_EVENTS, clineHookDirs, copilotHookFile, hasFlatHook, hasGroupedHook } from './hook-files.mjs';
import { matcherFor } from './vendor-tools.mjs';

export const AGENT_LABELS = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  gemini: 'Gemini CLI',
  codex: 'OpenAI Codex CLI',
  copilot: 'GitHub Copilot CLI',
  cline: 'Cline',
  aider: 'Aider',
};

export const AGENT_KEYS = Object.keys(AGENT_LABELS);

/**
 * ⚠ THE MATCHER DECIDES WHETHER THE HOOK RUNS AT ALL, and a tool it does not
 * name is never screened - not locally, not by the server. Claude Code's own
 * `PowerShell` tool (the shell on Windows) was missing, so every `npm install`
 * and `docker run` an agent ran there reached no hook. Codex sends shell calls
 * as `Bash` and edits as `apply_patch` (`Edit|Write` alias to it, per the Codex
 * hooks docs); `apply_patch` and the older shell names are named explicitly so
 * the matcher does not rest on an alias.
 *
 * ⚠ DERIVED FROM `vendor-tools.mjs`, which is the ONE list of what each vendor
 * puts in front of the hook - the same list `shomra selftest` reads to say which
 * names an installed matcher is missing. Two copies is how `PowerShell` went
 * missing in the first place.
 */
export const TOOL_GUARD_MATCHERS = {
  claude: matcherFor('claude'),
  codex: matcherFor('codex'),
  cline: matcherFor('cline'),
};

/**
 * ⚠ AN UPGRADE MUST WIDEN AN EXISTING INSTALL, not only a fresh one. The
 * installer skipped any settings file that already had a Shomra tool-guard
 * group, so a machine installed before a name was added kept the old matcher
 * forever. Every missing required name is appended to the Shomra group's
 * matcher; names the user added are kept, and a match-all matcher is left alone.
 */
export function widenToolGuardMatcher(list, required) {
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (const g of list) {
    if (!Array.isArray(g?.hooks) || !g.hooks.some((h) => /\btool-guard\b/.test(String(h?.command || '')) && /shomra/i.test(String(h?.command || '')))) continue;
    const cur = typeof g.matcher === 'string' ? g.matcher : '';
    if (!cur || cur === '*' || cur === '.*') continue;
    const have = new Set(cur.split('|').map((s) => s.trim()));
    const missing = required.split('|').filter((n) => !have.has(n));
    if (!missing.length) continue;
    g.matcher = [...cur.split('|').map((s) => s.trim()).filter(Boolean), ...missing].join('|');
    changed = true;
  }
  return changed;
}

function refreshCommands(hooks) {
  let changed = false;
  for (const h of hooks) {
    if (!h || typeof h.command !== 'string' || !SHOMRA_ANY_HOOK_RE.test(h.command)) continue;
    const next = refreshedHookCommand(h.command);
    if (next !== h.command) {
      h.command = next;
      changed = true;
    }
  }
  return changed;
}

function refreshGrouped(container) {
  let changed = false;
  for (const list of Object.values(container ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const g of list) if (Array.isArray(g?.hooks) && refreshCommands(g.hooks)) changed = true;
  }
  return changed;
}

function refreshFlat(container) {
  let changed = false;
  for (const list of Object.values(container ?? {})) if (Array.isArray(list) && refreshCommands(list)) changed = true;
  return changed;
}

function hooksOf(settings, file) {
  if (settings.hooks === undefined || settings.hooks === null) settings.hooks = {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new SettingsFileError(`${file}: "hooks" is not an object - fix it first; nothing was changed.`);
  }
  return settings.hooks;
}

function eventList(container, key, file) {
  if (container[key] === undefined || container[key] === null) container[key] = [];
  if (!Array.isArray(container[key])) {
    throw new SettingsFileError(`${file}: "${key}" is not a list - fix it first; nothing was changed.`);
  }
  return container[key];
}

export function installCodexAt(file, portable) {
  const settings = readJsonFile(file);
  let changed = dropLegacyCodexEvents(settings);
  const hooks = hooksOf(settings, file);
  const pre = eventList(hooks, 'PreToolUse', file);
  const post = eventList(hooks, 'PostToolUse', file);
  const prompt = eventList(hooks, 'UserPromptSubmit', file);
  if (!hasGroupedHook(pre, 'tool-guard')) {
    pre.push({ matcher: TOOL_GUARD_MATCHERS.codex, hooks: [{ type: 'command', command: hookCommand('tool-guard --agent codex', { portable }) }] });
    changed = true;
  } else if (widenToolGuardMatcher(pre, TOOL_GUARD_MATCHERS.codex)) changed = true;
  if (!hasGroupedHook(post, 'result-guard')) {
    post.push({ matcher: 'WebFetch|WebSearch|web_search|Read|mcp__.*', hooks: [{ type: 'command', command: hookCommand('result-guard --agent codex', { portable }) }] });
    changed = true;
  }
  if (!hasGroupedHook(prompt, 'prompt-guard')) {
    prompt.push({ hooks: [{ type: 'command', command: hookCommand('prompt-guard --agent codex', { portable }) }] });
    changed = true;
  }
  if (refreshGrouped(hooks)) changed = true;
  if (changed) {
    writeJsonFile(file, settings);
  }
  return { file, changed };
}

export const AGENT_INSTALLERS = {
  claude(global) {
    const portable = !global;
    const dir = global ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude');
    const file = path.join(dir, 'settings.json');
    const settings = readJsonFile(file);
    const hooks = hooksOf(settings, file);
    const pre = eventList(hooks, 'PreToolUse', file);
    const post = eventList(hooks, 'PostToolUse', file);
    const prompt = eventList(hooks, 'UserPromptSubmit', file);
    const start = eventList(hooks, 'SessionStart', file);
    let changed = false;
    if (!hasGroupedHook(pre, 'tool-guard')) {
      pre.push({ matcher: TOOL_GUARD_MATCHERS.claude, hooks: [{ type: 'command', command: hookCommand('tool-guard --agent claude', { portable }) }] });
      changed = true;
    } else if (widenToolGuardMatcher(pre, TOOL_GUARD_MATCHERS.claude)) changed = true;
    if (!hasGroupedHook(post, 'result-guard')) {
      post.push({ matcher: 'WebFetch|WebSearch|Read|NotebookRead|mcp__.*', hooks: [{ type: 'command', command: hookCommand('result-guard --agent claude', { portable }) }] });
      changed = true;
    }

    if (!hasGroupedHook(prompt, 'prompt-guard')) {
      prompt.push({ hooks: [{ type: 'command', command: hookCommand('prompt-guard --agent claude', { portable }) }] });
      changed = true;
    }

    if (!hasGroupedHook(pre, 'plan-guard')) {
      pre.push({ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: hookCommand('plan-guard --agent claude', { portable }) }] });
      changed = true;
    }

    if (!hasGroupedHook(start, 'session-guard')) {
      start.push({ hooks: [{ type: 'command', command: hookCommand('session-guard --agent claude', { portable }) }] });
      changed = true;
    }
    if (refreshGrouped(hooks)) changed = true;
    if (changed) {
      writeJsonFile(file, settings);
    }
    return { file, changed };
  },

  codex(global) {
    const dir = global ? path.join(os.homedir(), '.codex') : path.join(process.cwd(), '.codex');
    return { ...installCodexAt(path.join(dir, 'hooks.json'), !global), note: CODEX_TRUST_NOTE };
  },

  gemini(global) {
    const portable = !global;
    const dir = global ? path.join(os.homedir(), '.gemini') : path.join(process.cwd(), '.gemini');
    const file = path.join(dir, 'settings.json');
    const settings = readJsonFile(file);
    const hooks = hooksOf(settings, file);
    const before = eventList(hooks, 'BeforeTool', file);
    const after = eventList(hooks, 'AfterTool', file);
    const prompt = eventList(hooks, 'BeforeAgent', file);
    let changed = false;
    if (!hasGroupedHook(before, 'tool-guard')) {
      before.push({ matcher: '.*', hooks: [{ type: 'command', command: hookCommand('tool-guard --agent gemini', { portable }) }] });
      changed = true;
    }
    if (!hasGroupedHook(after, 'result-guard')) {
      after.push({ matcher: '.*', hooks: [{ type: 'command', command: hookCommand('result-guard --agent gemini', { portable }) }] });
      changed = true;
    }
    if (!hasGroupedHook(prompt, 'prompt-guard')) {
      prompt.push({ hooks: [{ type: 'command', command: hookCommand('prompt-guard --agent gemini', { portable }) }] });
      changed = true;
    }
    if (refreshGrouped(hooks)) changed = true;
    if (changed) {
      writeJsonFile(file, settings);
    }
    return { file, changed };
  },

  cursor(global) {
    const portable = !global;
    const dir = global ? path.join(os.homedir(), '.cursor') : path.join(process.cwd(), '.cursor');
    const file = path.join(dir, 'hooks.json');
    const cfg = readJsonFile(file);
    if (cfg.version === undefined) cfg.version = 1;
    const hooks = hooksOf(cfg, file);
    let changed = false;
    const wire = (event, command) => {
      const list = eventList(hooks, event, file);
      if (!hasFlatHook(list)) {
        list.push({ command });
        changed = true;
      }
    };
    wire('beforeShellExecution', hookCommand('tool-guard --agent cursor', { portable }));
    wire('beforeMCPExecution', hookCommand('tool-guard --agent cursor', { portable }));
    wire('afterFileEdit', hookCommand('result-guard --agent cursor', { portable }));
    wire('afterMCPExecution', hookCommand('result-guard --agent cursor', { portable }));

    wire('beforeSubmitPrompt', hookCommand('prompt-guard --agent cursor', { portable }));
    if (refreshFlat(hooks)) changed = true;
    if (changed) {
      writeJsonFile(file, cfg);
    }
    return { file, changed };
  },

  windsurf(global) {
    const portable = !global;
    const dir = global ? path.join(os.homedir(), '.codeium', 'windsurf') : path.join(process.cwd(), '.windsurf');
    const file = path.join(dir, 'hooks.json');
    const cfg = readJsonFile(file);
    const hooks = hooksOf(cfg, file);
    let changed = false;
    const wire = (event, command) => {
      const list = eventList(hooks, event, file);
      if (!hasFlatHook(list)) {
        list.push({ command });
        changed = true;
      }
    };
    wire('pre_run_command', hookCommand('tool-guard --agent windsurf', { portable }));
    wire('pre_write_code', hookCommand('tool-guard --agent windsurf', { portable }));
    wire('pre_mcp_tool_use', hookCommand('tool-guard --agent windsurf', { portable }));
    wire('post_mcp_tool_use', hookCommand('result-guard --agent windsurf', { portable }));
    if (refreshFlat(hooks)) changed = true;
    if (changed) {
      writeJsonFile(file, cfg);
    }
    return { file, changed };
  },

  copilot(global) {
    const portable = !global;
    const file = copilotHookFile(global);
    const desired = copilotHooks(portable);
    let current = null;
    try {
      current = fs.existsSync(file) ? readJsonFile(file) : null;
    } catch {
      current = null;
    }
    if (current && JSON.stringify(current) === JSON.stringify(desired)) return { file, changed: false };
    writeJsonFile(file, desired);
    return { file, changed: true };
  },

  cline(global) {
    const portable = !global;
    const dir = clineHookDirs(global)[0];
    let changed = dropLegacyClineHooks(global);
    for (const [event, verb] of Object.entries(CLINE_EVENTS)) {
      const file = path.join(dir, event);
      const body = clineScript(verb, portable);
      let current = null;
      try {
        current = fs.readFileSync(file, 'utf8');
      } catch {
        current = null;
      }
      if (current === body) continue;
      if (current != null && !CLINE_MARK_RE.test(current)) {
        throw new SettingsFileError(`${file} already holds a ${event} hook that is not Shomra's - Cline runs one script per event, so merge it by hand; nothing was changed.`);
      }
      writeFileAtomic(file, body);
      fs.chmodSync(file, 0o755);
      changed = true;
    }
    return { file: dir, changed };
  },

  aider(global) {
    const portable = !global;
    const file = global ? path.join(os.homedir(), '.aider.conf.yml') : path.join(process.cwd(), '.aider.conf.yml');
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/#\s*shomra llm guard/i.test(text) || text.includes(LLM_PROXY_BASE)) {
      return { file, changed: false };
    }
    const existing = /^\s*openai-api-base\s*:\s*(\S.*)$/m.exec(text);
    if (existing) {
      return {
        file,
        changed: false,
        note: `${file} already sets openai-api-base (${existing[1].trim()}), so Shomra left it alone - a second key would silently replace yours. To screen Aider, point it at ${LLM_PROXY_BASE} and give shomra llm-proxy your endpoint as its upstream.`,
      };
    }
    const block =
      `\n# --- shomra llm guard ---\n` +
      `# Routes Aider's model traffic through the Shomra LLM Guard proxy so every\n` +
      `# prompt/response is policy-screened. Requires: shomra llm-proxy (running).\n` +
      `openai-api-base: ${LLM_PROXY_BASE}\n` +
      `# --- end shomra ---\n`;
    writeFileAtomic(file, (text.endsWith('\n') || !text ? text : text + '\n') + block);
    return { file, changed: true };
  },
};

const CODEX_TRUST_NOTE = 'Codex runs a new hook only after you trust it - approve the Shomra hooks in the review Codex shows at its next start, or they will not run.';

const COPILOT_TIMEOUT_SEC = 30;

function copilotEntry(args, portable) {
  if (portable) return { type: 'command', command: hookCommand(args, { portable }), timeoutSec: COPILOT_TIMEOUT_SEC };
  return { type: 'command', bash: hookCommand(args), powershell: powershellCommand(args), timeoutSec: COPILOT_TIMEOUT_SEC };
}

export function copilotHooks(portable) {
  return {
    version: 1,
    hooks: {
      preToolUse: [copilotEntry('tool-guard --agent copilot', portable)],
      postToolUse: [copilotEntry('result-guard --agent copilot', portable)],
    },
  };
}

const CLINE_MARK = '// shomra cline hook';
const CLINE_MARK_RE = /\/\/ shomra cline hook/;

export function clineScript(verb, portable) {
  const shebang = /\s/.test(process.execPath) ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  const run = portable
    ? `spawnSync('npx', ['-y', ${JSON.stringify(PACKAGE_SPEC)}, ${JSON.stringify(verb)}, '--agent', 'cline'], { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' })`
    : `spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(SELF_PATH)}, ${JSON.stringify(verb)}, '--agent', 'cline'], { stdio: 'inherit', windowsHide: true })`;
  return `${shebang}\n${CLINE_MARK}\nconst { spawnSync } = require('child_process');\nconst r = ${run};\nprocess.exit(typeof r.status === 'number' ? r.status : 0);\n`;
}

const CODEX_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];

function dropLegacyCodexEvents(settings) {
  let changed = false;
  for (const event of CODEX_EVENTS) {
    const list = settings[event];
    if (!Array.isArray(list) || !stripGrouped(list)) continue;
    changed = true;
    if (!list.length) delete settings[event];
  }
  return changed;
}

function dropLegacyClineHooks(global) {
  const file = global ? path.join(os.homedir(), '.cline', 'hooks.json') : path.join(process.cwd(), '.cline', 'hooks.json');
  if (!fs.existsSync(file)) return false;
  try {
    return uninstallJson(file, nestedStrip(stripGrouped)).changed;
  } catch {
    return false;
  }
}

const isShomraHook = (h) => SHOMRA_ANY_HOOK_RE.test(String(h?.command ?? h?.bash ?? h?.powershell ?? ''));

function stripGrouped(list) {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const group = list[i];
    if (!Array.isArray(group?.hooks)) continue;
    const kept = group.hooks.filter((h) => !isShomraHook(h));
    removed += group.hooks.length - kept.length;
    if (!kept.length) list.splice(i, 1);
    else if (kept.length !== group.hooks.length) group.hooks = kept;
  }
  return removed;
}

function stripFlat(list) {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isShomraHook(list[i])) {
      list.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

function stripEvents(container, strip) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return 0;
  let removed = 0;
  for (const [event, list] of Object.entries(container)) {
    if (!Array.isArray(list)) continue;
    const n = strip(list);
    removed += n;
    if (n && !list.length) delete container[event];
  }
  return removed;
}

function uninstallJson(file, strip, { dropWhen = (cfg) => !Object.keys(cfg).length } = {}) {
  if (!fs.existsSync(file)) return { file, changed: false, removed: 0 };
  const cfg = readJsonFile(file);
  const removed = strip(cfg);
  if (!removed) return { file, changed: false, removed: 0 };
  if (dropWhen(cfg)) fs.rmSync(file, { force: true });
  else writeJsonFile(file, cfg);
  return { file, changed: true, removed };
}

function nestedStrip(strip) {
  return (cfg) => {
    const removed = stripEvents(cfg.hooks, strip);
    if (removed && cfg.hooks && typeof cfg.hooks === 'object' && !Object.keys(cfg.hooks).length) delete cfg.hooks;
    return removed;
  };
}

const homeOrCwd = (global, ...parts) => (global ? path.join(os.homedir(), ...parts) : path.join(process.cwd(), ...parts));

const AIDER_BLOCK_RE = /\n?# --- shomra llm guard ---\n[\s\S]*?# --- end shomra ---\n?/;

function uninstallCopilot(global) {
  const file = copilotHookFile(global);
  if (!fs.existsSync(file)) return { file, changed: false, removed: 0 };
  const cfg = readJsonFile(file);
  const text = JSON.stringify(cfg);
  if (!SHOMRA_ANY_HOOK_RE.test(text)) return { file, changed: false, removed: 0 };
  fs.rmSync(file, { force: true });
  return { file, changed: true, removed: 1 };
}

function uninstallCline(global) {
  let removed = 0;
  for (const dir of clineHookDirs(global)) {
    for (const event of Object.keys(CLINE_EVENTS)) {
      const file = path.join(dir, event);
      let text = null;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!CLINE_MARK_RE.test(text)) continue;
      fs.rmSync(file, { force: true });
      removed++;
    }
  }
  if (dropLegacyClineHooks(global)) removed++;
  return { file: clineHookDirs(global)[0], changed: removed > 0, removed };
}

export const AGENT_UNINSTALLERS_AT = {
  codex: (file) => uninstallJson(file, (cfg) => nestedStrip(stripGrouped)(cfg) + stripEvents(cfg, stripGrouped)),
};

export const AGENT_UNINSTALLERS = {
  claude: (global) => uninstallJson(homeOrCwd(global, '.claude', 'settings.json'), nestedStrip(stripGrouped)),
  codex: (global) => AGENT_UNINSTALLERS_AT.codex(homeOrCwd(global, '.codex', 'hooks.json')),
  gemini: (global) => uninstallJson(homeOrCwd(global, '.gemini', 'settings.json'), nestedStrip(stripGrouped)),
  cline: uninstallCline,
  cursor: (global) => uninstallJson(homeOrCwd(global, '.cursor', 'hooks.json'), nestedStrip(stripFlat), {
    dropWhen: (cfg) => Object.keys(cfg).every((k) => k === 'version'),
  }),
  windsurf: (global) => uninstallJson(global ? path.join(os.homedir(), '.codeium', 'windsurf', 'hooks.json') : path.join(process.cwd(), '.windsurf', 'hooks.json'), nestedStrip(stripFlat)),
  copilot: uninstallCopilot,
  aider(global) {
    const file = homeOrCwd(global, '.aider.conf.yml');
    if (!fs.existsSync(file)) return { file, changed: false, removed: 0 };
    const text = fs.readFileSync(file, 'utf8');
    if (!AIDER_BLOCK_RE.test(text)) return { file, changed: false, removed: 0 };
    const next = text.replace(AIDER_BLOCK_RE, '');
    if (!next.trim()) fs.rmSync(file, { force: true });
    else writeFileAtomic(file, next);
    return { file, changed: true, removed: 1 };
  },
};

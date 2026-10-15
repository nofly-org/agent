import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from '../core/config.mjs';
import { stateDirs } from '../core/legacy.mjs';
import { SHELL_TOOLS_RE, WRITE_TOOLS, guardTouchedPaths, patchTextOf, shellCommandOf, shellWritePaths } from './classify.mjs';
import { NOFLY_ANY_HOOK_RE } from '../agents/hook-command.mjs';
import { postEditContents } from './memory-write.mjs';
import { readRegularText } from '../core/safe-read.mjs';

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
const MUTATE_VERB = /(?:^|[\s;&|(])(?:rm|rmdir|unlink|shred|truncate|mv|cp|install|dd|chmod|chown|chattr|ln|tee|sed|perl|remove-item|del|erase|rd|set-content|add-content|clear-content|out-file|new-item|copy-item|move-item|rename-item)(?=\s)|>/i;
const STATE_REF = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[\\/]\.(?:nofly|shomra)(?=[\\/\s"';|&)]|$)/i;
const ASK_CAPABLE = new Set(['claude', 'cursor', 'copilot', 'gemini', 'codex', 'cline']);
const MUTATING_LEAVES = new Set(['move_file', 'delete_file', 'remove_file', 'rename_file', 'copy_file']);
const HOOK_FILE_RE = /(?:^|[\\/])(?:\.claude[\\/]settings(?:\.local)?\.json|\.codex[\\/]hooks\.json|\.gemini[\\/]settings\.json|\.cursor[\\/]hooks\.json|\.codeium[\\/]windsurf[\\/]hooks\.json|\.windsurf[\\/]hooks\.json|\.copilot[\\/]hooks[\\/][^\\/]+\.json|\.github[\\/]hooks[\\/][^\\/]+\.json|\.cline[\\/]hooks\.json|(?:\.clinerules|\.cline)[\\/]hooks[\\/](?:PreToolUse|PostToolUse)(?:\.\w+)?|Cline[\\/]Hooks[\\/](?:PreToolUse|PostToolUse)(?:\.\w+)?)$/i;
const CLINE_MARK_RE = /\/\/ (?:nofly|shomra) cline hook/;
const ours = (text) => NOFLY_ANY_HOOK_RE.test(text) || CLINE_MARK_RE.test(text);
const IGNORE_FILE_RE = /(?:^|[\\/])\.(?:nofly|shomra)ignore$/i;
const DISABLE_HOOKS_RE = /["']?disableAllHooks["']?\s*:\s*true\b/i;
const GUARD_ENV_RE = /["']?(?:NOFLY|SHOMRA)_(?:GUARD_LOCAL|GUARD_IGNORE|MODEL_GUARD|MCP_SCREEN|URL|GUARD_TIMEOUT_MS|GUARD_BREAKER_MS)["']?\s*:|\b(?:NOFLY|SHOMRA)_(?:GUARD_LOCAL|GUARD_IGNORE|MODEL_GUARD|MCP_SCREEN|URL|GUARD_TIMEOUT_MS|GUARD_BREAKER_MS)=/gi;
const HOOK_COMMAND_RE = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const SELF_UNINSTALL_RE = /(?:\b(?:nofly|shomra)(?:\.mjs)?["']?|@(?:nofly|shomra)\/agent(?:@[\w.-]+)?)\s+install-hook\b[^\n;&|]*\s--uninstall\b/i;
const CHAINED_SHELL_RE = /[;&|`<>()]|\$\(/;

function deshelled(command) {
  return String(command).replace(/\\\r?\n/g, ' ').replace(/\$(?=['"])/g, '').replace(/["'\\]/g, '');
}

const REMOVERS = new Set(['rm', 'unlink', 'shred', 'truncate', 'mv', 'trash', 'trash-put', 'gio', 'del', 'erase', 'remove-item', 'ri', 'move-item', 'mi', 'rename-item', 'rni']);
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'nice', 'time', 'xargs']);

export function shellRemovedPaths(command) {
  const out = [];
  for (const segment of String(command ?? '').split(/\r?\n|&&|\|\||[;|&]/)) {
    const toks = [...(segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])].map((t) => t.replace(/^(["'])([\s\S]*)\1$/, '$2'));
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]) || PREFIXES.has(toks[i]))) i++;
    const verb = String(toks[i] ?? '').split(/[\\/]/).pop().toLowerCase();
    if (!REMOVERS.has(verb)) continue;
    const operands = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    const moved = verb === 'mv' || verb === 'move-item' || verb === 'mi' || verb === 'rename-item' || verb === 'rni';
    out.push(...(moved && operands.length > 1 ? operands.slice(0, -1) : operands));
  }
  return out;
}

export function selfUninstall(command) {
  return !!command && (SELF_UNINSTALL_RE.test(command) || SELF_UNINSTALL_RE.test(deshelled(command)));
}

function guardEnvCount(text) {
  return String(text).match(GUARD_ENV_RE)?.length ?? 0;
}

function chainedGuardCount(text) {
  let n = 0;
  for (const m of String(text).matchAll(HOOK_COMMAND_RE)) {
    const cmd = m[1];
    if (!NOFLY_ANY_HOOK_RE.test(cmd)) continue;
    const lead = /^\s*((?:[A-Za-z_]\w*=\S*\s+)*)/.exec(cmd)?.[1] ?? '';
    const foreignEnv = [...lead.matchAll(/([A-Za-z_]\w*)=/g)].some((a) => !/^(?:NOFLY|SHOMRA)_/i.test(a[1]));
    if (CHAINED_SHELL_RE.test(cmd) || foreignEnv) n++;
  }
  return n;
}

function mutatesPaths(tool) {
  const name = String(tool ?? '');
  const leaf = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return WRITE_TOOLS.has(name) || WRITE_TOOLS.has(leaf) || MUTATING_LEAVES.has(leaf.toLowerCase());
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function insideGuardState(p, { cwd = process.cwd(), home = os.homedir(), stateDir = CONFIG_DIR } = {}) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const raw = p.trim().replace(/^["']|["']$/g, '').replace(HOME_PREFIX, home);
  const abs = path.resolve(cwd || process.cwd(), raw);
  const dirs = stateDir === CONFIG_DIR ? [...new Set([stateDir, ...stateDirs(home)])] : [stateDir];
  const roots = dirs.flatMap((dir) => [path.resolve(dir), real(dir)]).filter(Boolean);
  const targets = [abs, real(abs)].filter(Boolean);
  return roots.some((root) => targets.some((t) => within(root, t)));
}

export function guardStateTamper(tool, input = {}, opts = {}) {
  const writes = [];
  const patch = patchTextOf(tool, input);
  if (mutatesPaths(tool) || patch) writes.push(...guardTouchedPaths(tool, input));
  const command = SHELL_TOOLS_RE.test(tool || '') || typeof input?.command === 'string' || Array.isArray(input?.argv) ? shellCommandOf(input) : '';
  if (command) writes.push(...shellWritePaths(command));
  const hits = [...new Set(writes.filter((p) => insideGuardState(p, opts)))];
  if (!hits.length && command && MUTATE_VERB.test(command)) {
    const stateDir = opts.stateDir ?? CONFIG_DIR;
    const ref = STATE_REF.exec(command) ?? (command.toLowerCase().includes(stateDir.toLowerCase()) ? [stateDir] : null);
    if (ref) hits.push(ref[0]);
  }
  return hits.length ? { paths: hits.slice(0, 5) } : null;
}

export function tamperReason(hit) {
  return `This call changes NoFly's own guard state (${hit.paths.join(', ')}) - the settings, credential and breaker the firewall screening this agent depends on. `
    + 'An agent has no reason to edit the guard that screens it; approve only if you asked for exactly this.';
}

export function refuseOrAsk(agent, strict) {
  return strict || !ASK_CAPABLE.has(agent) ? 'deny' : 'ask';
}

function proposedText(tool, input, target, cwd, read) {
  const i = input ?? {};
  if (typeof i.content === 'string' && !Array.isArray(i.edits)) return i.content;
  if (typeof i.file_text === 'string') return i.file_text;
  const post = postEditContents(tool, i, { cwd, read, keep: () => true });
  const hit = post.find((x) => path.resolve(cwd || process.cwd(), x.path) === target);
  return hit ? hit.content : null;
}

export function guardHookTamper(tool, input = {}, { cwd = process.cwd(), home = os.homedir(), read = (p) => readRegularText(p) } = {}) {
  const abs = (p) => path.resolve(cwd || process.cwd(), String(p).trim().replace(/^["']|["']$/g, '').replace(HOME_PREFIX, home));
  const command = SHELL_TOOLS_RE.test(tool || '') || typeof input?.command === 'string' || Array.isArray(input?.argv) ? shellCommandOf(input) : '';
  const direct = mutatesPaths(tool) || patchTextOf(tool, input) ? guardTouchedPaths(tool, input) : [];
  const removed = command ? shellRemovedPaths(command) : [];
  const viaShell = command ? [...shellWritePaths(command), ...removed] : [];
  const hits = [];
  const note = (p, why) => {
    if (!hits.some((h) => h.path === p)) hits.push({ path: p, why });
  };
  if (selfUninstall(command)) note('the coding agents\' hook settings', 'uninstall');
  for (const p of [...direct, ...viaShell]) {
    const target = abs(p);
    if (IGNORE_FILE_RE.test(target)) {
      note(p, 'ignore-list');
      continue;
    }
    if (!HOOK_FILE_RE.test(target)) continue;
    let current;
    try {
      current = read(target);
    } catch {
      continue;
    }
    if (!ours(current)) continue;
    const next = direct.includes(p) ? proposedText(tool, input, target, cwd, read) : null;
    if (removed.includes(p)) note(p, 'removes-hook');
    else if (next === null) note(p, 'rewrites');
    else if (!ours(next)) note(p, 'removes-hook');
    else if (DISABLE_HOOKS_RE.test(next) && !DISABLE_HOOKS_RE.test(current)) note(p, 'disables-hooks');
    else if (guardEnvCount(next) > guardEnvCount(current)) note(p, 'guard-env');
    else if (chainedGuardCount(next) > chainedGuardCount(current)) note(p, 'chains-hook');
  }
  return hits.length ? { paths: hits.map((h) => h.path).slice(0, 5), why: hits[0].why } : null;
}

const HOOK_TAMPER_WHY = {
  'removes-hook': 'removes the NoFly guard hook from',
  'disables-hooks': 'sets disableAllHooks, which stops every hook including the NoFly guard, in',
  'guard-env': 'sets a NOFLY_ variable that switches off or re-points the guard in',
  'chains-hook': 'wraps the NoFly guard hook in other commands, which then run on every screened call, in',
  rewrites: 'rewrites, with no way to check the NoFly guard hook survives,',
  'ignore-list': 'edits the list of paths the NoFly guard skips,',
  uninstall: 'runs `nofly install-hook --uninstall`, which removes the NoFly guard hook from',
};

export function hookTamperReason(hit) {
  return `This call ${HOOK_TAMPER_WHY[hit.why] ?? 'changes'} ${hit.paths.join(', ')}. That hook is what screens every tool call this agent makes; with it gone, nothing screens the calls after this one. `
    + 'An agent has no reason to switch off the guard that screens it; approve only if you asked for exactly this.';
}


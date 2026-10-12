import fs from 'node:fs';
import path from 'node:path';
import { CLI_ENTRY_PATH } from '../core/package-root.mjs';
import { VERSION } from '../core/version.mjs';

export const LLM_PROXY_BASE = process.env.SHOMRA_LLM_PROXY_BASE || 'http://127.0.0.1:4141/openai/v1';

export const SELF_PATH = CLI_ENTRY_PATH;

const POSIX_SAFE = /^[\w@%+=:,./-]+$/;

export function shQuote(argument) {
  const a = String(argument);
  return POSIX_SAFE.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

const forwardSlashes = (p) => String(p).replace(/\\/g, '/');

export function winQuote(argument) {
  const a = forwardSlashes(argument);
  if (POSIX_SAFE.test(a)) return a;
  if (!/["$`]/.test(a)) return `"${a}"`;
  return `'${a.replace(/'/g, "''")}'`;
}

export function psQuote(argument) {
  return `'${String(argument).replace(/'/g, "''")}'`;
}

function nodeOnPath(dir) {
  const want = path.resolve(dir).toLowerCase();
  const raw = process.env.PATH ?? process.env.Path ?? '';
  return String(raw).split(path.delimiter).some((d) => d && path.resolve(d).toLowerCase() === want);
}

export function launcher(platform = process.platform) {
  if (platform === 'win32') {
    const node = nodeOnPath(path.dirname(process.execPath)) ? 'node' : winQuote(process.execPath);
    return `${node} ${winQuote(SELF_PATH)}`;
  }
  return `${shQuote(process.execPath)} ${shQuote(SELF_PATH)}`;
}

export function powershellCommand(args) {
  return `& ${psQuote(process.execPath)} ${psQuote(SELF_PATH)} ${args}`;
}

export const PACKAGE_SPEC = `@shomra/agent@${VERSION}`;

export function hookCommand(args, opts = {}) {
  if (opts.portable) return `npx -y ${PACKAGE_SPEC} ${args}`;
  return `${launcher()} ${args}`;
}

export function shomraHookRe(verb) {
  return new RegExp(`(?:shomra(?:\\.mjs(?:\\\\?['"])?)?|@shomra/agent(?:@[\\w.\\-]+)?)\\s+${verb}`, 'i');
}

export const SHOMRA_ANY_HOOK_RE = /(?:shomra(?:\.mjs(?:\\?['"])?)?|@shomra\/agent(?:@[\w.\-]+)?)\s+(tool-guard|result-guard|prompt-guard|plan-guard|session-guard)/i;

const LAUNCH_RE = /(?:("[^"]*"|'[^']*'|[^\s"']+)\s+)?("[^"]*shomra\.mjs"|'[^']*shomra\.mjs'|[^\s"']*shomra\.mjs)(?=\s)/;
const unquote = (t) => String(t ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\(["\\$`])/g, '$1');

function missing(p) {
  if (!p || !path.isAbsolute(p.replace(/\//g, path.sep))) return false;
  try {
    return !fs.statSync(p).isFile();
  } catch {
    return true;
  }
}

export function refreshedHookCommand(command) {
  const text = String(command ?? '');
  const pin = /@shomra\/agent@([\w.\-]+)/.exec(text);
  if (pin) return pin[1] === VERSION ? text : text.replace(pin[0], PACKAGE_SPEC);
  const m = LAUNCH_RE.exec(text);
  if (!m) return text;
  const node = m[1] ? unquote(m[1]) : null;
  const script = unquote(m[2]);
  const nodeGone = node && node !== 'node' && /[\\/]/.test(node) && missing(node);
  if (!missing(script) && !nodeGone) return text;
  return `${text.slice(0, m.index)}${launcher()}${text.slice(m.index + m[0].length)}`;
}

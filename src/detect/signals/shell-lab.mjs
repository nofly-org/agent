                                                                     

                                                                                                

export const RUNTIME_OPERAND = '$RUNTIME_OPERAND';

const MAX_TEXT = 40_000;
const MAX_DEPTH = 4;
const MAX_COMMANDS = 400;
const MAX_VARS = 64;

const ESCAPABLE = new Set([' ', '\t', '"', "'", '\\', '|', ';', '&', '(', ')', '<', '>', '$', '`', '#', '*', '?', '[', ']', '{', '}', '!']);

const countLines = (s        )         => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

function closeParen(s        , from        )         {
  let depth = 1;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1);
      if (k < 0) return -1;
      j = k;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      while (k < s.length && s[k] !== '"') k += s[k] === '\\' ? 2 : 1;
      if (k >= s.length) return -1;
      j = k;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

const ANSI_C                         = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

function ansiC(text        , from        )                                 {
  let value = '';
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "'") return { value, end: i };
    if (c !== '\\' || i + 1 >= text.length) {
      value += c;
      continue;
    }
    const d = text[++i];
    const hex = d === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 1, i + 3)) : d === 'u' ? /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 1, i + 5)) : d === 'U' ? /^[0-9a-fA-F]{1,8}/.exec(text.slice(i + 1, i + 9)) : null;
    const oct = /^[0-7]$/.test(d) ? /^[0-7]{1,3}/.exec(text.slice(i, i + 3)) : null;
    if (hex) {
      const cp = parseInt(hex[0], 16);
      value += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      i += hex[0].length;
    } else if (oct) {
      value += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
      i += oct[0].length - 1;
    } else value += ANSI_C[d] ?? `\\${d}`;
  }
  return { value, end: text.length };
}

class Scanner {
           cmds               = [];
          words              = [];
          redirects                  = [];
          cur = '';
          has = false;
          subs             = [];
          redirect                = null;
          heredocs                                         = [];
  pipe        ;
          stage = 0;
          line = 1;
          cmdLine = 1;
                   text        ;
                   shell        ;

  constructor(text        , pipeBase        , shell        ) {
    this.text = text;
    this.pipe = pipeBase;
    this.shell = shell;
  }

          begin()       {
    if (!this.has && !this.words.length && !this.redirects.length && this.redirect === null) this.cmdLine = this.line;
    this.has = true;
  }

          endWord()       {
    if (!this.has) return;
    if (this.redirect !== null) {
      const r                = { op: this.redirect, target: this.cur };
      this.redirects.push(r);
      if (r.op === '<<' || r.op === '<<-') {
        r.body = '';
        if (this.heredocs.length < 16) this.heredocs.push({ r, strip: r.op === '<<-' });
      }
      this.redirect = null;
    } else this.words.push({ text: this.cur, subs: this.subs });
    this.cur = '';
    this.has = false;
    this.subs = [];
  }

  endCmd(next                          )       {
    this.endWord();
    this.redirect = null;
    if ((this.words.length || this.redirects.length) && this.cmds.length < MAX_COMMANDS) {
      this.cmds.push({ words: this.words, redirects: this.redirects, pipe: this.pipe, stage: this.stage, line: this.cmdLine });
    }
    this.words = [];
    this.redirects = [];

    if (next === 'pipe') this.stage++;
    else if (next === 'seq') {
      this.pipe++;
      this.stage = 0;
    }
  }

          heredocBodies(from        )         {
    const text = this.text;
    let pos = from;
    for (const { r, strip } of this.heredocs) {
      let body = '';
      while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        const end = nl < 0 ? text.length : nl;
        const raw = text.slice(pos, end).replace(/\r$/, '');
        const line = strip ? raw.replace(/^\t+/, '') : raw;
        pos = end + 1;
        this.line++;
        if (line === r.target) break;
        body += `${line}\n`;
      }
      r.body = body;
    }
    this.heredocs = [];
    return pos - 1;
  }

          sub(kind        , from        )         {
    const j = closeParen(this.text, from);
    const end = j < 0 ? this.text.length : j;
    const body = this.text.slice(from, end);
    this.subs.push({ kind, body });
    this.cur += `${kind}${body})`;
    this.line += countLines(body);
    return end;
  }

          tick(from        )         {
    const k = this.text.indexOf('`', from);
    const end = k < 0 ? this.text.length : k;
    const body = this.text.slice(from, end);
    this.subs.push({ kind: '`', body });
    this.cur += `\`${body}\``;
    this.line += countLines(body);
    return end;
  }

          squote(i        )         {
    const k = this.text.indexOf("'", i + 1);
    const end = k < 0 ? this.text.length : k;
    const body = this.text.slice(i + 1, end);
    this.cur += body;
    this.line += countLines(body);
    return end;
  }

          dquote(from        )         {
    const text = this.text;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === '"') return i;

      if (c === '\\' && i + 1 < text.length && this.shell !== 'cmd' && this.shell !== 'pwsh') {
        const d = text[i + 1];
        if (d === '"' || d === '\\' || d === '$' || d === '`') {
          this.cur += d;
          i++;
        } else if (d === '\n') {
          i++;
          this.line++;
        } else this.cur += c;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') i = this.sub('$(', i + 2);
      else if (c === '`' && this.shell !== 'pwsh') i = this.tick(i + 1);
      else {
        if (c === '\n') this.line++;
        this.cur += c;
      }
    }
    return text.length;
  }

          backslash(i        )         {
    const d = this.text[i + 1];
    if (d === '\n') {
      this.line++;
      return i + 1;
    }
    if (d === '\r' && this.text[i + 2] === '\n') {
      this.line++;
      return i + 2;
    }
    this.begin();

    const windowsPath = this.shell === 'cmd' || this.shell === 'pwsh' || /^[A-Za-z]:/.test(this.cur) || this.cur.includes('\\') || this.cur === '.' || this.cur === '..';
    if (d !== undefined && (ESCAPABLE.has(d) || !windowsPath)) {
      this.cur += d;
      return i + 1;
    }
    this.cur += '\\';
    return i;
  }

          redirectOp(i        )         {
    const text = this.text;
    const c = text[i];
    let fd = this.has;
    for (let k = 0; fd && k < this.cur.length; k++) if (this.cur.charCodeAt(k) < 48 || this.cur.charCodeAt(k) > 57) fd = false;
    if (fd) {
      this.cur = '';
      this.has = false;
    } else this.endWord();
    let op = c;
    if (text[i + 1] === c) {
      op += c;
      i++;
      if (c === '<' && text[i + 1] === '<') {
        op += '<';
        i++;
      }
    }
    if (text[i + 1] === '&') {
      op += '&';
      i++;
    } else if (op === '<<' && text[i + 1] === '-') {
      op += '-';
      i++;
    } else if (c === '>' && text[i + 1] === '|') i++;
    this.redirect = op;
    return i;
  }

          operator(i        )         {
    const text = this.text;
    const c = text[i];
    const n = text[i + 1];
    if (c === '\n') {
      this.endCmd('seq');
      this.line++;
      return this.heredocs.length ? this.heredocBodies(i + 1) : i;
    }
    if (c === ';') return this.endCmd('seq'), i;
    if (c === '(' || c === ')') return this.endCmd('group'), i;
    if (c === '&') {
      if (n === '>') {
        this.endWord();
        this.redirect = '&>';
        return text[i + 2] === '>' ? i + 2 : i + 1;
      }
      this.endCmd('seq');
      return n === '&' ? i + 1 : i;
    }
    if (c === '|') {
      this.endCmd(n === '|' ? 'seq' : 'pipe');
      return n === '|' || n === '&' ? i + 1 : i;
    }
    return -1;
  }

          quoting(i        )         {
    const text = this.text;
    const c = text[i];
    const n = text[i + 1];
    if (c === '\\') return this.backslash(i);

    if (c === '^' && this.shell === 'cmd' && n !== undefined) {
      this.begin();
      this.cur += n;
      return i + 1;
    }
    if (c === "'") return this.begin(), this.squote(i);
    if (c === '"') return this.begin(), this.dquote(i + 1);
    if (c === '`' && this.shell !== 'pwsh') return this.begin(), this.tick(i + 1);
    if (c === '$' && n === '(') return this.begin(), this.sub('$(', i + 2);

    if (c === '$' && n === "'" && this.shell !== 'pwsh') {
      this.begin();
      const { value, end } = ansiC(text, i + 1);
      this.cur += value;
      return end;
    }
    if (c === '$' && n === '"') return this.begin(), this.dquote(i + 2);
    if ((c === '<' || c === '>') && n === '(' && !this.has) return this.begin(), this.sub(`${c}(`, i + 2);
    return -1;
  }

  run()       {
    const text = this.text;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const q = this.quoting(i);
      if (q >= 0) i = q;
      else if (c === ' ' || c === '\t' || c === '\r') this.endWord();
      else if (c === '#' && !this.has) {
        const k = text.indexOf('\n', i);
        i = (k < 0 ? text.length : k) - 1;
      } else if (c === '>' || c === '<') i = this.redirectOp(i);
      else {
        const op = this.operator(i);
        if (op >= 0) i = op;
        else {
          this.begin();
          this.cur += c;
        }
      }
    }
    this.endCmd('seq');
  }
}

function scan(text        , pipeBase        , shell = 'sh')                                       {
  const s = new Scanner(text, pipeBase, shell);
  s.run();
  return { cmds: s.cmds, next: s.pipe + 1 };
}

function wordsOf(text        )              {
  return scan(text.slice(0, MAX_TEXT), 0).cmds[0]?.words ?? [];
}

export function programOf(word                           )         {
  let s = String(word ?? '');

  let end = s.length;
  while (end > 0 && ')]};,\'"'.includes(s[end - 1])) end--;
  let start = 0;
  while (start < end && '(["\''.includes(s[start])) start++;
  s = s.slice(start, end);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return s.slice(slash + 1).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VAR_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{', '}', 'nohup', 'builtin', 'noglob', 'call', 'chronic', 'unbuffer', 'setsid', 'caffeinate']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish']);
const SUDO_LONG = new Set(['--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user', '--chroot']);
const PS_VALUE = /^-(?:ex|exe|exec|execu|execut|executi|executio|execution|executionp|executionpo|executionpol|executionpoli|executionpolic|executionpolicy|ep|w|wi|win|window|windowstyle|if|inputformat|of|outputformat|config|configurationname|wd|workingdirectory|settingsfile|custompipename|v|version)$/i;

const KEEP_VAR = /registry|index|proxy|insecure|ssl|tls|trusted|userconfig|config_file|goflags|gonosum|gosumdb|ignore_scripts|only_binary|_yes$/i;

                                                                 

                                                               

       

function capped(base                                  , adds                    )                         {
  const out                         = { ...base };
  for (const [k, v] of adds) {
    delete out[k];
    out[k] = v;
  }
  const keys = Object.keys(out);
  for (let n = keys.length, i = 0; n > MAX_VARS && i < keys.length; i++) {
    if (KEEP_VAR.test(keys[i])) continue;
    delete out[keys[i]];
    n--;
  }
  const left = Object.keys(out);
  for (let i = 0; left.length - i > MAX_VARS; i++) delete out[left[i]];
  return out;
}

function skipOptions(w             , i        , shortValue        , longValue                     )         {
  while (i < w.length) {
    const t = w[i].text;
    if (t.length < 2 || t[0] !== '-') return i;
    if (t === '--') return i + 1;
    if (t.startsWith('--')) {
      i += !t.includes('=') && longValue.has(t) ? 2 : 1;
      continue;
    }
    let step = 1;
    for (let k = 1; k < t.length; k++) {
      if (shortValue.includes(t[k])) {
        if (k === t.length - 1) step = 2;
        break;
      }
    }
    i += step;
  }
  return i;
}

const joinFrom = (w             , i        )         => (i === w.length - 1 ? w[i].text : w.slice(i).map((x) => x.text).join(' '));

const joinQuoted = (w             , i        , q           )         =>
  i === w.length - 1 ? w[i].text : w.slice(i).map((x) => (/[\s|&;<>()]/.test(x.text) && !x.text.includes(q) ? `${q}${x.text}${q}` : x.text)).join(' ');
const plain = (text        )            => ({ text, subs: [] });

function decodePowerShell(b64        )                {
  if (!b64 || b64.length > 40_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf16le');
  } catch {
    return null;
  }
}

function literalOutput(w             , redirects                 )                {
  const p = programOf(w[0]?.text);

  if (p === 'cat' && w.length === 1) return redirects.find((r) => r.body !== undefined)?.body ?? redirects.find((r) => r.op === '<<<')?.target ?? null;
  if ((p !== 'echo' && p !== 'printf') || w.some((x) => x.subs.length)) return null;
  let i = 1;
  if (p === 'echo') while (i < w.length && /^-[neE]+$/.test(w[i].text)) i++;
  const text = w.slice(i).map((x) => x.text).join(' ');
  return p === 'printf' || w.slice(1, i).some((x) => x.text.includes('e')) ? text.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : text;
}

function expand(text        , ctx     , state       )       {
  if (ctx.depth > MAX_DEPTH || state.out.length >= MAX_COMMANDS) return;
  const { cmds, next } = scan(text.slice(0, MAX_TEXT), state.pipes, ctx.shell);
  state.pipes = next;
  if (ctx.pipeAt && cmds.length && cmds.every((c) => c.pipe === cmds[0].pipe)) {
    for (const c of cmds) {
      c.pipe = ctx.pipeAt.pipe;
      c.stage += ctx.pipeAt.stage;
    }
  }
  let printed                                                       = null;
  for (const raw of cmds) {

    if (ctx.depth < MAX_DEPTH) {
      for (const w of raw.words) for (const s of w.subs.slice(0, 8)) expand(s.body, { ...ctx, stdin: null, pipeAt: null, depth: ctx.depth + 1, line: ctx.line ?? raw.line }, state);
    }
    const stdin = printed && printed.pipe === raw.pipe && printed.stage === raw.stage - 1 ? printed.text : null;
    unwrap(raw, { ...ctx, stdin, pipeAt: null }, state);
    const out = literalOutput(raw.words, raw.redirects);
    printed = out !== null ? { pipe: raw.pipe, stage: raw.stage, text: out } : null;
    if (state.out.length >= MAX_COMMANDS) return;
  }
}

function skipPrefix(w             , i        , p        )         {
  if (KEYWORDS.has(p)) return i + 1;
  switch (p) {
    case 'time':
      return w[i + 1]?.text === '-p' ? i + 2 : i + 1;
    case 'sudo':
      return skipOptions(w, i + 1, 'ughpCDrtTU', SUDO_LONG);
    case 'doas':
      return skipOptions(w, i + 1, 'uC', new Set());
    case 'timeout':
      return skipOptions(w, i + 1, 'sk', new Set(['--signal', '--kill-after'])) + 1;
    case 'nice':
      return skipOptions(w, i + 1, 'n', new Set(['--adjustment']));
    case 'ionice':
      return skipOptions(w, i + 1, 'cnpt', new Set(['--class', '--classdata', '--pid', '--pgid', '--uid']));
    case 'stdbuf':
      return skipOptions(w, i + 1, 'ioe', new Set(['--input', '--output', '--error']));
    case 'exec':
      return skipOptions(w, i + 1, 'a', new Set());
    case 'command':
      return skipOptions(w, i + 1, '', new Set());
    case 'chroot':
      return skipOptions(w, i + 1, '', new Set(['--userspec', '--groups'])) + 1;
    case 'unshare':
      return skipOptions(w, i + 1, 'SGRw', new Set(['--setuid', '--setgid', '--root', '--wd']));
    case 'strace':
    case 'ltrace':
      return skipOptions(w, i + 1, 'eopsuEabIOSXP', new Set(['--output', '--attach', '--string-limit', '--user', '--env', '--trace', '--expr']));
    case 'corepack':
      return /^(?:npm|pnpm|yarn)$/.test(programOf(w[i + 1]?.text)) ? i + 1 : -1;
    case 'busybox':
      return SHELLS.has(programOf(w[i + 1]?.text)) ? i + 1 : -1;
    default:
      return -1;
  }
}

function shellPayload(w             , i        )                          {
  let code = false;
  let k = i + 1;
  for (; k < w.length; k++) {
    const o = w[k].text;
    if (o === '-o' || o === '+o' || o === '-O' || o === '+O' || o === '--rcfile' || o === '--init-file') {
      k++;
      continue;
    }
    if (o === '--command') {
      code = true;
      continue;
    }
    if (o === '-') return code ? null : 'stdin';
    if (o === '--') {
      k++;
      break;
    }
    if (o.startsWith('--')) continue;
    if (o.length > 1 && (o[0] === '-' || o[0] === '+') && /^[a-zA-Z]+$/.test(o.slice(1))) {
      if (o[0] === '-' && o.includes('c')) code = true;
      else if (o[0] === '-' && o.includes('s')) return 'stdin';
      continue;
    }
    break;
  }
  if (code) return k < w.length ? w[k].text : null;
  return k >= w.length ? 'stdin' : null;
}

function cmdPayload(w             , i        )                {
  let k = i + 1;
  while (k < w.length && /^\/[a-z](?::\w+)?$/i.test(w[k].text) && !/^\/[ck]$/i.test(w[k].text)) k++;
  const glued = /^\/[ck](.+)$/is.exec(w[k]?.text ?? '');
  if (glued) return k + 1 < w.length ? `${glued[1]} ${joinQuoted(w, k + 1, '"')}` : glued[1];
  return k + 1 < w.length && /^\/[ck]$/i.test(w[k].text) ? joinQuoted(w, k + 1, '"') : null;
}

function pwshPayload(w             , i        , p        )                {
  for (let k = i + 1; k < w.length; k++) {
    const o = w[k].text;
    const l = o.toLowerCase();
    if (o === '-') return null;
    if (o[0] !== '-' && o[0] !== '/') {

      return p !== 'pwsh' && !/\.ps1$/i.test(o) ? joinQuoted(w, k, "'") : null;
    }
    if (l === '-c' || (l.length >= 4 && '-command'.startsWith(l))) return k + 1 >= w.length || w[k + 1].text === '-' ? null : joinQuoted(w, k + 1, "'");
    if (l === '-e' || l === '-ec' || (l.length >= 3 && '-encodedcommand'.startsWith(l))) return decodePowerShell(w[k + 1]?.text ?? '');
    if (l === '-f' || (l.length >= 3 && '-file'.startsWith(l))) return null;
    if (PS_VALUE.test(o)) k++;
  }
  return null;
}

function envWords(w             , i        )                                     {
  i++;
  while (i < w.length && w[i].text.length > 1 && w[i].text[0] === '-') {
    const o = w[i].text;
    if (o === '--') return { words: w, at: i + 1 };
    if (o === '-S' || o === '--split-string' || o.startsWith('--split-string=')) {
      const s = o.startsWith('--split-string=') ? o.slice(15) : w[i + 1]?.text ?? '';
      return { words: [...wordsOf(s), ...w.slice(o.includes('=') ? i + 1 : i + 2)], at: 0 };
    }
    i += o === '-u' || o === '--unset' || o === '-C' || o === '--chdir' ? 2 : 1;
  }
  return { words: w, at: i };
}

function inlineCode(w             , i        , p        )                                                           {
  const lang = /^(?:python[0-9.]*w?|py)$/.test(p) ? 'py' : p === 'node' || p === 'nodejs' || p === 'bun' || p === 'deno' ? 'js' : p === 'ruby' ? 'rb' : p === 'perl' ? 'pl' : null;
  if (!lang) return null;
  for (let k = i + 1; k < w.length; k++) {
    const t = w[k].text;
    const code =
      lang === 'py' ? /^-[a-zA-Z]*c$/.test(t) : lang === 'js' ? (p === 'deno' ? t === 'eval' : /^(?:-e|--eval|-p|--print)$/.test(t)) : /^-[a-zA-Z]*[eE]$/.test(t);
    if (code) return w[k + 1] ? { lang, code: w[k + 1].text.slice(0, MAX_TEXT) } : null;

    if (!t.startsWith('-') && !(p === 'deno' && k === i + 1 && t !== 'eval')) return null;
  }
  return null;
}

function literalAt(code        , from        )                                        {
  let i = from;
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
  if (code[i] === '[') {
    const items           = [];
    i++;
    for (let n = 0; n < 200; n++) {
      while (i < code.length && /[\s,]/.test(code[i])) i++;
      if (code[i] === ']') return { value: items.join(' '), end: i + 1 };
      const item = literalAt(code, i);
      if (!item) return null;
      items.push(/\s/.test(item.value) ? `'${item.value.replace(/'/g, `'\\''`)}'` : item.value);
      i = item.end;
    }
    return null;
  }
  if (/[rRbB]/.test(code[i] ?? '') && /['"]/.test(code[i + 1] ?? '')) i++;
  const q = code[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let value = '';
  for (let k = i + 1; k < code.length; k++) {
    const c = code[k];
    if (c === q) return { value, end: k + 1 };

    if ((q === '`' && c === '$' && code[k + 1] === '{') || (c === '#' && code[k + 1] === '{' && q === '"')) return null;
    if (c === '\\' && k + 1 < code.length) {
      const d = code[++k];
      value += d === 'n' ? '\n' : d === 't' ? '\t' : d;
    } else value += c;
  }
  return null;
}

const EXEC_API                                            = {
  py: /\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))\s*\(/g,
  js: /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/g,
  rb: /(?:\b(?:system|exec|spawn)\s*\(?|%x[{(\[])/g,
  pl: /(?:\b(?:system|exec)\s*\(?|\bqx[{(\[])/g,
};

function codeCommands(w             , i        , p        )           {
  const inline = inlineCode(w, i, p);
  if (!inline) return [];
  const { lang, code } = inline;
  const out           = [];
  const re = new RegExp(EXEC_API[lang].source, 'g');
  for (let m = re.exec(code); m && out.length < 10; m = re.exec(code)) {
    const opener = m[0].slice(-1);

    if ((lang === 'rb' || lang === 'pl') && /[{(\[]/.test(opener) && /(?:%x|qx)[{(\[]$/.test(m[0])) {
      const close = code.indexOf(({ '{': '}', '(': ')', '[': ']' }                          )[opener], re.lastIndex);
      if (close > 0) out.push(code.slice(re.lastIndex, close));
      continue;
    }
    const first = literalAt(code, re.lastIndex);
    if (!first) continue;

    let cmd = first.value;
    for (let k = first.end, n = 0; n < 50; n++) {
      while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k++;
      if (code[k] !== ',') break;
      const next = literalAt(code, k + 1);
      if (!next) break;
      cmd += ` ${next.value}`;
      k = next.end;
    }
    out.push(cmd);
  }

  if (lang === 'rb' || lang === 'pl') {
    for (let k = code.indexOf('`'), n = 0; k >= 0 && n < 10; n++) {
      const end = code.indexOf('`', k + 1);
      if (end < 0) break;
      if (!code.slice(k + 1, end).includes('#{')) out.push(code.slice(k + 1, end));
      k = code.indexOf('`', end + 1);
    }
  }
  return out.slice(0, 10);
}

function withOperand(words             , placeholder        , append         )              {
  let hit = false;
  const out = words.map((x) => (x.text === placeholder ? ((hit = true), plain(RUNTIME_OPERAND)) : x));
  return hit || !append ? out : [...out, plain(RUNTIME_OPERAND)];
}

function peelWrapper(w             , i        , p        )         {
  const rest = w.slice(i + 1);
  const valueOf = (names          )                => {
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k].text;
      if (names.includes(t)) return rest[k + 1]?.text ?? null;
      const eq = t.indexOf('=');
      if (eq > 0 && names.includes(t.slice(0, eq))) return t.slice(eq + 1);
    }
    return null;
  };
  switch (p) {
    case 'su': {
      const code = valueOf(['-c', '--command']);
      const user = rest.find((x, k) => !x.text.startsWith('-') && rest[k - 1]?.text !== '-c' && rest[k - 1]?.text !== '--command' && rest[k - 1]?.text !== '-s')?.text;
      return code === null ? null : { payload: code, shell: 'sh', elevated: !user || user === 'root' };
    }
    case 'script': {
      const k = rest.findIndex((x) => x.text === '--command' || /^-[a-zA-Z]*c$/.test(x.text));
      return k >= 0 && rest[k + 1] ? { payload: rest[k + 1].text, shell: 'sh' } : null;
    }
    case 'xargs': {
      const at = skipOptions(w, i + 1, 'IaLndPsEi', new Set(['--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines', '--eof', '--max-chars']));
      const repl = valueOf(['-I', '--replace']) ?? (rest.some((x) => x.text === '-i') ? '{}' : null);
      return at < w.length ? { words: withOperand(w.slice(at), repl ?? '\u0000', true) } : null;
    }
    case 'find': {
      const k = rest.findIndex((x) => /^-(?:exec|execdir|ok|okdir)$/.test(x.text));
      if (k < 0) return null;
      let end = k + 1;
      while (end < rest.length && rest[end].text !== ';' && rest[end].text !== '+') end++;
      return end > k + 1 ? { words: withOperand(rest.slice(k + 1, end), '{}', false) } : null;
    }
    case 'watch': {
      const at = skipOptions(w, i + 1, 'nq', new Set(['--interval', '--differences']));
      return at < w.length ? { payload: joinFrom(w, at), shell: 'sh' } : null;
    }
    case 'flock': {
      const at = skipOptions(w, i + 1, 'wEF', new Set(['--timeout', '--conflict-exit-code']));
      if (w[at + 1]?.text === '-c' || w[at + 1]?.text === '--command') return w[at + 2] ? { payload: w[at + 2].text, shell: 'sh' } : null;
      return at + 1 < w.length ? { words: w.slice(at + 1) } : null;
    }
    case 'parallel': {
      const sep = rest.findIndex((x) => x.text === ':::');
      const at = skipOptions(w, i + 1, 'jSnN', new Set(['--jobs', '--sshlogin']));
      const cmd = w.slice(at, sep < 0 ? w.length : i + 1 + sep);
      const args = sep < 0 ? [plain(RUNTIME_OPERAND)] : rest.slice(sep + 1).filter((x) => x.text !== ':::');
      const hasSlot = cmd.some((x) => x.text === '{}');
      return cmd.length ? { words: hasSlot ? cmd.map((x) => (x.text === '{}' ? args[0] ?? plain(RUNTIME_OPERAND) : x)) : [...cmd, ...args] } : null;
    }
    case 'iex':
    case 'invoke-expression':

      return rest.length && !rest.some((x) => x.subs.length || x.text.includes('$')) ? { payload: joinQuoted(w, i + 1, "'"), shell: 'pwsh' } : null;
    case 'start-process':
    case 'saps': {
      const named = (n        ) => rest.findIndex((x) => x.text.length > 2 && n.startsWith(x.text.toLowerCase()));
      const fi = named('-filepath');
      const ai = named('-argumentlist');
      const positional = rest.filter((x, k) => !x.text.startsWith('-') && !(k > 0 && rest[k - 1].text.startsWith('-')));
      const file = fi >= 0 ? rest[fi + 1]?.text : positional[0]?.text;
      const args = ai >= 0 ? rest[ai + 1]?.text : positional[1]?.text;
      const runAs = rest.some((x, k) => /^-verb$/i.test(x.text) && /^runas$/i.test(rest[k + 1]?.text ?? ''));
      return file ? { payload: `${file} ${(args ?? '').split(',').join(' ')}`.trim(), shell: 'pwsh', elevated: runAs || undefined } : null;
    }
    default:
      return null;
  }
}

function exportsVar(w             , i        , p        , ctx     , state       )          {
  const psEnv = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(w[i].text);
  if (psEnv) {
    const value = psEnv[2] ?? (w[i + 1]?.text === '=' ? w[i + 2]?.text : undefined);
    if (value !== undefined) state.exported = capped(state.exported, [[psEnv[1], value]]);
    return true;
  }
  if (p === 'alias') {
    for (let k = i + 1; k < w.length && state.aliases.size < MAX_VARS; k++) {
      const eq = w[k].text.indexOf('=');
      if (eq > 0) state.aliases.set(w[k].text.slice(0, eq), w[k].text.slice(eq + 1));
    }
    return true;
  }
  if (p !== 'export' && !(p === 'set' && ctx.shell === 'cmd')) return false;
  const adds                     = [];
  for (let k = i + 1; k < w.length; k++) {
    const a = w[k].text;
    if (!ASSIGN.test(a)) continue;
    const eq = a.indexOf('=');
    adds.push([a.slice(0, eq), a.slice(eq + 1)]);
    if (state.vars.size < MAX_VARS) state.vars.set(a.slice(0, eq), a.slice(eq + 1));
  }
  if (adds.length) state.exported = capped(state.exported, adds);
  return true;
}

function unwrap(raw            , ctx     , state       )       {
  let w = raw.words;

  let env                                   = Object.keys(ctx.env).length ? capped(state.exported, Object.entries(ctx.env)) : state.exported;
  let own                            = null;
  let elevated = ctx.elevated;
  const line = ctx.line ?? raw.line;
  const emit = (from        ) => {
    if (own) env = capped(env, own);
    const words = w.slice(from);
    state.out.push({ toks: words.map((x) => x.text), words, env, elevated, redirects: raw.redirects, pipe: raw.pipe, stage: raw.stage, line, shell: ctx.shell, depth: ctx.depth });
  };
  const payload = (text               , shell        )          => {
    if (text === null) return false;
    if (own) env = capped(env, own), (own = null);
    expand(text, { env, elevated, shell, depth: ctx.depth + 1, line, pipeAt: { pipe: raw.pipe, stage: raw.stage } }, state);
    return true;
  };

  const stdinText = ()                => raw.redirects.find((r) => r.body !== undefined)?.body ?? raw.redirects.find((r) => r.op === '<<<')?.target ?? ctx.stdin ?? null;

  let i = 0;
  let substituted = false;
  for (let guard = 0; guard < 24 && i < w.length; guard++) {
    const t = w[i].text;
    if (ASSIGN.test(t)) {
      const eq = t.indexOf('=');
      if (!own) own = [];
      if (own.length < MAX_VARS) own.push([t.slice(0, eq), t.slice(eq + 1)]);

      if (w.every((x) => ASSIGN.test(x.text)) && state.vars.size < MAX_VARS) state.vars.set(t.slice(0, eq), t.slice(eq + 1));
      i++;
      continue;
    }

    const v = VAR_WORD.exec(t);
    if (v && !substituted && (state.vars.has(v[1]) || env[v[1]] !== undefined)) {
      substituted = true;
      w = [...w.slice(0, i), ...wordsOf(state.vars.get(v[1]) ?? env[v[1]]), ...w.slice(i + 1)];
      continue;
    }

    if (/\$\{?IFS\}?/.test(t) && !substituted) {
      substituted = true;
      const parts = t.split(/\$\{?IFS\}?/).filter(Boolean).map(plain);
      w = [...w.slice(0, i), ...parts, ...w.slice(i + 1)];
      continue;
    }
    const alias = state.aliases.get(t);
    if (alias !== undefined && !substituted) {
      substituted = true;
      w = [...w.slice(0, i), ...wordsOf(alias), ...w.slice(i + 1)];
      continue;
    }
    const p = programOf(t);
    if (exportsVar(w, i, p, ctx, state)) return;

    if (p === 'command' && (w[i + 1]?.text === '-v' || w[i + 1]?.text === '-V')) return;
    if (p === 'env') {
      const next = envWords(w, i);
      w = next.words;
      i = next.at;
      continue;
    }
    const after = skipPrefix(w, i, p);
    if (after >= 0) {
      if (p === 'sudo' || p === 'doas') elevated = true;
      i = after;
      continue;
    }
    if (p === 'eval') return void (i + 1 < w.length && payload(joinFrom(w, i + 1), 'eval'));
    const peeled = peelWrapper(w, i, p);
    if (peeled && 'words' in peeled) {
      w = peeled.words;
      i = 0;
      continue;
    }
    if (peeled) {
      if (peeled.elevated) elevated = true;
      return void payload(peeled.payload, peeled.shell);
    }
    if (SHELLS.has(p)) {
      const code = shellPayload(w, i);
      if (code === 'stdin') payload(stdinText(), p);
      else if (payload(code, p)) return;
      return emit(i);
    }
    if (p === 'cmd') return void (payload(cmdPayload(w, i), 'cmd') || emit(i));
    if (p === 'pwsh' || p === 'powershell' || p === 'powershell_ise') {
      const encoded = w.slice(i + 1).some((x) => /^-(?:e|ec|enc\w*)$/i.test(x.text));

      if (payload(pwshPayload(w, i, p), 'pwsh') && !encoded) return;
      return emit(i);
    }

    for (const cmd of codeCommands(w, i, p)) payload(cmd, 'sh');
    return emit(i);
  }
}

export function parseShell(command                           )                 {
  const text = String(command ?? '');
  if (!text.trim()) return [];
  const state        = { pipes: 0, out: [], exported: {}, vars: new Map(), aliases: new Map() };
  expand(text.slice(0, MAX_TEXT), { env: {}, elevated: false, shell: 'sh', depth: 0, line: null }, state);
  return state.out;
}

export function flagValue(toks          , names                   , opts                         = {})                {
  const norm = (s        ) => (opts.caseless ? s.toLowerCase() : s);
  const want = new Set(names.map(norm));
  for (let i = 1; i < toks.length; i++) {
    const t = norm(toks[i]);
    if (want.has(t)) return toks[i + 1] ?? null;
    const eq = t.indexOf('=');
    if (eq > 0 && want.has(t.slice(0, eq))) return toks[i].slice(eq + 1);
  }
  return null;
}

export const hasFlag = (toks          , names                   , opts                         = {})          => {
  const want = new Set(opts.caseless ? names.map((n) => n.toLowerCase()) : names);
  return toks.some((t, i) => i > 0 && want.has(opts.caseless ? t.toLowerCase() : t));
};


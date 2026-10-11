const BOOLEAN_FLAGS = new Set([
  'strict', 'json', 'sarif', 'fix', 'staged', 'changed', 'all', 'history', 'force',
  'apply', 'dry-run', 'global', 'local', 'trailer', 'evolve', 'report', 'init',
  'no-suppress', 'no-baseline', 'no-policy', 'no-index', 'adaptive', 'offline',
  'fail-on-regression', 'fail-on-blocked', 'write', 'yes', 'stdin', 'quiet', 'help',
  'check', 'checklist', 'pre-receive', 'uninstall', 'save', 'list', 'machine',
  'all-users', 'no-owner', 'static', 'no-save', 'print-credential', 'managed', 'guard',
]);

const VALUE_FLAGS = new Set([
  'key', 'url', 'path', 'kind', 'name', 'project', 'agent', 'agent-id', 'min',
  'scenarios', 'objectives', 'turns', 'target', 'run', 'port', 'config', 'env',
  'command', 'base', 'repo', 'pr', 'token', 'sha', 'session', 'since', 'depth',
  'scope', 'writer', 'type', 'slug', 'framework', 'chunk-size', 'manifest',

  'fail-on',

  'subject', 'title', 'note', 'actor',

  'input',

  'screen',

  'every', 'os',

  'owner', 'purpose', 'workload', 'audience', 'for',
]);

export const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

const TRUE_WORDS = new Set(['', 'true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);
const OPTIONAL_VALUE_FLAGS = new Set(['sarif', 'all']);

const REPEATABLE_FLAGS = new Set(['input']);

function setFlag(flags, name, value) {
  if (!REPEATABLE_FLAGS.has(name)) {
    flags[name] = value;
    return;
  }
  const prev = flags[name];
  flags[name] = prev === undefined ? value : [].concat(prev, value);
}

export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  const unknown = [];
  const invalid = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (!KNOWN_FLAGS.has(name)) {
        unknown.push(name);
        setFlag(flags, name, value);
      } else if (BOOLEAN_FLAGS.has(name)) {
        const word = value.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) flags[name] = true;
        else if (FALSE_WORDS.has(word)) flags[name] = false;
        else if (OPTIONAL_VALUE_FLAGS.has(name)) flags[name] = value;
        else {
          flags[name] = true;
          invalid.push(`--${name} is on or off - use --${name} or --${name}=false, not "${value}"`);
        }
      } else if (value === '') {
        flags[name] = true;
        invalid.push(`--${name} needs a value`);
      } else setFlag(flags, name, value);
      continue;
    }
    if (!KNOWN_FLAGS.has(body)) {
      unknown.push(body);
      flags[body] = true;
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      setFlag(flags, body, next);
      i++;
    } else {
      flags[body] = true;
      invalid.push(`--${body} needs a value`);
    }
  }
  return { flags, positional, unknown, invalid };
}

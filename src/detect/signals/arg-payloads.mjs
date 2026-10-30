const MAX_LEAVES = 200;
const MAX_DEPTH = 6;
const MAX_LEAF_CHARS = 4_000;
const SQL_LEAF_CHARS = 400;

const CODE_KEY_RE =
  /^(?:command|commands|cmd|cmds|script|scripts|code|shell|exec|bash|sh|powershell|query|queries|sql|statement|statements|stmt|expression|expr|filter|where|program|source|snippet|patch|diff|template|regex|pattern|body|text|content|contents|message|messages|markdown|html|description|notes?|comment|comments|prompt|instructions?|input|stdin|payload|data|title|subject|summary|heading|label|old_?str(?:ing)?|new_?str(?:ing)?|file_?text|replacement|edits?|lines?|cells?|args?|argv|arguments|env)$/i;

const SHELL_VERB = String.raw`(?:rm|curl|wget|nc|ncat|netcat|bash|sh|zsh|cat|ls|id|whoami|uname|echo|base64|python3?|perl|ruby|php|node|chmod|chown|touch|mkfifo|env|printenv|nslookup|dig|ping|sleep|kill|pkill|crontab|scp|ssh|tar|dd|mv|cp)`;
const SHELL_ARG = String.raw`(?:-{1,2}[a-z]|/|~/?|\.{1,2}/|\$|https?:)`;
const SHELL_RE = new RegExp(
  String.raw`\$\(\s{0,3}${SHELL_VERB}\b[^)]{0,240}\)|\x60\s{0,3}${SHELL_VERB}\b[^\x60]{0,240}\x60|(?<!\\)(?:;|&&|\|\||\|)\s{0,3}${SHELL_VERB}\b\s+${SHELL_ARG}`,
  'i',
);
const LOOKUP_RE = /\$\{\s{0,3}(?:jndi|env|sys|java|lower|upper|::-)[^}]{0,200}\}/i;
const SEP = String.raw`(?:[\/\\]|%2f|%5c|%252f|%255c)`;
const TRAVERSAL_RE = new RegExp(
  String.raw`(?:(?:\.\.|%2e%2e|%252e%252e)${SEP}){2,}(?:[\w.-]{1,40}${SEP}){0,4}?(?:etc${SEP}(?:passwd|shadow|hosts|sudoers|ssh)|proc${SEP}self|root${SEP}|var${SEP}run${SEP}secrets|\.ssh|\.aws|\.env\b|\.git${SEP}config|windows${SEP}(?:system32|win\.ini)|id_rsa|web\.config|wp-config\.php)`,
  'i',
);
const SQL_RE =
  /'\s*(?:or|and)\s+'?[\w-]{1,20}'?\s*(?:=|like)\s*'?[\w-]{0,20}|\b(?:or|and)\s+\d{1,6}\s*=\s*\d{1,6}\b|\bunion\s+(?:all\s+)?select\b|;\s*(?:drop|delete|update|insert|truncate|alter|exec(?:ute)?|create|grant)\b|'\s*;\s*--|'\s*--\s*$|\b(?:sleep|pg_sleep|benchmark)\s*\(\s*\d|\bwaitfor\s+delay\b|\bor\s+'[^']{0,20}'\s*=\s*'[^']{0,20}'/i;

const KIND_LABEL = { shell: 'carries a shell command', sql: 'carries a SQL injection', lookup: 'carries a ${...} lookup expression', traversal: 'climbs out of its directory to a sensitive file' };

function leaves(value, key, depth, out) {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH || value == null) return;
  if (typeof value === 'string') {
    out.push({ key, value: value.slice(0, MAX_LEAF_CHARS) });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) leaves(v, key, depth + 1, out);
    return;
  }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, k, depth + 1, out);
}

export function argPayloadHits(input) {
  const all = [];
  leaves(input, '', 0, all);
  const out = [];
  for (const { key, value } of all) {
    if (!key || CODE_KEY_RE.test(key)) continue;
    if (LOOKUP_RE.test(value)) out.push({ kind: 'lookup', key });
    else if (SHELL_RE.test(value)) out.push({ kind: 'shell', key });
    else if (TRAVERSAL_RE.test(value)) out.push({ kind: 'traversal', key });
    else if (value.length <= SQL_LEAF_CHARS && SQL_RE.test(value)) out.push({ kind: 'sql', key });
    if (out.length >= 3) break;
  }
  return out;
}

export function argPayloadFindings(tool, input) {
  if (!String(tool ?? '').startsWith('mcp__')) return [];
  return argPayloadHits(input).map((h) => ({
    label: `Argument "${h.key}" of ${tool} ${KIND_LABEL[h.kind]}`,
    severity: h.kind === 'sql' || h.kind === 'traversal' ? 'HIGH' : 'CRITICAL',
    category: 'shell',
  }));
}

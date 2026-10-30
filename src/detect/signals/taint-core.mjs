const SENSITIVE_FILE_RE =
  /(^|[\/\\\s"'=:(])(\.env(\.[\w.-]+)?|\.envrc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|[\w.-]*\.(pem|p12|pfx|key)|credentials(\.\w+)?|\.aws[\/\\]|\.ssh[\/\\]|\.npmrc|\.pypirc|\.git-credentials|\.netrc|secrets?\.(json|ya?ml|toml|txt|env)|service[-_]account[\w.-]*\.json|kubeconfig|\.codex[\/\\]auth\.json|\.credentials\.json|oauth_creds\.json|\.openclaw[\/\\][\w.\/\\-]*|github-copilot[\/\\](?:hosts|apps)\.json|huggingface[\/\\](?:token|stored_tokens)|gh[\/\\]hosts\.ya?ml)($|[\/\\"'\s])/i;

const READ_CMD_RE = /(?:\b(?:cat|less|more|head|tail|type|Get-Content|gc|xxd|od|strings|base64|source)\b|(?:^|\s)\.(?=\s))/i;

export function isSensitivePath(path                )          {
  return !!path && SENSITIVE_FILE_RE.test(String(path));
}

export function sourcesFromCall(action               , at        )               {
  const text = action.command ?? action.args ?? '';
  const labels               = [];
  if (action.isShell && READ_CMD_RE.test(text) && SENSITIVE_FILE_RE.test(text)) {
    labels.push({ kind: 'sensitive-file', provenance: `shell read of ${firstSensitivePath(text) ?? 'a sensitive file'}`, at });
  }
  return labels;
}

export function firstSensitivePath(text        )                     {
  const m = text.match(SENSITIVE_FILE_RE);
  return m ? m[0].replace(/["'\s]{1,64}$/, '') : undefined;
}

const LOOPBACK_RE = /^(localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i;
const PRIVATE_LAN_RE = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/;
const METADATA_HOST = '169.254.169.254';

export const DEFAULT_TRUSTED_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'bedrock-runtime.amazonaws.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
];

export function isTrustedHost(host                    , allow           = DEFAULT_TRUSTED_HOSTS)          {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (h === METADATA_HOST) return false;
  if (LOOPBACK_RE.test(h) || h.endsWith('.local')) return true;
  if (PRIVATE_LAN_RE.test(h)) return true;
  return allow.some((a) => h === a || h.endsWith('.' + a));
}

const NET_TOOL_RE = /(fetch|http|request|webhook|upload|post|send|email|slack|discord|curl|wget|browser|web_?search|scrape|crawl|url)/i;
const SEND_WORDS = new Set(['send', 'post', 'forward', 'fwd', 'reply', 'publish', 'share', 'invite', 'notify', 'upload', 'webhook']);
const MESSAGING_TOOL_RE = /email|slack|discord|pull_?requests?|merge_?requests?/i;
const OPEN_NET_TOOL_RE = /http|webhook|upload|curl|wget|browser|web_?search|scrape|crawl|url/i;
const READ_WORDS = new Set(['get', 'read', 'search', 'list', 'find', 'query', 'view', 'show', 'describe', 'count', 'history', 'fetch', 'download', 'retrieve', 'load', 'lookup']);
const WRITE_WORDS = new Set(['create', 'update', 'add', 'comment', 'merge', 'push', 'submit', 'edit', 'write', 'delete', 'remove', 'set', 'draft']);
const RECIPIENT_KEY_RE = /^(?:to|cc|bcc|recipients?|to_?address(?:es)?|email_?to)$/i;
const ADDRESS_DOMAIN_RE = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

function toolWords(tool        )           {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter((w, i) => !(w === 'merge' && /^requests?$/.test(words[i + 1] ?? '')));
}

export function netByToolName(tool        )          {
  const words = toolWords(tool);
  if (words.some((w) => SEND_WORDS.has(w))) return true;
  const readsOwnSystem =
    MESSAGING_TOOL_RE.test(tool) && !OPEN_NET_TOOL_RE.test(tool) && words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w));
  return !readsOwnSystem && NET_TOOL_RE.test(tool);
}

const INGRESS_TOOL_RE = /^(?:web_?fetch|web_?search|fetch|browse|browser|navigate|scrape|crawl|read_?url|open_?url|get_?url|search_?web)$|(?:^|_)(?:browser|playwright|puppeteer|firecrawl|fetch|scrape|crawl|navigate)(?:_|$)/i;

export function readsUntrustedContent(tool        )          {
  const raw = String(tool ?? '');
  const leaf = raw.startsWith('mcp__') ? raw.split('__').slice(2).join('__') || raw : raw;
  const words = toolWords(leaf);
  if (words.some((w) => SEND_WORDS.has(w) || WRITE_WORDS.has(w))) return false;
  return INGRESS_TOOL_RE.test(leaf) || INGRESS_TOOL_RE.test(words.join('_'));
}

const MACHINE_SEND_WORDS = new Set(['upload', 'webhook']);

export function sendsToPerson(tool        )          {
  const raw = String(tool ?? '');
  const leaf = raw.startsWith('mcp__') ? raw.split('__').slice(2).join('__') || raw : raw;
  const words = toolWords(leaf);
  if (words.some((w) => SEND_WORDS.has(w) && !MACHINE_SEND_WORDS.has(w))) return true;
  return MESSAGING_TOOL_RE.test(leaf) && words.some((w) => WRITE_WORDS.has(w)) && !words.some((w) => READ_WORDS.has(w));
}

const PERSON_KEY_RE = /^(?:to|cc|bcc|recipients?|recipientids?|toaddress(?:es)?|emailto|to(?:number|phone|user|userid)|phone(?:number)?|chatid|channel(?:id)?|conversation(?:id)?|userid|room(?:id)?)$/;
const MESSAGE_KEY_RE = /^(?:body|message|text|content|html|subject|msg|markdown|caption|blocks)$/;
const STORE_WORDS = new Set(['save', 'store', 'note', 'notes', 'memo', 'log', 'record', 'cache', 'bookmark', 'todo']);

function argObject(input         )                                 {
  let v = input;
  if (typeof v === 'string') {
    if (!v.trimStart().startsWith('{')) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v                           ) : null;
}

function addressesPerson(o                         )          {
  const keys = Object.keys(o).slice(0, 60).map((k) => k.toLowerCase().replace(/[_-]/g, ''));
  const person = keys.some((k, i) => PERSON_KEY_RE.test(k) && hasValue(Object.values(o)[i]));
  return person && keys.some((k, i) => MESSAGE_KEY_RE.test(k) && hasValue(Object.values(o)[i]));
}

function hasValue(v         )          {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'number' || (!!v && typeof v === 'object');
}

export function sendsToPersonByShape(tool        , input         )          {
  const raw = String(tool ?? '');
  const words = toolWords(raw.startsWith('mcp__') ? raw.split('__').slice(2).join('__') || raw : raw);
  if (words.some((w) => READ_WORDS.has(w)) && !words.some((w) => SEND_WORDS.has(w) || WRITE_WORDS.has(w))) return false;
  if (words.some((w) => STORE_WORDS.has(w)) && !words.some((w) => SEND_WORDS.has(w))) return false;
  const o = argObject(input);
  if (!o) return false;
  if (addressesPerson(o)) return true;
  return Object.values(o).slice(0, 20).some((v) => !!v && typeof v === 'object' && !Array.isArray(v) && addressesPerson(v                           ));
}

function recipientDomains(args         )           {
  if (!args || !args.trimStart().startsWith('{')) return [];
  let parsed         ;
  try {
    parsed = JSON.parse(args);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out = new Set        ();
  for (const [k, v] of Object.entries(parsed                           )) {
    if (!RECIPIENT_KEY_RE.test(k)) continue;
    for (const item of (Array.isArray(v) ? v : [v]).slice(0, 50)) {
      if (typeof item !== 'string') continue;
      for (const m of item.slice(0, 2_000).matchAll(ADDRESS_DOMAIN_RE)) out.add(m[1].toLowerCase());
    }
  }
  return [...out];
}

const NET_SHELL_RE = /\b(curl|wget|nc|ncat|netcat|scp|rsync|ftp|sftp|telnet|Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i;

export function extractHosts(text        )           {
  const hosts = new Set        ();
  for (const raw of text.match(/https?:\/\/[^\s"'<>\\)]+/gi) ?? []) {
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  return [...hosts];
}

export function detectEgressWith(action               , scanners                , allow           = DEFAULT_TRUSTED_HOSTS)                    {
  const text = [action.url, action.command, action.args].filter(Boolean).join(' ');
  if (!text.trim()) return null;

  const suspicious = scanners.suspiciousHosts(text);
  const hosts = extractHosts(text);
  const shellEgress = action.isShell && scanners.shellSignalNames(text).some((n) => /posts data|network|env dump|netcat|socket|command output piped|raw ip/i.test(n));
  const netByTool = netByToolName(action.tool);
  const netByShell = action.isShell && NET_SHELL_RE.test(text);

  const isEgress = suspicious.length > 0 || shellEgress || netByTool || netByShell || (!!action.url && hosts.length > 0);
  if (!isEgress) return null;

  if (suspicious.length) {
    return { target: suspicious[0], trusted: false, reason: `known exfiltration sink ${suspicious[0]}` };
  }
  const external = hosts.filter((h) => !isTrustedHost(h, allow));
  if (external.length) return { target: external[0], trusted: false, reason: `egress to ${external[0]}` };
  if (hosts.length) return { target: hosts[0], trusted: true, reason: `egress to trusted ${hosts[0]}` };

  const rcpt = netByTool ? recipientDomains(action.args) : [];
  const outside = rcpt.filter((d) => !isTrustedHost(d, allow));
  if (outside.length) return { target: outside[0], trusted: false, reason: `message to ${outside[0]}` };
  if (rcpt.length) return { target: rcpt[0], trusted: true, reason: `message to trusted ${rcpt[0]}` };

  return { target: undefined, trusted: false, reason: 'outbound network call to an unresolved destination' };
}

export function mergeLabels(existing              , incoming              , cap = 24)               {
  const seen = new Set(existing.map((l) => `${l.kind}|${l.provenance}`));
  const out = [...existing];
  for (const l of incoming) {
    const key = `${l.kind}|${l.provenance}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(l);
    }
  }
  return out.slice(-cap);
}

export function labelPhrase(kinds             )         {
  const map                            = {
    secret: 'a live secret',
    pii: 'personal data',
    'sensitive-file': 'sensitive file contents',
    confidential: 'confidential data',
    injection: 'an injected instruction',
  };
  return kinds.map((k) => map[k]).join(' + ') || 'sensitive data';
}

export function decideFlow(params

 )               {
  const taint = [...params.priorLabels, ...params.callSources];
  if (!params.egress || params.egress.trusted || taint.length === 0) {
    return { verdict: 'ALLOW', block: false, reason: '', matchedKinds: [] };
  }
  const kinds = [...new Set(taint.map((t) => t.kind))];
  const provenances = [...new Set(taint.map((t) => t.provenance).filter(Boolean))];
  const target = params.egress.target ?? 'an unresolved external endpoint';
  const from = provenances.length ? ` (${provenances.slice(0, 2).join('; ')})` : '';
  if (kinds.every((k) => k === 'injection')) {
    const reason =
      `Data-flow ${flowState(false, true)}: this session handled ${labelPhrase(kinds)}${from} and is now attempting egress to ${target}. ` +
      'Text that reads like an instruction does not refuse anything on its own; what the session sends out after it is asked about.';
    return { verdict: 'FLAG', block: false, reason, matchedKinds: kinds, target: params.egress.target };
  }
  const reason =
    `Data-flow ${flowState(params.enforce, params.flagOnly)}: this session ingested ${labelPhrase(kinds)}` +
    from +
    ` and is now attempting egress to ${target}. Tainted data cannot leave through an untrusted sink.`;
  return { verdict: params.enforce ? 'BLOCK' : 'FLAG', block: params.enforce, reason, matchedKinds: kinds, target: params.egress.target };
}

export function flowState(enforce         , flagOnly          )         {
  return enforce ? 'blocked' : flagOnly ? 'violation (flagged)' : 'violation (monitor)';
}


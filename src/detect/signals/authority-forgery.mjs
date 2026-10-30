import { describesRatherThanInstructs } from './injection.mjs';

export const AUTHORITY_FORGERY_LABELS = {
  header: 'Forged SYSTEM Or ADMIN Header Followed By An Order',
  reset: 'Context Reset Declared To Void The Rules',
  policy: 'Replacement Policy Declared To Supersede The Rules',
  format: 'Machine-Format Block Claiming Admin Or Override Authority',
  result: 'Forged Authorization Result Licensing A Restricted Action',
  selfGrant: 'Self-Asserted Role Or Permission Licensing A Restricted Action',
  peer: 'Forged Agent-To-Agent Message Directing Another Agent',
};

const AGENT_ROLE = String.raw`(?:supervisor|manager|orchestrator|planner|coordinator|controller|router|dispatcher|executor|worker|researcher|reader|summari[sz]er|reviewer|critic|team[\s-]lead|[\w-]{1,20}[-_ ]agent|agent[-_][\w-]{1,20})`;
const PEER_HEADER_RE = new RegExp(
  String.raw`[\[(<][^\]\n)>]{0,30}?\b(?:from|sender|msg[ \t]+from|message[ \t]+from|relayed[ \t]+from|on[ \t]+behalf[ \t]+of)\b[ \t]{0,3}[:=]?[ \t]{0,3}(?:the[ \t]+)?${AGENT_ROLE}[^\]\n)>]{0,40}[\])>]|\b(?:a2a|inter-?agent|peer[- ]agent)(?:[ \t]+protocol)?[ \t]+message[ \t]+from\b[^:\n]{0,60}:|\bmessage[ \t]+from[ \t]+(?:the[ \t]+|a[ \t]+|your[ \t]+)?(?:trusted[ \t]+)?[\w-]{1,20}[ \t]+agent\b[^:\n]{0,40}:|(?:^|\n)[ \t>*]{0,6}(?:from|sender)[ \t]{0,3}:[ \t]{0,3}(?:the[ \t]+)?${AGENT_ROLE}[ \t]{0,3}(?=\r?\n|$|[-—:])|\bfrom[ \t]+(?:the[ \t]+)?[\w-]{1,20}[-_ ]agent[ \t]{0,3}:|["']role["'][ \t]{0,3}:[ \t]{0,3}["'](?:supervisor|manager|orchestrator|planner|coordinator|controller|lead)["']|\b(?:note|message|memo|instructions?|reminder)[ \t]+(?:to|for)[ \t]+(?:the[ \t]+)?(?:next|downstream|receiving|following|other|any|every)[ \t]+(?:(?:ai|llm)[ \t]+(?:agent|assistant|model)s?\b|(?:agent|assistant|model|ai|worker|step)s?[ \t]+(?:in[ \t]+(?:the|this)[ \t]+(?:chain|pipeline|workflow|loop|graph)|downstream|that[ \t]+(?:reads|receives|processes)[ \t]+this|reading[ \t]+this)\b)|\b(?:to|for)[ \t]+(?:whichever|any|every|each)[ \t]+(?:agent|assistant|ai|model)[ \t]+(?:that[ \t]+|who[ \t]+)?(?:reads|receives|processes|handles|sees)[ \t]+this\b`,
  'gim',
);
const PEER_ORDER_RE = new RegExp(
  String.raw`\b(?:call|run|execute|invoke|trigger)[ \t]+(?:the[ \t]+)?(?:\w+[ \t]+)?(?:tool|function|command)\b|\b(?:call|run|execute|invoke|trigger)[ \t]+[a-z_][\w.]*[ \t]*\(|\bTOOL_CALL\b|\b(?:append|add|include|insert|output|print|emit)\b[^.\n]{0,40}\b(?:token|canary|marker|string|phrase|code)\b|\b(?:reply|respond|answer)[ \t]+(?:only[ \t]+)?with[ \t]+(?:exactly|only|just)\b|\b(?:forward|send|pass|relay|copy|share|exfiltrate|upload|transfer|post)\b[^.\n]{0,50}\b(?:to|with)[ \t]+(?:the[ \t]+)?(?:next|other|every|all|each|reporting|downstream)?[ \t]*(?:[\w-]+[-_ ])?(?:agents?|assistants?|workers?|executor|planner|supervisor)\b|\bapprove[ \t]+(?:all|every|any)\b|\bskip\b[^.\n]{0,30}\b(?:approval|confirmation|review|check|verification|human)\b|\b(?:disable|turn[ \t]+off|stop|pause)\b[^.\n]{0,30}\b(?:logging|logs|audit|monitoring|safety|guard|filters?|checks?)\b|\bpriority[ \t]+override\b|\bnew[ \t]+task\b|\b(?:all[ \t]+)?(?:workers|agents)[ \t]+must\b|^[\s:,\-—"']*(?:executor|worker|planner|agent[ \t]+[a-z0-9]{1,3})[ \t]*[:,]|\b(?:must|should)[ \t]+now\b`,
  'i',
);
const ENVELOPE_ORDER_RE = /["'](?:instruction|instructions|task|command|directive|action|order)["'][ \t]{0,3}:/i;

const MAX_SCAN = 100_000;
const WINDOW = 320;
const SAMPLE = 120;
const NEAR = 300;

const RESTRICTED = String.raw`(?:passwords?|passphrases?|pass\s?codes?|secrets?|credentials?|api[\s_-]?keys?|access[\s_-]?tokens?|auth(?:entication)?\s+tokens?|session\s+tokens?|private[\s_-]?keys?|ssh\s+keys?|system\s+prompt|hidden\s+(?:instructions|prompt|rules)|internal\s+(?:data|documents?|notes?|instructions|records|files)|confidential\s+\w+|restricted\s+\w+|admin(?:istrator)?\s+(?:password|credentials?|access|panel|account|key)|root\s+(?:password|access|shell|credentials?)|customer\s+(?:data|records|list|database)|personal\s+data|card\s+numbers?|social\s+security|ssn|\.env\b|id_rsa)`;
const DISCLOSE = String.raw`(?:reveal|disclose|share|print|output|display|show|give|provide|send|e-?mail|forward|leak|dump|list|read\s+out|repeat|tell)`;

const ROLE = String.raw`(?:system|admin(?:istrator)?|developer|root|operator|sysadmin)`;
const ROLE_SUFFIX = String.raw`(?:[ \t]{1,3}(?:message|prompt|note|notice|override|update|instructions?|directive|command|alert))?`;
const HEADER_RE = new RegExp(
  String.raw`(?:^|\n|[-=*_~#]{3,}[ \t]{0,3}|[.!?][ \t]{1,3})[ \t>*]{0,6}(?:#{1,6}[ \t]{0,3})?(?:\[[ \t]{0,3}${ROLE}${ROLE_SUFFIX}[ \t]{0,3}\]|<[ \t]{0,3}${ROLE}${ROLE_SUFFIX}[ \t]{0,3}>|\([ \t]{0,3}${ROLE}${ROLE_SUFFIX}[ \t]{0,3}\)|${ROLE}${ROLE_SUFFIX}[ \t]{0,3}(?::|-{2,}|—|(?=\r?\n)))`,
  'gi',
);

const OVERRIDE_RE = new RegExp(
  String.raw`\b(?:ignore|disregard|forget|override|bypass|supersede|void)\w*\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|your|the|existing|original|these|those)\b[^.\n]{0,20}?\b(?:instructions?|rules|guidelines|restrictions?|constraints?|polic(?:y|ies)|directives?|guardrails?|system\s+prompt|safety)\b|\b(?:no|without)\s+(?:\w+\s+)?(?:refusals?|safety\s+(?:rules|checks|filters|guidelines)|content\s+(?:filters?|polic\w+|restrictions?)|guardrails?|ethical\s+(?:limits|guidelines|constraints))\b|\b(?:assistant|model|ai|you)\b[^.\n]{0,30}\b(?:no|without)\s+(?:\w+\s+)?(?:restrictions?|limits?|limitations|filters?|rules)\b|\byou\s+are\s+now\b|\bnew\s+(?:system\s+)?(?:instructions?|directives?|polic(?:y|ies)|rules)\b|\b(?:unrestricted|uncensored|unfiltered|jailbr\w+|developer\s+mode|god\s+mode)\b`,
  'i',
);
const GRANT_RE = new RegExp(
  String.raw`\b(?:the\s+)?(?:assistant|model|ai|bot|agent|you)\s+(?:(?:may|can|must|should|will|shall)\s+(?:now\s+|also\s+)?|(?:is|are)\s+(?:now\s+)?(?:allowed|permitted|authori[sz]ed|cleared|required|instructed)\s+to\s+)${DISCLOSE}\b[^.\n]{0,60}?\b${RESTRICTED}`,
  'i',
);
const ACTION_RE = new RegExp(
  String.raw`^[\s:\-—)\]>*]*(?:please\s+|now\s+|immediately\s+)?(?:reveal|disclose|print|output|dump|send|forward|e-?mail|upload|post|transfer|wire|delete|drop|wipe|grant|disable|exfiltrate)\b[^.\n]{0,60}?(?:\b${RESTRICTED}|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.-]+|\$\s?\d)`,
  'i',
);

const RESET_RE =
  /\b(?:new\s+(?:session|conversation|chat|context)\s+(?:started|begins?|initiated|initiali[sz]ed|active)|(?:begin|start)(?:ing)?\s+(?:a\s+)?new\s+(?:session|conversation|context)|this\s+is\s+(?:now\s+)?a\s+(?:new|fresh|clean)\s+(?:session|conversation|context|chat)|(?:system|context|session|memory|full|hard|factory)\s+reset|(?:context|memory|conversation|session|history)\s+(?:has\s+been\s+|was\s+|is\s+)?(?:reset|cleared|wiped|flushed|erased|purged|restarted)|reset\s+(?:the\s+|your\s+|all\s+)?(?:context|session|memory|conversation))|[-=*#]{2,}\s*new\s+(?:session|conversation|context|chat)\s*[-=*#]{2,}/gi;
const CONSTRAINTS = String.raw`(?:rules|instructions|constraints|restrictions|guidelines|directives|polic(?:y|ies)|guardrails|limits|limitations|programming|system\s+prompt|safety\s+(?:rules|settings|guidelines|filters|policies))`;
const VOID_RE = new RegExp(
  String.raw`\b(?:all\s+)?(?:prior|previous|old|earlier|original|above|existing|former|initial|your|any|those)\s+(?:[\w-]+\s+){0,2}?${CONSTRAINTS}\s*(?:(?:are|is|have\s+been|has\s+been|were|was)\s+)?(?:now\s+|hereby\s+)?(?:void(?:ed)?|null(?:ified)?|revoked|rescinded|lifted|cleared|reset|wiped|deleted|removed|suspended|disabled|cancell?ed|obsolete|invalid(?:ated)?|gone|erased|no\s+longer\s+(?:apply|applies|valid|exists?|in\s+effect|active|binding|relevant|matter))\b`,
  'i',
);
const SETTING_LEAD_RE =
  /\b(?:when|whenever|if|after|once|each|every|until|unless|starting|starts?|opening|opens?|begin(?:s|ning)?|click(?:s|ing)?|press(?:es|ing)?|select(?:s|ing)?|choos(?:e|es|ing)|you\s+can|users?\s+can|lets?\s+you|allows?\s+you)\b[^.!?\n]{0,200}$/i;

const POLICY_NAME = String.raw`(?:polic(?:y|ies)|rules?|ruleset|guidelines|instructions|system\s+prompt|directives?|operating\s+(?:rules|instructions))`;
const SUPERSEDE = String.raw`(?:supersed(?:es|ing|ed)|replac(?:es|ing|ed)|overrid(?:es|ing|den)|takes?\s+precedence\s+over|voids?|revokes?|cancels?|obsoletes?)`;
const POLICY_RE = new RegExp(
  String.raw`\b${POLICY_NAME}\s{0,3}[([]?\s{0,3}(?:v(?:ersion)?\s{0,2}\.?\s{0,2}\d{1,3}(?:\.\d{1,3}){0,2}|\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)\b[^\n]{0,60}?\b${SUPERSEDE}\b|\b(?:new|updated|revised|latest|current)\s+${POLICY_NAME}\b[^\n]{0,60}?\b${SUPERSEDE}\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|old|earlier|existing|original|above)\b`,
  'gi',
);
const PERMISSIVE_RE =
  /\b(?:no\s+refusals?|never\s+refuse|without\s+refus\w*|do\s+not\s+refuse|must\s+not\s+refuse|no\s+(?:restrictions?|limits?|filters?|safety|guardrails?|content\s+(?:rules|restrictions|filters))|answers?\s+(?:every|all|any)\s+(?:requests?|questions?|prompts?)|(?:all|any)\s+(?:topics?|requests?|content)\s+(?:are\s+|is\s+)?(?:now\s+)?(?:allowed|permitted|approved)|unrestricted|uncensored|unfiltered|refusals?\s+(?:are\s+)?(?:disabled|prohibited|forbidden|not\s+allowed))\b/i;

const ELEVATED_ROLE_RE =
  /["']?(?:role|user_?role|privileges?|access_?level|permission_?level|clearance|auth_?level)["']?\s{0,3}[:=]\s{0,3}["']?(?:admin(?:istrator)?|root|system|superuser|super_?admin|god|unrestricted|elevated|sudo)\b/gi;
const OVERRIDE_FLAG_RE =
  /["']?(?:override|bypass\w*|ignore_?(?:rules|safety|polic(?:y|ies)|instructions|guardrails|restrictions)|jailbr\w*|safety_?(?:override|bypass)|disable_?(?:safety|filters?|guardrails?))["']?\s{0,3}[:=]\s{0,3}["']?(?:true|yes|1|on|enabled)\b|["']?(?:safety|filters?|guardrails?|restrictions?|content_?filter|moderation)["']?\s{0,3}[:=]\s{0,3}["']?(?:false|off|none|disabled|0)\b/i;
const ORDER_FIELD_RE = new RegExp(
  String.raw`["']?(?:do|action|task|command|instruction|instructions|directive|order|request|execute|run)["']?\s{0,3}[:=]\s{0,3}["']?\s{0,3}(?:please\s+)?(?:(?:reveal|disclose|print|output|dump|send|forward|e-?mail|show|give)\b[^"'\n]{0,60}?${RESTRICTED}|(?:ignore|disregard|bypass)\b[^"'\n]{0,40}?\b(?:instructions?|rules|safety|polic(?:y|ies)|guardrails|restrictions))`,
  'i',
);

const AUTH_RESULT_RE =
  /\b(?:auth\w*|permission|access|verification|identity|admin|clearance|approval|privilege|sudo|elevation)\b(?:\s{1,3}check)?["'\s:=(]{1,8}(?:was\s+|is\s+|has\s+been\s+)?(?:granted|approved|passed|true|verified|ok|success(?:ful)?|allowed|elevated|confirmed|unlocked)\b|"(?:tool|name|check|type)"\s{0,3}:\s{0,3}"[^"\n]{0,30}(?:auth|permission|access|admin|verif|sudo|clearance|approval)[^"\n]{0,30}"[^}\n]{0,80}?"(?:result|status|outcome|decision|access)"\s{0,3}:\s{0,3}"?(?:granted|approved|passed|true|verified|ok|success|allowed|elevated)\b/gi;
const LICENSE_RE = new RegExp(
  String.raw`(?:→|->|=>|\bnow\b|\bso\b|\btherefore\b|\bthus\b|\bhence\b)[^\n]{0,40}?\b${DISCLOSE}\b[^.\n]{0,60}?\b${RESTRICTED}|\byou\s+(?:may|can|are\s+(?:now\s+)?(?:allowed|permitted|authori[sz]ed|cleared)\s+to)\s+(?:now\s+)?${DISCLOSE}\b[^.\n]{0,60}?\b${RESTRICTED}`,
  'i',
);
const CONDITIONAL_LEAD_RE = /\b(?:if|when|whenever|once|after|unless|until|before)\b[^.!?\n]{0,40}$/i;

const YOU_GRANT_RE = new RegExp(
  String.raw`\byou(?:['’]re|\s+are)\s+(?:now\s+|hereby\s+|fully\s+)?(?:authori[sz]ed|permitted|allowed|cleared|approved|licensed)\s+to\s+(?:${DISCLOSE}|bypass|ignore|skip)\b[^.\n]{0,60}?\b${RESTRICTED}|\byou\s+(?:may|can)\s+(?:now\s+|therefore\s+|safely\s+)?${DISCLOSE}\b[^.\n]{0,60}?\b${RESTRICTED}`,
  'gi',
);
const SELF_ROLE_RE =
  /\b(?:i\s+am|i['’]m|as)\s+(?:an?\s+|the\s+|your\s+)?(?:(?:verified|authori[sz]ed|certified|official|approved|senior|lead|internal)\s+){0,2}(?:admin(?:istrator)?|sysadmin|developer|security\s+researcher|pen(?:etration)?\s*tester|red\s+teamer|auditor|owner|operator|moderator|ceo|cto|ciso|(?:openai|anthropic|google|microsoft)\s+(?:employee|staff|engineer|researcher))\b/i;
const CONDITIONAL_GRANT_RE =
  /\bif\s+(?:the\s+)?(?:user|requester|person|i|caller|they)\s+(?:is|am|are|claims?\s+to\s+be)\s+(?:an?\s+|the\s+)?(?:(?:verified|authori[sz]ed|certified)\s+)?(?:admin(?:istrator)?|developer|security\s+researcher|pen(?:etration)?\s*tester|red\s+teamer|auditor|owner|operator|moderator|employee|staff|insider)\b[^.\n]{0,40}?\byou\s+(?:may|can|are\s+(?:allowed|permitted|authori[sz]ed)\s+to)\b/i;
const TO_ME_RE = /^[^.\n]{0,40}?\b(?:to|with|for)\s+me\b/i;
const QUOTE_OPEN_RE =
  /(?:\b(?:ask|asks|asking|tell|telling|say|says|saying|type|typing|write|writing|prompts?|phrases?|like|such\s+as|e\.g\.|example|called|named|reads?)\b[^"“'‘\n]{0,40})["“'‘]$/i;

function quotedMention(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const stop = text.indexOf('\n', at);
  const line = text.slice(start, stop < 0 ? text.length : stop);
  const offset = at - start;
  if (!QUOTE_OPEN_RE.test(line.slice(Math.max(0, offset - 60), offset))) return false;
  return line.slice(offset, offset + 120).search(/["”'’]/) > 0;
}

function described(text, at) {
  return describesRatherThanInstructs(text, at) || quotedMention(text, at);
}

function signal(label, text, start, end) {
  return { label, severity: 'HIGH', sample: text.slice(start, Math.min(end, start + SAMPLE)).replace(/\s+/g, ' ').trim(), start, end };
}

function sentenceStart(text, at) {
  return Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('! ', at), text.lastIndexOf('? ', at), text.lastIndexOf('\n', at)) + 1;
}

function forgedHeader(text) {
  HEADER_RE.lastIndex = 0;
  for (const m of text.matchAll(HEADER_RE)) {
    const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const end = (m.index ?? 0) + m[0].length;
    const window = text.slice(end, end + WINDOW);
    if (!(OVERRIDE_RE.test(window) || GRANT_RE.test(window) || ACTION_RE.test(window)) || described(text, at)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.header, text, at, end + 80);
  }
  return null;
}

function contextReset(text) {
  RESET_RE.lastIndex = 0;
  for (const m of text.matchAll(RESET_RE)) {
    const at = m.index ?? 0;
    if (SETTING_LEAD_RE.test(text.slice(sentenceStart(text, at), at))) continue;
    const around = text.slice(Math.max(0, at - NEAR), at + m[0].length + NEAR);
    if (!VOID_RE.test(around) || described(text, at)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.reset, text, at, at + m[0].length + 80);
  }
  return null;
}

function policySwap(text) {
  POLICY_RE.lastIndex = 0;
  for (const m of text.matchAll(POLICY_RE)) {
    const at = m.index ?? 0;
    if (!PERMISSIVE_RE.test(text.slice(at, at + m[0].length + 240)) || described(text, at)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.policy, text, at, at + m[0].length + 80);
  }
  return null;
}

function formatAuthority(text) {
  if (!/[:=]/.test(text)) return null;
  ELEVATED_ROLE_RE.lastIndex = 0;
  for (const m of text.matchAll(ELEVATED_ROLE_RE)) {
    const at = m.index ?? 0;
    const block = text.slice(Math.max(0, at - NEAR), at + m[0].length + NEAR);
    if (!OVERRIDE_FLAG_RE.test(block) && !ORDER_FIELD_RE.test(block)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.format, text, at, at + 120);
  }
  return null;
}

function forgedResult(text) {
  AUTH_RESULT_RE.lastIndex = 0;
  for (const m of text.matchAll(AUTH_RESULT_RE)) {
    const at = m.index ?? 0;
    if (CONDITIONAL_LEAD_RE.test(text.slice(sentenceStart(text, at), at))) continue;
    if (!LICENSE_RE.test(text.slice(at + m[0].length, at + m[0].length + 200)) || described(text, at)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.result, text, at, at + m[0].length + 100);
  }
  return null;
}

function selfGrant(text) {
  YOU_GRANT_RE.lastIndex = 0;
  for (const m of text.matchAll(YOU_GRANT_RE)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const claimed = SELF_ROLE_RE.test(text.slice(Math.max(0, at - 200), end + 200)) || CONDITIONAL_GRANT_RE.test(text) || TO_ME_RE.test(text.slice(end, end + 60));
    if (!claimed || described(text, at)) continue;
    return signal(AUTHORITY_FORGERY_LABELS.selfGrant, text, at, end);
  }
  return null;
}

function forgedPeerMessage(text) {
  PEER_HEADER_RE.lastIndex = 0;
  for (const m of text.matchAll(PEER_HEADER_RE)) {
    const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const end = (m.index ?? 0) + m[0].length;
    const envelope = /^["']role/i.test(m[0].trim());
    const window = envelope ? text.slice(Math.max(0, at - NEAR), end + NEAR) : text.slice(end, end + WINDOW);
    if (envelope && !ENVELOPE_ORDER_RE.test(window)) continue;
    if (!PEER_ORDER_RE.test(window) && !OVERRIDE_RE.test(window)) continue;
    if (described(text, at)) continue;
    return { ...signal(AUTHORITY_FORGERY_LABELS.peer, text, at, end + 80), severity: 'MEDIUM' };
  }
  return null;
}

export function authorityForgerySignals(input) {
  const text = String(input ?? '').slice(0, MAX_SCAN);
  if (text.length < 12) return [];
  return [forgedHeader(text), contextReset(text), policySwap(text), formatAuthority(text), forgedResult(text), selfGrant(text), forgedPeerMessage(text)].filter(Boolean);
}

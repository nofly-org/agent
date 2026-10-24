/**
 * How much a tool call COSTS if it is wrong - the ladder the backend grades on,
 * mirrored here so the client can decide it OFFLINE.
 *
 * ⚠ THIS IS THE FAIL-CLOSED KEY. The hook fails open by design: an agent that
 * hard-stops on an unreachable SaaS backend is one nobody keeps installed. But
 * failing open on EVERY call means an attacker buys a bypass with a slow input
 * or a rate limit. Grading the consequence on-machine is what lets the hook
 * keep ordinary work flowing while still refusing a destructive call it could
 * not get screened.
 *
 * ⚠ It is a MIRROR of src/modules/runtime/intent/domain/consequence.ts and must
 * stay one - pinned by the backend's test/parity/consequence-mirror-bench.mjs.
 * Drift here is asymmetric in the same way every other mirror is: stricter than
 * the server blocks work no server verdict would have blocked, and looser puts
 * a hole in the floor at exactly the moment the floor is all there is.
 */
const SEVERE_VERB = /\b(delete|destroy|drop|purge|revoke|terminate|shutdown|wipe|erase|truncate|force[-_]?push)\b/i;

const RM_COMMAND = /(?<![-\w])rm\b/i;

const MATERIAL_VERB =
  /\b(transfer|pay|payment|refund|charge|invoice|wire|send|email|post|publish|deploy|release|merge|approve|grant|invite|share|upload|export)\b/i;

const AUTHORITY_GRANT =
  /\b(assume|impersonate|escalate|elevate|sudo|attach|grant|bind|add|put|set|create|assign)\s+(?:\w+\s+){0,2}(role|member|policy|binding|permission|principal|group|user|iam|owner|admin|access)\b/i;

const PRIVILEGED_TARGET =
  /\b(admin|administrator|owner|owners|root|superuser|orgadmin|administratoraccess|poweruser|cluster[-_]?admin|iam:\*)\b/i;

const PERSISTENCE_TARGET =
  /(^|\/)\.(ssh|aws|kube)\/|authorized_keys|\.bashrc|\.zshrc|\.profile|crontab|\/etc\/(sudoers|passwd|shadow)|systemd|(^|\/)\.env(\.|$)/i;

export function isPersistenceTarget(target) {
  return PERSISTENCE_TARGET.test(String(target ?? ''));
}

const PRODUCTION = /\b(prod|production|live|main|master|release)\b/i;

const SCHEDULE_NOUN = /\b(schedule[sd]?|scheduler|cron|crontab|cronjob|recurring|recurrence|periodic|routine|rrule)\b/i;

const SCHEDULE_WRITE = /\b(create|creates|update|updates|set|sets|add|adds|new|register|registers|enable|enables|arm|arms|install|installs|configure|configures|upsert|put|save|saves|define|defines)\b/i;

const SCHEDULE_READ = /\b(get|read|list|lists|fetch|view|show|shows|describe|lookup|search|query|inspect|status|count|history)\b/i;

const SCHEDULE_ARG_KEY =
  /["']?(?:cron(?:[_-]?expression|[_-]?tab)?|rrule|recurrence|schedule[_-]?expression|interval(?:[_-]?seconds|[_-]?ms|[_-]?minutes)?|every|frequency|next[_-]?run[_-]?at|nextRun|repeat|periodic)["']?\s*[:=]/i;

const CRON_LITERAL =
  /(?:^|["'\s(,=])(?:(?:\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:,\d{1,2})+)\s+){4}(?:\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|[0-7](?:,[0-7])+|\*\/\d{1,2})(?=["'\s),]|$)/;

const SCHEDULE_GRANT = /\b(tools?|toolset|credential|secret|api[_-]?key|token|agent[_-]?id|run[_-]?as|identity|sub[_-]?agent|impersonat)\w*/i;

export function schedulesFutureRun(tool, args) {
  const leaf = String(tool ?? '').replace(/^mcp__[^_]+__/, '');
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const argText = String(args ?? '');
  const readVerb = SCHEDULE_READ.test(spaced);
  const writeVerb = SCHEDULE_WRITE.test(spaced);
  if (readVerb && !writeVerb) return null;
  const byName = SCHEDULE_NOUN.test(spaced) && (writeVerb || !readVerb);
  const byArgs = SCHEDULE_ARG_KEY.test(argText) || CRON_LITERAL.test(argText);
  if (!byName && !byArgs) return null;
  return SCHEDULE_GRANT.test(`${spaced} ${argText}`) ? 'severe' : 'material';
}

/* ⚠ `force[-_]?push` never matched the way anybody writes it, so `git push
 * --force origin main` graded MATERIAL and the fail-closed rung never covered
 * it. --force-with-lease is included on purpose: it refuses when the remote
 * moved, which makes it safer, not less destructive. */
const FORCE_FLAG = /\s--?f(?:orce(?:-with-lease)?)?\b/i;
const FORCE_FLAG_AT = /^--?f(?:orce(?:-with-lease)?)?\b/i;

function forcePush(text) {
  const push = /\bgit\s+push\b/gi;
  const separator = /[|;&\n]/g;
  for (let m = push.exec(text); m; m = push.exec(text)) {
    const from = m.index + m[0].length;
    separator.lastIndex = from;
    const sep = separator.exec(text);
    const end = sep ? sep.index : text.length;
    if (FORCE_FLAG.test(text.slice(from, end))) return true;
    if (sep?.[0] === '\n' && FORCE_FLAG_AT.test(text.slice(end + 1, end + 41))) return true;
    push.lastIndex = Math.max(end, push.lastIndex);
  }
  return false;
}

const MANDATE_RANK = { intent: 1, cart: 2, payment: 3 };

const MANDATE_WRITE_WORDS = new Set(['create', 'sign', 'submit', 'issue', 'authorize', 'authorise', 'approve', 'update', 'send', 'present', 'generate', 'make', 'build', 'confirm', 'finalize', 'finalise', 'execute', 'process']);

const MANDATE_READ_WORDS = new Set(['get', 'read', 'list', 'fetch', 'verify', 'validate', 'check', 'view', 'show', 'describe', 'lookup', 'search', 'query', 'inspect', 'status']);

const MANDATE_KIND_WORDS = { intent: 'intent', cart: 'cart', payment: 'payment' };

function mandateWords(tool) {
  const leaf = String(tool ?? '').replace(/^mcp__[^_]+__/, '');
  return leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function strongerMandate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return MANDATE_RANK[b] > MANDATE_RANK[a] ? b : a;
}

function mandateKindOf(tool, argsText) {
  const words = mandateWords(tool);
  if (words.some((w) => MANDATE_READ_WORDS.has(w)) && !words.some((w) => MANDATE_WRITE_WORDS.has(w))) return null;
  let fromName = null;
  if ((words.includes('mandate') || words.includes('mandates')) && words.some((w) => MANDATE_WRITE_WORDS.has(w))) {
    for (const w of words) fromName = strongerMandate(fromName, MANDATE_KIND_WORDS[w] ?? null);
  }
  const t = String(argsText ?? '');
  let fromArgs = null;
  if (t.includes('ap2.mandates.PaymentMandate') || t.includes('payment_mandate_contents')) fromArgs = 'payment';
  else if (t.includes('ap2.mandates.CartMandate') || (t.includes('payment_request') && t.includes('cart_expiry'))) fromArgs = 'cart';
  else if (t.includes('ap2.mandates.IntentMandate') || (t.includes('intent_expiry') && t.includes('natural_language_description'))) fromArgs = 'intent';
  return strongerMandate(fromName, fromArgs);
}

export function classifyConsequence(input) {
  const leaf = String(input.tool ?? '').replace(/^mcp__[^_]+__/, '');
  const raw = `${leaf} ${input.args ?? ''}`;
  const blob = raw.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');

  const mandate = mandateKindOf(input.tool, input.args);
  if (mandate === 'cart' || mandate === 'payment') return 'severe';

  if (typeof input.amount === 'number' && input.amount > 0) {
    return SEVERE_VERB.test(blob) || RM_COMMAND.test(raw) ? 'severe' : 'material';
  }
  if (PERSISTENCE_TARGET.test(raw)) return 'severe';
  if (SEVERE_VERB.test(blob) || RM_COMMAND.test(raw) || forcePush(raw)) return 'severe';
  if (AUTHORITY_GRANT.test(blob)) return PRIVILEGED_TARGET.test(blob) ? 'severe' : 'material';
  const sched = schedulesFutureRun(input.tool, input.args);
  if (sched === 'severe') return 'severe';
  if (mandate === 'intent') return 'material';
  if (sched === 'material') return 'material';
  if (input.isShell) return 'material';
  if (MATERIAL_VERB.test(blob)) return 'material';
  if (input.isEgress) return 'material';
  if (input.actionId && PRODUCTION.test(blob) && MATERIAL_VERB.test(input.actionId)) return 'severe';
  return 'routine';
}

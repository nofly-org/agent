import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentIdentityHandle } from '../commands/agent-identity.mjs';
import { isMemoryPath, reportMemoryWrite } from '../commands/memory-scan.mjs';
import { breakerOpen, breakerReset, breakerTrip, guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { CONFIG_DIR } from '../core/config.mjs';
import { makeLedgerStore } from './ledger.mjs';
import { MAX_POST_CONTENT, memoryWritesFor, postEditContents, recordLedger, sha256 } from './memory-write.mjs';
import { memoryReportBase, reportOutOfBand } from './memory-report.mjs';
import { readSubjectTypes, rememberSubjectTypes, serverScreened, subjectBearingPath, subjectEscalation } from './subject-preclassify.mjs';
import { artifactKindFor } from './artifact-paths.mjs';
import { gateMachine } from '../core/api-client.mjs';
import { VERSION } from '../core/version.mjs';
import { loadConfig, resolveSettings, storedAgentCredential } from '../core/config.mjs';
import { clearCachedCredential, workloadCredential } from '../core/workload-identity.mjs';
import { boundedLocalScan, classifyConsequence, downrankCodeContext, grade, isPersistenceTarget, localScan } from '../detect/guard-signals.mjs';
import { SEV_RANK } from '../detect/signals/severity.mjs';
import { SHELL_TOOLS_RE, WRITE_TOOLS, callSubjectTypes, guardNeedsServer, guardTargetPath, guardText, guardTouchedPaths } from './classify.mjs';
import { patchTextOf, shellCommandOf } from './command-text.mjs';
import { runTargets } from './run-targets.mjs';
import { redactLocally } from '../detect/local-redact.mjs';
import { confirmationNote, emitGuardAsk, emitGuardDeny, emitGuardNotice, stoppedNote } from './emit.mjs';
import { guardPathAllowlisted } from './ignore.mjs';
import { screenModelLoad } from './model-load.mjs';
import { screenSkillInvocation } from './skill-check.mjs';
import { activeArtifactsField } from './active-artifacts.mjs';
import { normalizeGuardInput } from './normalize.mjs';
import { readHookPayload as readPayload } from './payload.mjs';
import { envFlag, guardWait, resolveAgentFlag } from './options.mjs';
import { recordSelftest, selftestField } from './selftest-marker.mjs';
import { buildGuardBody, flushQueuedReports, reportGuardDecision } from './report.mjs';
import { guardHookTamper, guardStateTamper, hookTamperReason, refuseOrAsk, tamperReason } from './self-protect.mjs';
import { describeFetchError, keyedFetch } from '../core/keyed-fetch.mjs';
import { readRegularText } from '../core/safe-read.mjs';

const ALLOW_VERDICT = { verdict: 'ALLOW', top: null, findings: [] };


function failOpenOnSevere() {
  return envFlag('SHOMRA_GUARD_FAILOPEN_SEVERE');
}

function unscreenedSevere(normalized, tool, input) {
  if (failOpenOnSevere()) return false;
  if (WRITE_TOOLS.has(tool)) return writeIsSevere(tool, input);
  return classifyConsequence({
    tool,
    args: guardText(tool, input),
    isShell: typeof input?.command === 'string',
  }) === 'severe';
}

function writeIsSevere(tool, input) {
  if (guardTouchedPaths(tool, input).some(isPersistenceTarget)) return true;
  const patch = patchTextOf(tool, input);
  return !!patch && /^(?:\*\*\* Delete File:|\+\+\+ \/dev\/null|deleted file mode)/m.test(patch);
}


function ledger() {
  return makeLedgerStore(CONFIG_DIR, { version: VERSION });
}

function countUnscreened(reason) {
  try {
    ledger().count(localTierDisabled() ? 'unscreened' : 'local', reason);
  } catch {
  }
}

function sendLedger() {
  try {
    const store = ledger();
    store.close();
    const env = store.envelope();
    pendingLedger = env.gaps ?? [];
    return env;
  } catch {
    return undefined;
  }
}

let pendingLedger = [];

function ackLedger() {
  if (!pendingLedger.length) return;
  try {
    ledger().ack(pendingLedger);
  } catch {
  }
  pendingLedger = [];
}

const FAIL_OPEN_NOTICE_EVERY_MS = 30 * 60 * 1000;

function failOpenNoticeDue(now = Date.now()) {
  const file = path.join(CONFIG_DIR, 'guard-notice.json');
  let last = 0;
  try {
    last = Number(JSON.parse(readRegularText(file)).at) || 0;
  } catch {
  }
  if (now - last < FAIL_OPEN_NOTICE_EVERY_MS) return false;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at: now }), { mode: 0o600 });
  } catch {
    return false;
  }
  return true;
}

function askUnscreened(agent, why, flagged = null) {
  emitGuardAsk(
    agent,
    `Shomra could not screen this call (${why}), and it is a high-consequence one - a delete, a force push, `
    + 'or a call that touches credentials or a file that survives the session. Nothing has judged it: approve it only if you meant it. '
    + (flagged ? `The on-machine rules also matched: ${flagged}. ` : '')
    + 'Set SHOMRA_GUARD_FAILOPEN_SEVERE=1 to let these through unscreened.',
  );
}

function readHookPayload() {
  return readPayload() ?? process.exit(0);
}

function localTierDisabled() {
  return process.env.SHOMRA_GUARD_LOCAL === '0'
    || String(process.env.SHOMRA_GUARD_LOCAL).toLowerCase() === 'false';
}

function screenLocally(normalized, tool, input) {
  const scan = boundedLocalScan(guardText(tool, input));
  const isWrite = WRITE_TOOLS.has(tool);
  const allowlisted = isWrite && guardPathAllowlisted(normalized.cwd, guardTargetPath(normalized));

  let findings = scan.findings;
  if (allowlisted) findings = [];
  else if (isWrite) findings = downrankCodeContext(scan.findings);

  const top = findings.reduce((worst, f) => ((SEV_RANK[f.severity] ?? 0) > (SEV_RANK[worst?.severity] ?? 0) ? f : worst), null);
  return { ...grade(findings), top, findings };
}

function localFlagMode() {
  const mode = String(process.env.SHOMRA_GUARD_LOCAL_FLAG ?? '').trim().toLowerCase();
  if (mode === 'allow' || mode === 'deny' || mode === 'ask') return mode;
  return failOpenOnSevere() ? 'allow' : 'ask';
}

function settleTooLarge(agent, flagged) {
  const mode = localFlagMode();
  if (mode === 'allow') return;
  const matched = flagged ? ` The on-machine rules also matched: ${flagged}.` : '';
  if (mode === 'deny') emitGuardDeny(agent, `Blocked on-machine by Shomra: ${TOO_LARGE_TO_SCREEN}, and SHOMRA_GUARD_LOCAL_FLAG=deny refuses what nothing judged.${matched}`);
  emitGuardAsk(
    agent,
    `Shomra could not screen this call: ${TOO_LARGE_TO_SCREEN}, so nothing has judged it - approve it only if you meant it.${matched} `
    + 'Set SHOMRA_GUARD_LOCAL_FLAG=allow to let such calls through.',
  );
}

const RUN_TARGET_NOUN = { 'npm-script': 'the npm script', make: 'the make target', script: 'the script' };

export function flaggedLabel(local, run) {
  if (localTierDisabled()) return null;
  if (local?.verdict === 'FLAG' && local.top?.label) return local.top.label;
  const hit = run?.risky?.[0];
  return hit ? `${hit.label} (in ${RUN_TARGET_NOUN[hit.kind] ?? 'the file'} ${hit.target})` : null;
}

function settleFlagged(agent, label, why) {
  if (!label) return;
  const mode = localFlagMode();
  if (mode === 'allow') return;
  if (mode === 'deny') emitGuardDeny(agent, `Blocked on-machine by Shomra: ${label}. ${why}, and SHOMRA_GUARD_LOCAL_FLAG=deny refuses what the local tier flags.`);
  emitGuardAsk(
    agent,
    `Shomra flagged this call on-machine: ${label}. ${why}, so nothing else has judged it - approve it only if you meant it. `
    + 'Set SHOMRA_GUARD_LOCAL_FLAG=allow to let flagged calls through.',
  );
}

const READ_TOOLS_RE = /^(read|read_file|view|open_file|cat)$/i;

async function recordMemoryWrite({ url, apiKey, tool, input, normalized }) {
  if (breakerOpen()) return;

  if (READ_TOOLS_RE.test(tool || '')) {
    const target = input.file_path || input.path || input.target_file;
    if (!target || !isMemoryPath(target)) return;
    const abs = path.resolve(normalized.cwd || process.cwd(), String(target));
    let current = null;
    try {
      current = readRegularText(abs);
    } catch {
      return;
    }
    await reportOutOfBand(url, apiKey, abs, current, normalized);
    return;
  }

  const writes = memoryWritesFor(tool, input, { cwd: normalized.cwd }).filter((w) => w.path && isMemoryPath(w.path));
  for (const w of writes) {
    await reportOutOfBand(url, apiKey, w.path, w.before, normalized);
    const outcome = await reportMemoryWrite(url, apiKey, {
      ...memoryReportBase(w.path, normalized),
      content: w.content,
      writer: 'AGENT',
      source: os.hostname(),
      contentBasis: w.basis,
    });
    const after = w.basis === 'whole' ? sha256(w.content) : null;
    const delivered = outcome !== 'failed';
    recordLedger(w.path, [w.before != null ? sha256(w.before) : null, delivered ? after : null], undefined, { pending: [typeof w.likely === 'string' ? sha256(w.likely) : null, delivered ? null : after].filter(Boolean) });
  }
}

async function rejectionReason(response) {
  try {
    const body = await response.json();
    const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    return typeof msg === 'string' && msg.trim() ? msg.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

export function unauthenticatedNote(status, { reason = null, agentCredential = false } = {}) {
  const who = agentCredential ? 'this agent’s credential' : 'this API key';
  const fix = agentCredential
    ? 'Check the agent in the dashboard (suspended, revoked or awaiting approval), or issue it a new credential.'
    : 'Re-enroll with `shomra init --key <key>`.';
  return `[shomra] guard NOT enforced: the backend rejected ${who} (HTTP ${status}${reason ? `: ${reason}` : ''}). `
    + 'Local Tier-0 screening still ran; org policy, agent identity and flow control did not. '
    + `${fix}\n`;
}

function reportUnauthenticated(agent, status, strict, detail = {}) {
  process.stderr.write(unauthenticatedNote(status, detail));
  if (strict) {
    emitGuardDeny(agent, `Shomra guard could not authenticate (HTTP ${status}); blocked by fail-closed policy.`);
  }
}

const MAX_BODY_BYTES = 5 * 1024 * 1024 - 64 * 1024;
const DROPPABLE_PARTS = ['post_content', 'active_artifacts'];
export const TOO_LARGE_TO_SCREEN = 'the call is too large for the server to screen';

export function fitGuardBody(body) {
  let raw = JSON.stringify(body);
  if (Buffer.byteLength(raw) <= MAX_BODY_BYTES) return raw;
  const trimmed = { ...body };
  for (const part of DROPPABLE_PARTS) {
    if (!(part in trimmed)) continue;
    delete trimmed[part];
    raw = JSON.stringify(trimmed);
    if (Buffer.byteLength(raw) <= MAX_BODY_BYTES) return raw;
  }
  return null;
}

function refuseTooLarge(agent, strict, onUnreachable) {
  if (strict) emitGuardDeny(agent, `Shomra guard could not screen this call: ${TOO_LARGE_TO_SCREEN}; blocked by fail-closed policy.`);
  return onUnreachable(TOO_LARGE_TO_SCREEN, { breaker: false, tooLarge: true });
}

async function requestServerDecision({ url, apiKey, agentId, body, agent, strict, retried, onUnreachable, onRejected }) {
  const raw = typeof body === 'string' ? body : fitGuardBody(body);
  if (raw === null) return refuseTooLarge(agent, strict, onUnreachable);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), guardTimeoutMs());
  try {
    const response = await keyedFetch(`${url}/gate/tool-call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shomra-Key': apiKey,
        ...(agentId ? { 'X-Shomra-Agent': agentId } : {}),
        Connection: 'close',
      },
      body: raw,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 413) {
        clearTimeout(timer);
        response.body?.cancel?.().catch(() => {});
        return refuseTooLarge(agent, strict, onUnreachable);
      }
      if (response.status === 401 || response.status === 403) {
        onRejected?.();
        const agentCredential = String(apiKey ?? '').startsWith('shm_agt_') || String(agentId ?? '').startsWith('shm_agt_');
        reportUnauthenticated(agent, response.status, strict, { reason: await rejectionReason(response), agentCredential });
        return onUnreachable(`the backend rejected the credential (HTTP ${response.status})`, { breaker: false });
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response);
        if (wait !== null && !retried) {
          clearTimeout(timer);
          await sleep(wait);
          return requestServerDecision({ url, apiKey, agentId, body: raw, agent, strict, retried: true, onUnreachable, onRejected });
        }
        clearTimeout(timer);
        return onUnreachable('rate limited', { breaker: false });
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const decision = await response.json();
    clearTimeout(timer);
    if (!isGuardDecision(decision)) throw new Error('the backend answered without a guard decision');
    breakerReset();
    ackLedger();
    await flushQueuedReports(url, apiKey);
    return decision;
  } catch (error) {
    clearTimeout(timer);
    breakerTrip();
    const why = describeFetchError(error, url);
    if (strict) emitGuardDeny(agent, `Shomra guard could not be reached (${why}); blocked by fail-closed policy.`);
    return onUnreachable(why, { breaker: true });
  }
}

const DECISIONS = new Set(['ALLOW', 'FLAG', 'BLOCK']);

export function isGuardDecision(decision) {
  return !!decision && typeof decision === 'object' && !Array.isArray(decision) && (DECISIONS.has(decision.decision) || decision.hold === true);
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 5) * 1000;
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.min(Math.max(when - Date.now(), 0), 5000) : null;
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

function enforceServerDecision(agent, decision) {
  if (decision?.hold) {
    emitGuardAsk(agent, decision.reason || 'Held for approval by Shomra - waiting on a reviewer. Retry once it’s approved.');
  }
  if (decision?.decision === 'BLOCK') {
    emitGuardDeny(agent, decision.reason || 'Blocked by Shomra security policy.', confirmationNote(decision.confirmation), stoppedNote(decision.stopped));
  }
}

/** ⚠ Bounded BEFORE the read: a 2 GB file named by an Edit must not be pulled into memory to be refused. */
function boundedRead(p) {
  return readRegularText(p, MAX_POST_CONTENT);
}

/**
 * The post-edit file of every governed path this call edits - see
 * `postEditContents`. ⚠ Built only for a call that is being escalated, never
 * on the local-only path, and never allowed to fail the call: a reconstruction
 * that throws sends nothing and the server grades the fragment as a fragment.
 */
export function postContentField(tool, input, normalized, read = boundedRead) {
  try {
    const post = postEditContents(tool, input, {
      cwd: normalized?.cwd,
      read,
      keep: (p) => subjectBearingPath(p) || !!artifactKindFor(String(p ?? '').replace(/\\/g, '/')),
    });
    return post.length ? { post_content: post } : {};
  } catch {
    return {};
  }
}

const RISKY_RUN_CATEGORIES = new Set(['shell', 'injection', 'egress']);

export function runTargetsOf(tool, input, normalized, read) {
  try {
    if (!SHELL_TOOLS_RE.test(tool || '')) return { targets: [], risky: [] };
    const targets = runTargets(shellCommandOf(input), normalized?.cwd, read).map((t) => ({ ...t, text: redactLocally(t.text).text }));
    const risky = targets.flatMap((t) =>
      localScan(t.text).findings
        .filter((f) => (f.severity === 'CRITICAL' || f.severity === 'HIGH') && RISKY_RUN_CATEGORIES.has(f.category))
        .map((f) => ({ target: t.name, kind: t.kind, label: f.label ?? f.name ?? f.title, severity: f.severity })),
    );
    return { targets, risky };
  } catch {
    return { targets: [], risky: [] };
  }
}

export async function cmdToolGuard(flags) {
  const agent = resolveAgentFlag(flags);
  const strict = envFlag('SHOMRA_GUARD_STRICT');
  const alwaysEscalate = envFlag('SHOMRA_GUARD_ALWAYS_ESCALATE');
  const cfg = loadConfig();
  const settings = resolveSettings(cfg);
  const { url } = settings;
  const presented = resolveAgentIdentityHandle(flags);
  const fromWorkload = presented
    ? null
    : await workloadCredential({ url, onError: (e) => process.stderr.write(`shomra: keyless sign-in failed - ${e?.message ?? e}\n`) });
  const agentId = presented ?? fromWorkload ?? storedAgentCredential(cfg, agent, url);
  const onRejected = fromWorkload ? () => clearCachedCredential() : undefined;
  const apiKey = settings.apiKey || (agentId?.startsWith('shm_agt_') ? agentId : undefined);

  const normalized = normalizeGuardInput(agent, readHookPayload());
  const tool = String(normalized.tool_name ?? '').trim();
  const input = normalized.tool_input ?? {};

  const local = localTierDisabled() ? ALLOW_VERDICT : screenLocally(normalized, tool, input);
  if (local.verdict === 'BLOCK') {
    recordSelftest({ stage: 'local-block', tool, reason: local.top?.label ?? 'dangerous tool call' });
    await reportGuardDecision(url, apiKey, agentId, buildGuardBody(normalized, agent, 'BLOCK', local.top?.label));
    emitGuardDeny(agent, `Blocked on-machine by Shomra: ${local.top?.label || 'dangerous tool call'}.`);
  }

  const tamper = guardStateTamper(tool, input, { cwd: normalized.cwd });
  if (tamper) {
    const reason = tamperReason(tamper);
    await reportGuardDecision(url, apiKey, agentId, buildGuardBody(normalized, agent, 'FLAG', 'Edits the Shomra guard’s own state'));
    if (refuseOrAsk(agent, strict) === 'deny') emitGuardDeny(agent, `Blocked on-machine by Shomra: ${reason}`);
    emitGuardAsk(agent, reason);
  }

  const hookTamper = guardHookTamper(tool, input, { cwd: normalized.cwd });
  if (hookTamper) {
    const reason = hookTamperReason(hookTamper);
    await reportGuardDecision(url, apiKey, agentId, buildGuardBody(normalized, agent, 'FLAG', 'Switches off the Shomra guard hook'));
    if (refuseOrAsk(agent, strict) === 'deny') emitGuardDeny(agent, `Blocked on-machine by Shomra: ${reason}`);
    emitGuardAsk(agent, reason);
  }

  await screenModelLoad(agent, tool, input, url);

  const run = runTargetsOf(tool, input, normalized);
  const severe = unscreenedSevere(normalized, tool, input) || run.risky.length > 0;
  const flaggedBy = flaggedLabel(local, run);

  if (!apiKey) {
    recordSelftest({ stage: 'not-configured', tool });
    if (strict) {
      emitGuardDeny(agent, 'Shomra is not configured on this machine (SHOMRA_GUARD_STRICT). Run: shomra init --key shm_…');
    }
    if (unscreenedSevere(normalized, tool, input)) askUnscreened(agent, 'Shomra is not configured on this machine', flaggedBy);
    settleFlagged(agent, flaggedBy, 'No Shomra server is configured on this machine to confirm it');
    process.exit(0);
  }

  await screenSkillInvocation({ agent, tool, input, normalized, url, apiKey: settings.apiKey, agentId, strict });

  /**
   * ⚠ The org's subject types come from the server's last answer, cached on
   * disk - reading them costs no round trip. Unknown (no answer yet, stale, an
   * older server) escalates every subject-bearing call: see `subject-preclassify`.
   */
  const subjectTypes = readSubjectTypes({ url });
  const candidates = callSubjectTypes(tool, input, { cwd: normalized.cwd });
  const subjectCall = subjectEscalation(candidates, subjectTypes);
  const supplyCall = serverScreened(candidates);
  const escalate = alwaysEscalate || severe || local.verdict === 'FLAG' || subjectCall || supplyCall || guardNeedsServer(tool, input, !!agentId, { subjectTypes, cwd: normalized.cwd });
  if (!escalate) {
    recordSelftest({ stage: 'not-escalated', tool, subjectTypes, reason: 'the local tier decided this call alone - the server never saw it' });
    countUnscreened('not escalated - screened by the local tier only');
    await recordMemoryWrite({ url, apiKey, tool, input, normalized });
    process.exit(0);
  }

  /**
   * ⚠ A SUBJECT CALL FOLLOWS THE MACHINE'S FAIL MODE, and says so. There is no
   * org-level fail mode: `SHOMRA_GUARD_STRICT` is the setting. Strict skips the
   * breaker and DENIES when the server cannot answer (`requestServerDecision`);
   * the default fails open - and the ledger records that an org subject rule
   * was NOT evaluated, distinct from an ordinary unscreened call, so a breaker
   * window of unchecked installs is visible on the server once it answers.
   */
  const onUnreachable = (why, { tooLarge = false } = {}) => {
    recordSelftest({ stage: 'unreachable', tool, reason: why });
    countUnscreened(subjectCall ? `${why} - org subject rules NOT evaluated` : supplyCall ? `${why} - package and image checks NOT run` : why);
    if (tooLarge) settleTooLarge(agent, flaggedBy);
    if (severe) askUnscreened(agent, why, flaggedBy);
    settleFlagged(agent, flaggedBy, `No Shomra verdict arrived (${why})`);
    if (failOpenNoticeDue()) emitGuardNotice(agent, `Shomra could not reach its server (${why}), so tool calls are screened on this machine only and org policy is not applied until it answers again. Set SHOMRA_GUARD_STRICT=1 to refuse calls instead.`);
    return process.exit(0);
  };

  if (!strict && breakerOpen()) onUnreachable('the guard is in its backoff window after an earlier failure');

  const flagged = local.verdict === 'FLAG';
  const post = postContentField(tool, input, normalized);
  /**
   * ⚠ A SELF-TEST CANARY CARRIES NO LEDGER. The envelope is ACKNOWLEDGED the
   * moment the server answers, and a canary is answered by the simulator, which
   * records nothing - so sending it would retire a real fail-open window that
   * nobody ever stored. The self-test proves the path; it must not consume the
   * evidence of an outage on the way.
   */
  const selftest = selftestField();
  const startedAt = Date.now();
  const decision = await requestServerDecision({
    url,
    apiKey,
    agentId,
    agent,
    strict,
    onUnreachable,
    onRejected,
    body: {
      ...buildGuardBody(normalized, agent, flagged ? 'FLAG' : undefined, flagged ? local.top?.label : undefined),
      ...post,
      ...activeArtifactsField(agent, normalized),
      ...(run.targets.length ? { run_targets: run.targets.map(({ kind, name, path: p, text, unread }) => ({ kind, name, path: p, text, unread })) } : {}),
      ...selftest,
      ...(selftest.selftest ? {} : { guard_ledger: sendLedger() }),
      ...guardWait(),
    },
  });

  recordSelftest({
    stage: 'answered',
    tool,
    latencyMs: Date.now() - startedAt,
    postContent: (post.post_content ?? []).map((p) => p.path),
    decision: decision?.decision ?? null,
    simulated: decision?.simulated === true,
    hold: !!decision?.hold,
    reason: typeof decision?.reason === 'string' ? decision.reason.slice(0, 400) : null,
    outcome: decision?.selftest ?? null,
  });

  if (decision && typeof decision === 'object') rememberSubjectTypes(decision.subjectTypes, { url });
  enforceServerDecision(agent, decision);
  await recordMemoryWrite({ url, apiKey, tool, input, normalized });
  process.exit(0);
}

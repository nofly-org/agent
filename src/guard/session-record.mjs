import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../core/config.mjs';
import { readRegularText } from '../core/safe-read.mjs';
import { egressHost } from '../detect/signals/egress.mjs';
import { DANGEROUS_SHELL, matchesShellSignal } from '../detect/signals/shell.mjs';
import {
  decideFlow,
  detectEgressWith,
  extractHosts,
  firstSensitivePath,
  isSensitivePath,
  isTrustedHost,
  mergeLabels,
  readsUntrustedContent,
  sourcesFromCall,
} from '../detect/signals/taint-core.mjs';
import { SHELL_TOOLS_RE } from './classify.mjs';
import { shellCommandOf } from './command-text.mjs';

export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UNTRUSTED = 12;
const READ_TOOL_RE = /^(?:read|read_file|view|open_file|cat|notebookread|read_many_files)$/i;
const FETCH_SHELL_RE = /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|http|xh|lynx|w3m)\b/i;

export function flowMode() {
  const v = String(process.env.NOFLY_FLOW_LOCAL ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : v === 'block' ? 'block' : 'ask';
}

export function sessionFile(agent, sessionId, dir = SESSIONS_DIR) {
  const id = crypto.createHash('sha256').update(`${agent ?? ''}:${sessionId}`).digest('hex').slice(0, 32);
  return path.join(dir, `${id}.json`);
}

function readRecord(file) {
  try {
    const rec = JSON.parse(readRegularText(file));
    if (rec && Array.isArray(rec.labels) && Array.isArray(rec.untrusted)) return rec;
  } catch {
  }
  return { labels: [], untrusted: [] };
}

function writeRecord(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
  }
}

export function pruneSessions(dir = SESSIONS_DIR, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_TTL_MS) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
    }
  }
  return removed;
}

const scanners = {
  suspiciousHosts: (text) => {
    const host = egressHost(text);
    return host ? [host] : [];
  },
  shellSignalNames: (text) => DANGEROUS_SHELL.filter((sig) => matchesShellSignal(sig, text)).map((sig) => sig.name),
};

export function actionOf(tool, input) {
  const isShell = SHELL_TOOLS_RE.test(String(tool ?? ''));
  const url = typeof input?.url === 'string' ? input.url : undefined;
  if (isShell) return { tool, isShell, command: shellCommandOf(input), url };
  let args;
  try {
    args = JSON.stringify(input ?? {}).slice(0, 20_000);
  } catch {
    args = '';
  }
  return { tool, isShell, args, url };
}

function fetchesUntrusted(action) {
  if (readsUntrustedContent(action.tool)) return true;
  if (!action.isShell || !FETCH_SHELL_RE.test(action.command ?? '')) return false;
  return extractHosts(action.command ?? '').some((h) => !isTrustedHost(h));
}

export function judgeCall({ agent, sessionId, tool, input, now = new Date(), dir = SESSIONS_DIR }) {
  if (!sessionId || flowMode() === 'off') return null;
  const file = sessionFile(agent, sessionId, dir);
  const rec = readRecord(file);
  const at = now.toISOString();
  const action = actionOf(tool, input);
  const callSources = sourcesFromCall(action, at);
  const target = input?.file_path ?? input?.path ?? input?.target_file ?? input?.absolute_path;
  if (READ_TOOL_RE.test(String(tool ?? '')) && isSensitivePath(target)) {
    callSources.push({ kind: 'sensitive-file', provenance: `read of ${path.basename(String(target))}`, at });
  }

  let verdict = null;
  const egress = detectEgressWith(action, scanners);
  if (egress && !egress.trusted && rec.untrusted.length && (rec.labels.length || callSources.length)) {
    const carries = !!firstSensitivePath(action.command ?? action.args ?? '');
    const enforce = flowMode() === 'block' || carries;
    const decision = decideFlow({ priorLabels: rec.labels, callSources, egress, enforce, flagOnly: !enforce });
    if (decision.verdict !== 'ALLOW') {
      verdict = {
        ...decision,
        label: `${decision.reason} Earlier in this session the agent read content nobody here wrote (${rec.untrusted[0].source}).`,
      };
    }
  }

  rec.labels = mergeLabels(rec.labels, callSources);
  if (fetchesUntrusted(action)) rec.untrusted = [...rec.untrusted, { source: String(tool), at }].slice(-MAX_UNTRUSTED);
  rec.updatedAt = at;
  writeRecord(file, rec);
  if (Math.random() < 0.02) pruneSessions(dir, now.getTime());
  return verdict;
}

export function noteResult({ agent, sessionId, tool, findings = [], now = new Date(), dir = SESSIONS_DIR }) {
  if (!sessionId || flowMode() === 'off') return;
  const live = findings.filter((f) => !f.codeContext);
  const secret = live.some((f) => f.category === 'secret');
  const injected = live.some((f) => f.category === 'injection');
  if (!secret && !injected) return;
  const file = sessionFile(agent, sessionId, dir);
  const rec = readRecord(file);
  const at = now.toISOString();
  if (secret) rec.labels = mergeLabels(rec.labels, [{ kind: 'secret', provenance: `${tool} result`, at }]);
  if (injected) {
    rec.labels = mergeLabels(rec.labels, [{ kind: 'injection', provenance: `${tool} result`, at }]);
    rec.untrusted = [...rec.untrusted, { source: `${tool} result carrying an instruction`, at }].slice(-MAX_UNTRUSTED);
  }
  rec.updatedAt = at;
  writeRecord(file, rec);
}

export function noteWrittenInjection({ agent, sessionId, tool, target, now = new Date(), dir = SESSIONS_DIR }) {
  if (!sessionId || flowMode() === 'off') return false;
  const file = sessionFile(agent, sessionId, dir);
  const rec = readRecord(file);
  const at = now.toISOString();
  const where = target ? path.basename(String(target)) : String(tool);
  rec.labels = mergeLabels(rec.labels, [{ kind: 'injection', provenance: `write of ${where}`, at }]);
  rec.untrusted = [...rec.untrusted, { source: `instruction-like text the agent wrote into ${where}`, at }].slice(-MAX_UNTRUSTED);
  rec.updatedAt = at;
  writeRecord(file, rec);
  return true;
}

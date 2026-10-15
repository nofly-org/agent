import { clampInt } from '../core/numbers.mjs';
import { describeFetchError } from '../core/keyed-fetch.mjs';

export function parseEnvKV(str) {
  const env = {};
  for (const pair of String(str || '').split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/)) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return env;
}

export function splitCommandLine(line) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  const text = String(line ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
      continue;
    }
    if (c === '\\' && i + 1 < text.length && /[\s"'\\]/.test(text[i + 1])) {
      current += text[++i];
      started = true;
      continue;
    }
    current += c;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

const MCP_RUNNERS = new Set(['npx', '-y', '--yes', 'uvx', 'uv', 'node', 'bun', 'deno', 'python', 'python3', '-m', 'pipx', 'run', 'npm', 'pnpm', 'yarn', 'dlx', 'bunx']);

export function mcpLookupId(server, name) {
  if (server.url) return String(server.url);
  const toks = [server.command, ...(server.args || [])].filter(Boolean).map(String);
  for (const t of toks) {
    if (MCP_RUNNERS.has(t) || t.startsWith('-')) continue;
    if (/^@?[\w][\w./-]*$/.test(t)) return t;
  }
  return name;
}

export async function mcpLookup(url, id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), clampInt(process.env.NOFLY_API_TIMEOUT_MS, 15000, 1000, 60000));
  try {
    const res = await fetch(`${url}/catalog/lookup?id=${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'nofly-agent' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw e?.cause || e?.name === 'AbortError' ? new Error(describeFetchError(e, url)) : e;
  } finally {
    clearTimeout(timer);
  }
}

export function mcpIndexAlert(index) {
  if (!index || !index.found || !index.scanned) return null;
  if (index.verdict === 'FAIL' || (index.criticalCount ?? 0) > 0) return 'BLOCK';
  if (index.verdict === 'REVIEW' || (index.highCount ?? 0) > 0) return 'FLAG';
  return 'OK';
}

export function worstMcpVerdict(local, idxAlert) {
  const rank = { ALLOW: 0, OK: 0, PASS: 0, FLAG: 1, REVIEW: 1, BLOCK: 2, FAIL: 2 };
  const label = ['ALLOW', 'FLAG', 'BLOCK'];
  return label[Math.max(rank[local] ?? 0, rank[idxAlert] ?? 0)];
}

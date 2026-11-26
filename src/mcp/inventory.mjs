import os from 'node:os';
import path from 'node:path';
import { advisoryIds, advisoryKey, packageAdvisories } from '../detect/signals/mcp-advisories.mjs';
import { gradeServer, knownVulnerable, launchPull, maskServerSecrets, normalizeServerEntry } from '../detect/signals/mcp-config.mjs';
import { collectMcpServerSources } from '../inventory/discovery/mcp-servers.mjs';
import { collectMcpCodeReferences } from './code-references.mjs';
import { mcpIndexAlert, mcpLookup } from './lookup.mjs';

const RAW = Symbol('raw');
const ALERT_RANK = { OK: 0, FLAG: 1, BLOCK: 2 };
const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1?\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+\.local|[\w-]+\.internal)$/i;
const MAX_INDEX_FINDINGS = 3;
const INTERPRETER_RE = /^(?:node|nodejs|bun|deno|python[\d.]*|py|ruby|java|go|dotnet|sh|bash)(?:\.exe)?$/i;

const worse = (a, b) => (ALERT_RANK[b] > ALERT_RANK[a] ? b : a);

function urlParts(raw) {
  try {
    const u = new URL(String(raw));
    return { href: `${u.protocol}//${u.host}${u.pathname}`, host: u.hostname, query: !!u.search };
  } catch {
    return null;
  }
}

function fallbackName(server, launch) {
  if (server.url) return urlParts(server.url)?.host ?? 'remote server';
  if (launch?.name) return launch.name.split('/').pop();
  const program = String(server.command ?? 'server').split(/[\\/]/).pop();
  const script = INTERPRETER_RE.test(program) ? (server.args ?? []).find((a) => !String(a).startsWith('-')) : null;
  return script ? String(script).split(/[\\/]/).pop() : program;
}

function identityOf(server) {
  if (server.url) return `url:${urlParts(server.url)?.href ?? server.url}`;
  return `cmd:${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`;
}

export function displayPath(file, root) {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const home = os.homedir();
  const fromHome = path.relative(home, abs);
  if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) return `~/${fromHome.split(path.sep).join('/')}`;
  return abs.split(path.sep).join('/');
}

export function collectMcpInventory(root, entries, { machine = true, home, file = null } = {}) {
  const byKey = new Map();
  const add = (raw, location) => {
    const launch = raw.url ? null : launchPull(raw.command, raw.args);
    const server = { ...raw, name: raw.name || fallbackName(raw, launch) };
    const key = identityOf(server);
    let rec = byKey.get(key);
    if (!rec) {
      const masked = maskServerSecrets(server);
      const parts = server.url ? urlParts(server.url) : null;
      rec = {
        name: server.name,
        names: [server.name],
        kind: server.url ? 'remote' : 'stdio',
        command: server.url ? null : [masked.command, ...(masked.args ?? [])].filter(Boolean).join(' '),
        url: server.url ? (parts ? `${parts.href}${parts.query ? '?…' : ''}` : String(masked.url ?? '')) : null,
        package: launch,
        disabled: !!server.disabled,
        locations: [],
      };
      rec[RAW] = server;
      byKey.set(key, rec);
    } else if (!rec.names.includes(server.name)) rec.names.push(server.name);
    if (!server.disabled) rec.disabled = false;
    rec.locations.push(location);
  };

  const sources = file
    ? collectMcpServerSources([], { mcp: [{ file }] }, { machine, home })
    : collectMcpServerSources([root], null, { machine, home });
  for (const source of sources) {
    for (const raw of source.servers) add(raw, { origin: 'config', scope: source.scope, vendor: source.vendor, file: displayPath(source.file, root) });
  }
  for (const ref of collectMcpCodeReferences(root, entries)) {
    const entry = ref.kind === 'remote' ? { url: ref.url } : { command: ref.command, args: ref.args };
    const normalized = normalizeServerEntry(ref.name ?? '', entry);
    add({ ...normalized, name: ref.name ?? '', authDeclared: true }, { origin: 'code', file: ref.file, line: ref.line, via: ref.via });
  }
  return [...byKey.values()];
}

function lastFix(seed) {
  return seed.ranges[seed.ranges.length - 1]?.fixed ?? null;
}

function severityAlert(severity) {
  if (severity === 'CRITICAL') return 'BLOCK';
  if (severity === 'HIGH' || severity === 'MEDIUM') return 'FLAG';
  return 'OK';
}

function vulnAlert(severity) {
  return severity === 'CRITICAL' || severity === 'HIGH' ? 'BLOCK' : 'FLAG';
}

function catalogIdOf(rec) {
  if (rec.package?.name) return rec.package.name;
  if (rec.kind !== 'remote') return null;
  const parts = urlParts(rec[RAW].url);
  if (!parts || LOCAL_HOST_RE.test(parts.host)) return null;
  return parts.href;
}

async function lookupAll(items, worker, concurrency) {
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
}

export async function assessMcpInventory(records, { url = null, offline = false, index = true, fetchImpl = globalThis.fetch, lookup = mcpLookup, concurrency = 6, timeoutMs } = {}) {
  for (const rec of records) {
    const raw = rec[RAW];
    const pkg = rec.package;
    const seed = pkg?.version ? knownVulnerable(pkg.ecosystem === 'pypi' ? 'python' : 'npm', pkg.name, pkg.version) : null;
    rec.knownVulns = seed ? [{ ids: [seed.cve], severity: seed.severity, fixed: [lastFix(seed)].filter(Boolean), source: 'nofly' }] : [];
    rec.findings = gradeServer({ ...raw })
      .filter((f) => !(seed && f.title.includes(seed.cve)))
      .map((f) => ({ severity: f.severity, title: f.title, fix: f.remediationText }));
    rec.checks = seed || pkg?.version ? ['nofly'] : [];
  }

  let advisories = 'skipped';
  if (!offline) {
    const pulls = records.filter((r) => r.package?.version && !r.knownVulns.length).map((r) => r.package);
    const res = await packageAdvisories(pulls, { fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
    advisories = res.status;
    for (const rec of records) {
      if (!rec.package?.version || rec.knownVulns.length) continue;
      if (res.status === 'checked') rec.checks.push('osv');
      const a = res.advisories.get(advisoryKey(rec.package));
      if (a) rec.knownVulns.push({ ids: advisoryIds(a), severity: a.severity, fixed: a.fixed, summary: a.summary, source: 'osv' });
    }
  }

  let indexState = 'skipped';
  if (url && index && !offline) {
    const wanted = records.map((rec) => ({ rec, id: catalogIdOf(rec) })).filter((x) => x.id);
    let failures = 0;
    await lookupAll(wanted, async ({ rec, id }) => {
      try {
        const found = await lookup(url, id);
        rec.index = found && typeof found === 'object'
          ? { found: !!found.found, scanned: !!found.scanned, slug: found.slug ?? null, verdict: found.verdict ?? null, riskScore: found.riskScore ?? null, criticalCount: found.criticalCount ?? 0, highCount: found.highCount ?? 0, findings: Array.isArray(found.findings) ? found.findings.slice(0, MAX_INDEX_FINDINGS) : [], alternatives: Array.isArray(found.alternatives) ? found.alternatives : [] }
          : { found: false };
        if (rec.index.found && rec.index.scanned) rec.checks.push('index');
      } catch (error) {
        failures++;
        rec.index = { error: error.message };
      }
    }, concurrency);
    indexState = !wanted.length ? 'none' : failures === wanted.length ? 'unreachable' : 'checked';
  } else if (!url) indexState = 'not-configured';

  for (const rec of records) {
    let alert = 'OK';
    for (const v of rec.knownVulns) alert = worse(alert, vulnAlert(v.severity));
    for (const f of rec.findings) alert = worse(alert, severityAlert(f.severity));
    const idx = rec.index ? mcpIndexAlert(rec.index) : null;
    if (idx) alert = worse(alert, idx);
    rec.alert = alert;
  }
  return { advisories, index: indexState };
}

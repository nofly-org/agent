import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { clampInt } from '../core/numbers.mjs';
import { SEV_COLOR, bold, cyan, dim, gray, green, red, yellow } from '../core/terminal.mjs';
import { advisoriesDisabled } from '../detect/signals/mcp-advisories.mjs';
import { unreadMcpStores } from '../inventory/discovery/mcp-servers.mjs';
import { assessMcpInventory, collectMcpInventory, displayPath } from '../mcp/inventory.mjs';
import { printAlternatives } from '../models/lookup.mjs';
import { resolveScanScope } from '../models/references.mjs';
import { walkFiles } from './secrets.mjs';

const DEFAULT_CONCURRENCY = 6;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const MAX_LOCATIONS_SHOWN = 3;
const MAX_FINDINGS_SHOWN = 3;
const MAX_LAUNCH_CHARS = 96;

const sevColour = (severity) => SEV_COLOR[severity] || dim;

function versionParts(v) {
  return String(v).replace(/^[v=~^]+/, '').split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
}

export function highestVersion(versions) {
  const list = (versions ?? []).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((best, v) => {
    const a = versionParts(v);
    const b = versionParts(best);
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? v : best;
    return best;
  });
}

function where(loc) {
  if (loc.origin === 'code') return `${loc.file}:${loc.line}`;
  return loc.vendor && loc.vendor !== 'project' ? `${loc.file} (${loc.vendor})` : loc.file;
}

function listed(items) {
  const unique = [...new Set(items.map(where))];
  const shown = unique.slice(0, MAX_LOCATIONS_SHOWN).join(', ');
  return unique.length > MAX_LOCATIONS_SHOWN ? `${shown} (+${unique.length - MAX_LOCATIONS_SHOWN})` : shown;
}

function locationLines(rec) {
  const config = rec.locations.filter((l) => l.origin === 'config');
  const code = rec.locations.filter((l) => l.origin === 'code');
  return [config.length ? `configured in ${listed(config)}` : null, code.length ? `in code ${listed(code)}` : null].filter(Boolean);
}

function launchLabel(rec) {
  const text = String((rec.kind === 'remote' ? rec.url : rec.command) ?? '');
  return text.length > MAX_LAUNCH_CHARS ? `${text.slice(0, MAX_LAUNCH_CHARS - 1)}…` : text;
}

function packageLabel(rec) {
  if (!rec.package) return '';
  return dim(` ${rec.package.name}${rec.package.version ? `@${rec.package.version}` : ''}`);
}

function statusLabel(rec, state) {
  if (rec.alert === 'BLOCK') return red(rec.knownVulns.length ? 'known vulnerable' : 'critical risk');
  if (rec.alert === 'FLAG') return yellow(rec.knownVulns.length ? 'known advisories - review' : 'review');
  if (rec.checks.includes('osv') || rec.checks.includes('index')) return green('no known vulns');
  if (rec.checks.includes('nofly')) return green('not on the known-vulnerable list') + dim(state.advisories === 'checked' ? '' : ' (OSV not checked)');
  if (rec.index?.error) return yellow('index lookup failed');
  if (rec.kind === 'remote') return dim('remote server - no package to check');
  if (rec.package && !rec.package.version) return dim('not pinned - the version is unknown, so no release was checked');
  return dim('local program - nothing to look up');
}

function alertMark(rec) {
  if (rec.alert === 'BLOCK') return red('●');
  if (rec.alert === 'FLAG') return yellow('●');
  return rec.checks.length ? green('●') : gray('○');
}

function printServer(rec, state) {
  const disabled = rec.disabled ? dim(' (disabled)') : '';
  console.log(`  ${alertMark(rec)} ${bold(rec.name)}${disabled}${packageLabel(rec)}  ${statusLabel(rec, state)}`);
  console.log(`      ${dim(launchLabel(rec))}`);
  for (const line of locationLines(rec)) console.log(`      ${dim(line)}`);
  for (const v of rec.knownVulns) {
    const target = highestVersion(v.fixed);
    const fix = target ? ` - upgrade to ${target} or later` : '';
    const source = v.source === 'osv' ? 'OSV' : 'NoFly known-vulnerable list';
    const summary = v.summary ? ` ${v.summary}` : '';
    console.log(`      ${sevColour(v.severity)(String(v.severity).padEnd(8))} ${v.ids.join(', ')}${summary}${dim(fix)} ${dim(`(${source})`)}`);
  }
  for (const f of rec.findings.filter((x) => x.severity !== 'LOW' && x.severity !== 'INFO').slice(0, MAX_FINDINGS_SHOWN)) {
    console.log(`      ${sevColour(f.severity)(String(f.severity).padEnd(8))} ${f.title} ${dim('(local)')}`);
  }
  if (rec.index?.found && rec.index.scanned) {
    const colour = rec.index.verdict === 'FAIL' ? red : rec.index.verdict === 'REVIEW' ? yellow : green;
    console.log(`      ${dim('MCP Security Index:')} ${colour(String(rec.index.verdict))} ${dim(`risk ${rec.index.riskScore ?? '?'}`)}`);
    for (const f of rec.index.findings) console.log(`      ${sevColour(f.severity)(String(f.severity).padEnd(8))} ${f.title} ${dim('(index)')}`);
    printAlternatives(rec.index.alternatives, 'mcp');
  }
}

function counts(records) {
  const scopes = { machine: 0, project: 0, code: 0 };
  for (const rec of records) {
    if (rec.locations.some((l) => l.origin === 'config' && l.scope === 'machine')) scopes.machine++;
    if (rec.locations.some((l) => l.origin === 'config' && l.scope === 'project')) scopes.project++;
    if (rec.locations.some((l) => l.origin === 'code')) scopes.code++;
  }
  return scopes;
}

function sourcesLabel(state) {
  const parts = ['the built-in known-vulnerable list'];
  if (state.advisories === 'checked') parts.push('OSV');
  if (state.index === 'checked') parts.push(`the MCP Security Index at ${state.url}`);
  return parts.join(', ');
}

function unreadLines(unread) {
  const out = unread.slice(0, 3).map((u) => `${yellow('⚠')} ${dim(`${u.file} was not read (${u.state}) - servers in it are not listed.`)}`);
  if (unread.length > 3) out.push(`${yellow('⚠')} ${dim(`${unread.length - 3} more config store(s) were not read.`)}`);
  return out;
}

function notices(state, unread, capped, filesRead) {
  const out = [];
  if (state.offline) out.push(dim('Offline - OSV and the MCP Security Index were not queried.'));
  else {
    if (state.advisories === 'unavailable') out.push(`${yellow('⚠')} ${dim('OSV could not be reached - pinned packages were checked against the built-in list only.')}`);
    if (state.index === 'unreachable') out.push(`${yellow('⚠')} ${dim(`The MCP Security Index at ${state.url} could not be reached.`)}`);
    if (state.index === 'not-configured') out.push(dim('MCP Security Index not configured - set NOFLY_URL (or nofly init --url) to add it.'));
  }
  out.push(...unreadLines(unread));
  if (capped) out.push(`${yellow('⚠')} ${dim(`The code walk stopped after ${filesRead} files - the rest of the tree was not read.`)}`);
  return out;
}

function summaryLine(active) {
  const blocked = active.filter((r) => r.alert === 'BLOCK').length;
  const flagged = active.filter((r) => r.alert === 'FLAG').length;
  if (blocked) return red(`✗ ${blocked} vulnerable`) + dim(` · ${flagged} to review`);
  if (flagged) return yellow(`⚠ ${flagged} to review`);
  return green('✓ No known-vulnerable MCP servers');
}

function jsonRecord(rec) {
  return {
    name: rec.name,
    names: rec.names,
    kind: rec.kind,
    command: rec.command,
    url: rec.url,
    package: rec.package,
    disabled: rec.disabled,
    locations: rec.locations,
    ...(rec.alert ? { alert: rec.alert, knownVulns: rec.knownVulns, findings: rec.findings, checks: rec.checks } : {}),
    ...(rec.index ? { index: rec.index } : {}),
  };
}

function printNothingFound(flags, root, machine, unread) {
  if (flags.json) {
    console.log(JSON.stringify({ detected: 0, servers: [], unread }, null, 2));
    return;
  }
  const scope = machine ? "this machine's agent configs, the project's configs or the code" : "the project's configs or the code";
  console.log(green(`\n  ✓ No MCP servers found in ${scope}.`) + dim(` (looked under ${displayPath(root, process.cwd())})`));
  for (const line of unreadLines(unread)) console.log(`  ${line}`);
  console.log('');
}

function printDryRun(flags, records, url) {
  const plan = (rec) => {
    const checks = [];
    if (rec.package?.version) checks.push(`built-in list + OSV (${rec.package.name}@${rec.package.version})`);
    else if (rec.package) checks.push('not pinned - nothing to look up by version');
    const id = rec.package?.name ?? (rec.kind === 'remote' ? rec.url : null);
    if (url && id) checks.push(`index (${id})`);
    return checks;
  };
  if (flags.json) {
    console.log(JSON.stringify({ detected: records.length, servers: records.map((rec) => ({ ...jsonRecord(rec), lookups: plan(rec) })) }, null, 2));
    return;
  }
  console.log(bold(cyan('\n  NoFly MCP servers')) + dim(` - ${records.length} found (dry run - no lookup)`));
  for (const rec of records) {
    const checks = plan(rec);
    console.log(`  ${gray('•')} ${bold(rec.name)}${packageLabel(rec)} ${dim(`- ${launchLabel(rec)}`)}`);
    for (const line of locationLines(rec)) console.log(`      ${dim(line)}`);
    console.log(`      ${dim(`→ ${checks.length ? checks.join(' · ') : 'local program - nothing to look up'}`)}`);
  }
  console.log('');
}

export async function cmdMcps(flags, positional) {
  const { url } = resolveSettings(loadConfig());
  const target = path.resolve(positional[0] || flags.path || '.');
  if (!fs.existsSync(target)) {
    console.error(`${red('✗')} Not found: ${positional[0] || flags.path}`);
    process.exit(EXIT_USAGE);
  }
  const machine = !flags['no-machine'];
  const isFile = fs.statSync(target).isFile();
  const { root, entries } = resolveScanScope(target, walkFiles);
  const records = collectMcpInventory(root, entries, { machine, file: isFile ? target : null });
  const unread = unreadMcpStores().map((u) => ({ file: displayPath(u.file, root), state: u.state }));

  if (!records.length) {
    printNothingFound(flags, root, machine, unread);
    return;
  }
  if (flags['dry-run']) {
    printDryRun(flags, records, url);
    return;
  }

  const offline = advisoriesDisabled(flags);
  const concurrency = clampInt(process.env.NOFLY_GATE_CONCURRENCY, DEFAULT_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY);
  const result = await assessMcpInventory(records, { url, offline, index: !flags['no-index'], concurrency });
  const state = { ...result, url, offline };
  const active = records.filter((r) => !r.disabled);
  const blocked = active.filter((r) => r.alert === 'BLOCK').length;
  const flagged = active.filter((r) => r.alert === 'FLAG').length;

  if (flags.json) {
    console.log(JSON.stringify({ detected: records.length, blocked, flagged, advisories: result.advisories, index: result.index, url, unread, ...(entries.capped ? { capped: true, filesRead: entries.length } : {}), servers: records.map(jsonRecord) }, null, 2));
  } else {
    const c = counts(records);
    const spread = [c.machine && `${c.machine} on this machine`, c.project && `${c.project} in project configs`, c.code && `${c.code} in code`].filter(Boolean).join(' · ');
    console.log(bold(cyan('\n  NoFly MCP servers')) + dim(` - ${records.length} server(s) · ${spread}`));
    console.log(dim(`  Checked against ${sourcesLabel(state)}.`));
    for (const line of notices(state, unread, entries.capped, entries.length)) console.log(`  ${line}`);
    const order = { BLOCK: 0, FLAG: 1, OK: 2 };
    for (const rec of [...records].sort((a, b) => (order[a.alert] - order[b.alert]) || Number(a.disabled) - Number(b.disabled))) printServer(rec, state);
    console.log(`\n  ${summaryLine(active)}\n`);
  }

  if (blocked) process.exitCode = 1;
  else if (flagged && flags.strict) process.exitCode = 2;
}

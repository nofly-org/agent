import path from 'node:path';
import { printArtifacts, printAssets } from '../artifacts/report.mjs';
import { api, machineInfo } from '../core/api-client.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { exitNotConfigured } from '../core/exit-codes.mjs';
import { clampInt } from '../core/numbers.mjs';
import { SEV_COLOR, VERDICT_COLOR, bold, cyan, dim, gray, green, red, yellow } from '../core/terminal.mjs';
import { VERSION } from '../core/version.mjs';
import { maskDeep } from '../detect/secret-mask.mjs';
import { discoverAgentArtifacts } from '../inventory/agent-artifacts.mjs';
import { discoverAll, discoveryFailures } from '../inventory/discovery.mjs';
import { unreadMcpStores } from '../inventory/discovery/mcp-servers.mjs';
import { mergeHomeArtifacts, mergeHomeAssets } from '../inventory/multi-home.mjs';
import { consoleUser, isPrivileged, listUserHomes, orderHomes } from '../core/user-homes.mjs';

function discover(flags) {

  const roots = flags.path ? [path.resolve(String(flags.path))] : [process.cwd()];
  return discoverAll(roots, { autoExpand: !flags.path });
}

function discoverArtifacts(flags) {
  const cwd = flags.path ? path.resolve(String(flags.path)) : process.cwd();
  return discoverAgentArtifacts(cwd);
}

function discoverAllUsers(flags) {
  const cwd = flags.path ? path.resolve(String(flags.path)) : process.cwd();
  const homes = listUserHomes();
  const ordered = orderHomes(homes, consoleUser({ homes }));
  const runs = [];
  const unreadStores = [];
  for (const h of ordered) {
    const assets = discoverAll(h.invoking ? [cwd] : [], { autoExpand: !flags.path, home: h.home });
    for (const s of unreadMcpStores()) unreadStores.push(h.invoking ? s : { ...s, osUser: h.user });
    const found = discoverAgentArtifacts(cwd, null, { home: h.home });
    runs.push({ ...h, assets, ...found });
  }
  return { assets: mergeHomeAssets(runs), ...mergeHomeArtifacts(runs), unreadStores, homes: ordered.map((h) => ({ user: h.user, home: h.home })) };
}

function withFailures(found) {
  const failed = discoveryFailures();
  return failed.length ? { ...found, capped: [...(found.capped ?? []), ...failed] } : found;
}

function discoverEverything(flags) {
  if (flags['all-users']) return withFailures(discoverAllUsers(flags));
  const assets = discover(flags);
  const found = discoverArtifacts(flags);
  return withFailures({ assets, ...found, unreadStores: unreadMcpStores() });
}

export async function cmdScan(flags) {
  const cfg = loadConfig();
  if (flags['all-users'] && !flags.json && !isPrivileged()) {
    console.error(yellow('  ⚠ ') + dim('--all-users without root/Administrator: homes of other accounts are usually unreadable and will be missed.'));
  }
  const { assets, artifacts, capped, available, unreadStores, homes } = discoverEverything(flags);
  
  if (flags.json && !flags.report) {
    console.log(JSON.stringify({ machine: machineInfo(cfg), ...(homes ? { homes } : {}), assets: maskDeep(assets), artifacts: maskDeep(artifacts), capped, available, ...(unreadStores.length ? { unreadMcpStores: unreadStores } : {}) }, null, 2));
    return;
  }
  if (!flags.json) {
    console.log(bold(cyan('\n  Shomra')) + dim(` agent v${VERSION} - local scan`));
    if (homes) console.log(dim(`  ${homes.length} user home(s): ${homes.map((h) => h.user).join(', ')}`));
    printAssets(assets);
    for (const s of unreadStores) {
      console.log(`  ${yellow('⚠')} ${dim(`MCP servers in ${s.file} were NOT read (${s.state === 'no-sqlite' ? 'this Node has no node:sqlite - use Node 22.5+' : s.state}) - not the same as none.`)}`);
    }
    printArtifacts(artifacts, capped, available);
  }

  if (flags.report) {
    await sendReport(cfg, assets, flags, { artifacts, capped, available });
  } else {
    console.log(
      dim('\n  Run ') + bold('shomra report') + dim(' to analyze these on the platform and see findings.\n'),
    );
  }
}

const MAX_REPORT_BYTES = 5 * 1024 * 1024 - 256 * 1024;

export function fitReport(body, limit = MAX_REPORT_BYTES) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value));
  let total = size(body);
  if (total <= limit) return { body, left: 0 };
  const artifacts = body.artifacts ?? [];
  const bySize = artifacts.map((artifact, index) => ({ index, bytes: size(artifact) })).sort((a, b) => b.bytes - a.bytes);
  const left = new Set();
  for (const { index, bytes } of bySize) {
    if (total <= limit) break;
    left.add(index);
    total -= bytes;
  }
  const fitted = {
    ...body,
    artifacts: artifacts.filter((_, index) => !left.has(index)),
    capped: [...(body.capped ?? []), ...[...left].map((index) => ({ reason: 'report-size', path: artifacts[index]?.path ?? artifacts[index]?.name ?? null }))],
  };
  return size(fitted) <= limit ? { body: fitted, left: left.size } : null;
}

async function sendReport(cfg, assets, flags, extra = {}) {
  const { apiKey, url } = resolveSettings(cfg);
  if (!apiKey) {
    exitNotConfigured();
  }
  const artifacts = extra.artifacts ?? [];
  const capped = extra.capped ?? [];
  const available = extra.available ?? [];
  const fitted = fitReport({
    machine: { ...machineInfo(cfg), scope: flags['all-users'] ? 'all-users' : 'user' },
    assets: maskDeep(assets),
    artifacts: maskDeep(artifacts),
    capped,
    available,
  });
  if (!fitted) {
    console.error(`  ${red('✗')} The inventory is larger than the server accepts in one report even without artifact contents - nothing was sent. Narrow it with --path <dir>.`);
    process.exitCode = 1;
    return;
  }
  if (fitted.left && !flags.json) console.log(yellow(`\n  ⚠ ${fitted.left} artifact(s) were left out to fit the server's size limit - they are listed as skipped, not as clean.`));
  if (!flags.json) process.stdout.write(dim('\n  Reporting to platform… '));
  try {
    const res = await api(url, apiKey, '/agent/report', fitted.body, {
      timeoutMs: clampInt(process.env.SHOMRA_API_TIMEOUT_MS, 180000, 1000, 600000),
    });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
      if ((res?.critical ?? 0) > 0) process.exitCode = 1;
      return;
    }
    console.log(
      green('done') +
        dim(` (${res.assets} assets analyzed`) +
        (res.artifacts ? dim(`, ${res.artifacts.registered} artifacts registered`) : '') +
        dim(')'),
    );
    console.log('');
    if (Array.isArray(res.results)) {
      for (const r of res.results.filter((x) => x.findingCount > 0)) {
        const vc = VERDICT_COLOR[r.verdict] || gray;
        console.log(`  ${vc('●')} ${bold(r.name)} ${dim('risk ' + r.riskScore)} ${vc(r.verdict)}`);
        for (const f of r.findings || []) {
          console.log(`      ${SEV_COLOR[f.severity](String(f.severity).padEnd(8))} ${f.title}`);
        }
      }
    }
    const crit = res.critical ?? 0;
    const high = res.high ?? 0;
    console.log(
      '\n  ' +
        (crit + high > 0
          ? `${red(crit + ' critical')} · ${yellow(high + ' high')} ${dim('- view & remediate at the Shomra dashboard')}`
          : green('No high-severity findings. ') + dim('Nice and clean.')),
    );
    console.log(dim(`  Endpoint: ${res.endpointId}\n`));
    if (crit > 0) process.exitCode = 1;
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ error: e.message }, null, 2));
    else console.log(red('failed'));
    console.error(`  ${red('✗')} ${e.message}\n`);

    process.exitCode = 1;
  }
}

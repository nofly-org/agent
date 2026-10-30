import os from 'node:os';
import { agentHookInstalled } from '../agents/hook-files.mjs';
import { AGENT_KEYS, AGENT_LABELS } from '../agents/installers.mjs';
import { keyScope } from '../core/api-key.mjs';
import { breakerCooldownMs, breakerOpen, guardTimeoutMs } from '../core/circuit-breaker.mjs';
import { CONFIG_FILE, loadConfig, resolveSettings } from '../core/config.mjs';
import { bold, cyan, dim, gray, green, red, yellow } from '../core/terminal.mjs';
import { VERSION } from '../core/version.mjs';
import { envFlag } from '../guard/options.mjs';
import { identityStatus } from './agent-identity.mjs';
import { RULE_PACKS_STALE_MS, readRulePacks } from '../core/rule-packs.mjs';

async function rulePackLine(url) {
  const read = await readRulePacks({ url }).catch((e) => ({ error: e?.message ?? String(e) }));
  if (!read) return `${yellow('none')}${dim(url ? ' - run: nofly packs sync' : ' - they come from a NoFly server')}`;
  if ('error' in read) return `${red('refused')}${dim(` - ${read.error}`)}`;
  const rules = read.packs.reduce((n, p) => n + p.rules.length, 0);
  const stale = Date.now() - Date.parse(read.fetchedAt ?? '') > RULE_PACKS_STALE_MS;
  return `${green(`${rules} rules`)}${dim(` in ${read.packs.length} packs, issued ${read.issuedAt}`)}${stale ? yellow(' stale') : ''}`;
}

export async function cmdStatus() {
  const cfg = loadConfig();
  const { apiKey, url } = resolveSettings(cfg);
  const enrolled = !!apiKey;
  console.log(bold(cyan('\n  NoFly agent')) + dim(` v${VERSION}`));

  if (enrolled) {
    console.log(`  ${dim('Mode     ')} ${green('● Enrolled')} ${dim(`(${keyScope(apiKey)} key)`)} - org policy, platform AI & dashboard telemetry active`);
  } else {
    const offline = /^(1|true|yes)$/i.test(String(process.env.NOFLY_OFFLINE ?? ''));
    console.log(`  ${dim('Mode     ')} ${cyan('● Local')} ${dim(offline ? '- on-machine analysis only; nothing leaves this machine' : '- on-machine analysis; only pinned MCP package names are looked up on osv.dev (NOFLY_OFFLINE=1 stops that)')}`);
    console.log(`  ${dim('         ')} ${dim('Run')} ${bold('nofly init --key shm_…')} ${dim('to add org policy, AI fixes, deep scans & the dashboard.')}`);
  }
  console.log(`  ${dim('Backend  ')} ${url || dim('none (local mode - set with nofly init --url)')}`);
  console.log(`  ${dim('API key  ')} ${apiKey ? green(apiKey.slice(0, 14) + '…') : dim('none (local mode)')}`);
  const identity = identityStatus(cfg, url);
  console.log(`  ${dim('Agent ID ')} ${identity ? green(identity) : dim('none - calls carry no agent identity (nofly agent-identity register)')}`);
  console.log(`  ${dim('Machine  ')} ${os.hostname()} ${dim('(' + (cfg.machineId || 'unenrolled') + ')')}`);
  console.log(`  ${dim('Config   ')} ${CONFIG_FILE}`);

  console.log(bold('\n  Available now') + dim(enrolled ? '' : ' (local, no key)'));
  console.log(`  ${green('✓')} ${dim('check · gate · doctor · protect · secrets · models · new · mcp add · why (offline)')}`);
  console.log(`  ${enrolled ? green('✓') : gray('○')} ${(enrolled ? dim : gray)('fix (AI) · deep scans (scan-zip/model-scan/memory-scan) · org policy · dashboard telemetry')}`);

  const localOff = process.env.NOFLY_GUARD_LOCAL === '0' || String(process.env.NOFLY_GUARD_LOCAL).toLowerCase() === 'false';
  const strict = envFlag('NOFLY_GUARD_STRICT');
  console.log(bold('\n  Runtime firewall'));
  const installedAgents = AGENT_KEYS.map((a) => ({ agent: a, files: agentHookInstalled(a) })).filter((x) => x.files.length);
  if (installedAgents.length) {
    let first = true;
    for (const { agent, files } of installedAgents) {
      console.log(`  ${dim(first ? 'Hooks    ' : '         ')} ${green('installed')} ${bold(AGENT_LABELS[agent])} ${dim('→ ' + files.join(', '))}`);
      first = false;
    }
    const missing = AGENT_KEYS.filter((a) => !installedAgents.some((i) => i.agent === a));
    if (missing.length) console.log(`  ${dim('         ')} ${dim('not installed: ' + missing.map((m) => AGENT_LABELS[m]).join(', '))}`);
  } else {
    console.log(`  ${dim('Hooks    ')} ${yellow('not installed for any agent')}${dim('  (run: nofly install-hook --agent all  or  nofly protect)')}`);
  }
  console.log(`  ${dim('Tier 0   ')} ${localOff ? yellow('off') + dim(' (server-only)') : green('on') + dim(' - dangerous calls blocked on-machine, zero network')}`);
  if (!localOff) console.log(`  ${dim('         ')} ${dim(enrolled ? 'reworded instructions are checked by your NoFly server; while it is unreachable only the on-machine rules run' : 'on-machine rules only - instructions reworded to slip past them need a NoFly server')}`);
  console.log(`  ${dim('Rules    ')} ${await rulePackLine(url)}`);
  console.log(`  ${dim('Mode     ')} ${strict ? 'fail-closed (strict)' : 'fail-open'}${dim(` · server timeout ${guardTimeoutMs()}ms · breaker ${breakerCooldownMs()}ms`)}`);
  console.log(`  ${dim('Breaker  ')} ${breakerOpen() ? red('OPEN') + dim(' - backend recently unreachable; server tier is being skipped') : green('closed')}\n`);
}

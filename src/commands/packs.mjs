import { loadConfig, resolveSettings } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { RULE_PACKS_STALE_MS, pinnedKey, readRulePacks, rulePacksOff, syncRulePacks } from '../core/rule-packs.mjs';
import { bold, dim, green, red, yellow } from '../core/terminal.mjs';

const USAGE = 'nofly packs [sync [--trust-new-key] [--quiet] | status] [--json]';

async function status(url, flags) {
  const read = await readRulePacks({ url });
  const pinned = pinnedKey(url);
  const out = !read
    ? { state: 'none', pinned }
    : 'error' in read
      ? { state: 'refused', error: read.error, fetchedAt: read.fetchedAt, pinned }
      : {
          state: Date.now() - Date.parse(read.fetchedAt ?? '') > RULE_PACKS_STALE_MS ? 'stale' : 'current',
          packs: read.packs.length,
          rules: read.packs.reduce((n, p) => n + p.rules.length, 0),
          issuedAt: read.issuedAt,
          fetchedAt: read.fetchedAt,
          pinned,
        };
  if (rulePacksOff()) out.off = true;
  if (flags.json) {
    console.log(JSON.stringify(out));
    return;
  }
  if (out.state === 'none') {
    console.log(`  ${dim('Rule packs')} ${yellow('none on this machine')} ${dim(url ? '- run `nofly packs sync`' : '- they come from a NoFly server (nofly init --key … --url …)')}`);
  } else if (out.state === 'refused') {
    console.log(`  ${dim('Rule packs')} ${red('refused')} ${dim(`- ${out.error}`)}`);
  } else {
    const age = out.state === 'stale' ? yellow(' stale') : '';
    console.log(`  ${dim('Rule packs')} ${green(`${out.rules} rules`)} ${dim(`in ${out.packs} packs, issued ${out.issuedAt}, fetched ${out.fetchedAt}`)}${age}`);
  }
  if (out.off) console.log(`  ${dim('          ')} ${yellow('not applied')} ${dim('- NOFLY_RULE_PACKS is off')}`);
  if (pinned) console.log(`  ${dim('Server key')} ${dim(pinned.slice(0, 16) + '…')}`);
}

export async function cmdPacks(flags, positional = []) {
  const sub = positional[0] ?? 'status';
  const { url, apiKey } = resolveSettings(loadConfig());
  if (sub === 'status') return status(url, flags);
  if (sub !== 'sync') {
    console.error(`${red('✗')} Unknown packs command: ${sub}  ${dim(`(usage: ${USAGE})`)}`);
    process.exit(EXIT_USAGE);
  }
  const result = await syncRulePacks({ url, apiKey, trustNewKey: !!flags['trust-new-key'] });
  if (flags.json) console.log(JSON.stringify(result));
  else if (!flags.quiet) {
    if (!result.ok) console.error(`  ${red('✗')} Rule packs not updated: ${result.error}`);
    else {
      console.log(`  ${green('✓')} ${bold(`${result.rules} rules`)} ${dim(`in ${result.packs} packs, issued ${result.issuedAt}`)}`);
      if (result.pinnedNow) console.log(`  ${dim('Trusting this server key from now on:')} ${result.fingerprint.slice(0, 16)}…`);
    }
  }
  if (!result.ok) process.exit(1);
}

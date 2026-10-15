import os from 'node:os';
import { api, machineInfo } from '../core/api-client.mjs';
import { CONFIG_FILE, MACHINE_CONFIG_FILE, getMachineId, loadMachineConfig, loadUserConfig, markMachineConfig, parseBackendUrl, saveConfig } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { bold, dim, green, red, yellow } from '../core/terminal.mjs';
import { isPrivileged } from '../core/user-homes.mjs';

export async function cmdInit(flags) {
  if (flags.machine && !isPrivileged()) {
    console.error(red('✗') + ' ' + bold('nofly init --machine') + ` writes ${MACHINE_CONFIG_FILE} and must run as root (sudo) or an elevated Administrator.`);
    process.exit(EXIT_USAGE);
  }
  const cfg = flags.machine ? markMachineConfig(loadMachineConfig() ?? {}) : loadUserConfig();
  const key = String(flags.key || process.env.NOFLY_API_KEY || '').trim();
  const rawUrl = flags.url || process.env.NOFLY_URL || cfg.url || (flags.machine ? '' : loadMachineConfig()?.url) || '';
  if (!key) {
    console.error(red('✗') + ' Missing API key. Run: ' + bold('nofly init --key shm_live_… --url <your backend>'));
    process.exit(EXIT_USAGE);
  }
  if (!/^(?:shm|dgx)_[A-Za-z0-9_-]+$/.test(key)) {
    console.error(red('✗') + ' That does not look like a NoFly API key (they start with shm_). Copy it from the platform → Settings → API Keys.');
    process.exit(EXIT_USAGE);
  }
  if (!rawUrl) {
    console.error(red('✗') + ' Missing backend URL. Run: ' + bold('nofly init --key shm_live_… --url <your backend>'));
    process.exit(EXIT_USAGE);
  }
  const parsed = parseBackendUrl(rawUrl);
  if (parsed.error) {
    console.error(`${red('✗')} ${parsed.error}`);
    process.exit(EXIT_USAGE);
  }
  const { url } = parsed;
  if (parsed.cleartext) console.error(`  ${yellow('⚠')} ${dim(`${url} is plain http to another machine - your API key will cross the network unencrypted. Use https.`)}`);
  getMachineId(cfg);
  const machine = machineInfo(cfg);
  process.stdout.write(dim('Enrolling this machine… '));
  try {
    const res = await api(url, key, '/agent/enroll', { machine });
    cfg.apiKey = key;
    cfg.url = url;
    saveConfig(cfg);
    console.log(green('done'));
    console.log(`  ${green('✓')} Enrolled ${bold(os.hostname())} into org ${bold(res.org?.name ?? '?')}`);
    console.log(`  ${dim('Config saved to ' + (flags.machine ? MACHINE_CONFIG_FILE : CONFIG_FILE))}`);
    console.log(`\n  Next: ${bold(flags.machine ? 'nofly schedule install --all-users' : 'nofly report')} to send your first inventory.`);
  } catch (e) {
    console.log(red('failed'));
    console.error(`  ${red('✗')} ${e.message}`);
    process.exit(1);
  }
}

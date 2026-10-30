import fs from 'node:fs';
import { api } from '../core/api-client.mjs';
import { git } from '../core/git-exec.mjs';
import { getMachineId, loadConfig, resolveSettings, saveAgentCredential } from '../core/config.mjs';
import { EXIT_USAGE, exitNotConfigured } from '../core/exit-codes.mjs';
import { bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { WORKLOAD_SOURCES, platformToken, workloadCachePath, workloadKey, workloadSource, writeCachedCredential } from '../core/workload-identity.mjs';

const ORG_AUDIENCE_SOURCES = new Set(['github', 'gitlab', 'kubernetes']);
const PROVIDER_LABEL = { github: 'GitHub Actions', gitlab: 'GitLab CI', kubernetes: 'Kubernetes', entra: 'Microsoft Entra', okta: 'Okta' };
const CI_MARKERS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD'];

export async function cmdAgentIdentity(flags, positional) {
  const sub = (positional[0] || 'register').toLowerCase();
  const cfg = loadConfig();
  const { apiKey, url } = resolveSettings(cfg);
  if (!apiKey) {
    exitNotConfigured();
  }
  if (sub !== 'register') {
    console.error(`\n  ${red('✗')} Unknown subcommand "${sub}". Use: ${bold('nofly agent-identity register --name "…" --type coding-agent')}`);
    console.error(dim('  (List / govern / revoke identities in the dashboard → Agent Identities.)\n'));
    process.exit(EXIT_USAGE);
  }
  const source = registrationWorkload(flags);
  if (source === undefined) {
    console.error(`\n  ${red('✗')} --workload must be one of: ${WORKLOAD_SOURCES.join(', ')}.\n`);
    process.exit(EXIT_USAGE);
  }
  if (!source && inCi() && !flags.static) {
    console.error(`\n  ${red('✗')} ${bold('Registering from CI with a stored credential mints a new agent and a new secret on every run')}, and prints that secret into the build log.`);
    console.error(dim('    Let the job prove who it is instead. GitHub Actions: give the job `permissions: id-token: write`.'));
    console.error(dim('    GitLab CI: add `id_tokens: NOFLY_ID_TOKEN` with your org’s audience. Then run this again - it registers with no secret,'));
    console.error(dim('    and running it on every build returns the same agent.'));
    console.error(dim('    To register with a stored credential anyway, pass --static.\n'));
    process.exit(EXIT_USAGE);
  }
  if (source) return registerKeyless(flags, { url, apiKey, source });
  if (!inCi() && !flags.static && !flags['no-save']) return registerOnMachine(flags, { url, apiKey, cfg });
  return registerWithCredential(flags, { url, apiKey });
}

async function registerOnMachine(flags, { url, apiKey, cfg }) {
  const res = await callRegister(url, apiKey, { ...registrationBody(flags), machineBound: true, machineId: getMachineId(cfg) });
  const target = credentialTarget(flags);
  let savedTo = null;
  try {
    savedTo = saveAgentCredential(target, { machineBound: true, slug: res.slug, name: res.name, url, savedAt: new Date().toISOString() });
  } catch (e) {
    console.error(yellow(`  ! The binding could not be saved (${e.message}). Re-run on this machine, or pass --static to use a stored credential.`));
  }
  if (flags.json) {
    console.log(JSON.stringify({ ...res, credential: undefined }, null, 2));
    return;
  }
  console.log(`\n  ${green('✓')} Registered agent identity ${bold(res.name)} ${dim('(' + res.slug + ' · ' + res.type + ')')} bound to this machine`);
  console.log(dim('    No long-lived credential was stored. The firewall on this machine asks for an hour-long session as it needs one.'));
  if (savedTo) console.log(dim(`    Binding saved to ${savedTo}${target !== 'default' ? ` for ${target}` : ''}. Use --static for a stored credential instead.`));
  afterRegistration(res);
}

export function registrationWorkload(flags, env = process.env) {
  if (flags?.static) return null;
  if (flags?.workload) {
    const v = String(flags.workload).trim().toLowerCase();
    return WORKLOAD_SOURCES.includes(v) ? v : undefined;
  }
  const named = workloadSource(env);
  if (named) return named;
  if (env.GITHUB_ACTIONS === 'true' && env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return 'github';
  if (env.GITLAB_CI && String(env.NOFLY_ID_TOKEN ?? '').trim()) return 'gitlab';
  return null;
}

export function inCi(env = process.env) {
  return CI_MARKERS.some((k) => {
    const v = String(env[k] ?? '').trim().toLowerCase();
    return !!v && v !== 'false' && v !== '0';
  });
}

export function registrationBody(flags) {
  const purpose = flags.purpose ? String(flags.purpose).trim() : '';
  return {
    name: flags.name ? String(flags.name) : undefined,
    slug: flags.slug ? String(flags.slug) : undefined,
    type: flags.type ? String(flags.type) : undefined,
    ownerEmail: ownerEmail(flags),
    projectId: flags.project ? String(flags.project) : undefined,
    description: purpose || undefined,
    role: flags.role ? String(flags.role).trim() : undefined,
  };
}

export function credentialTarget(flags) {
  const v = flags?.for ? String(flags.for).trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : 'default';
}

async function callRegister(url, apiKey, body) {
  try {
    return await api(url, apiKey, '/agents/register', body);
  } catch (e) {
    console.error(`\n  ${red('✗')} ${e.message}`);
    if (e.status === 400 && /named owner/i.test(e.message)) console.error(dim('    Pass --owner <email>: an active member of your NoFly org who answers for this agent.'));
    if (e.status === 409) console.error(dim('    Nothing was created. Run it again, or choose another --name.'));
    if (e.status === 403 && /cannot register another agent/i.test(e.message)) console.error(dim('    Register with the org key `nofly init` stored, a CI key, or from the dashboard.'));
    console.error('');
    process.exit(1);
  }
}

async function registerWithCredential(flags, { url, apiKey }) {
  const res = await callRegister(url, apiKey, registrationBody(flags));
  const target = credentialTarget(flags);
  let savedTo = null;
  if (res.credential && !flags['no-save']) {
    try {
      savedTo = saveAgentCredential(target, { credential: res.credential, slug: res.slug, name: res.name, url, savedAt: new Date().toISOString() });
    } catch (e) {
      console.error(yellow(`  ! The credential could not be saved (${e.message}). It is printed below instead.`));
    }
  }
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`\n  ${green('✓')} Registered agent identity ${bold(res.name)} ${dim('(' + res.slug + ' · ' + res.type + ')')}`);
  if (res.credential) {
    if (savedTo) {
      console.log(`  ${dim('Credential')} ${cyan(`${res.credentialPrefix ?? res.credential.slice(0, 14)}…`)} ${dim(`saved to ${savedTo}${target !== 'default' ? ` for ${target}` : ''}`)}`);
      console.log(dim('    The runtime firewall on this machine presents it from the next call - nothing to export, nothing to restart.'));
      if (flags['print-credential']) printSecret(res.credential);
    } else {
      console.log(`\n  ${bold('Credential')} ${dim('(shown once - store it securely):')}`);
      printSecret(res.credential);
      console.log(dim('    Present it as NOFLY_AGENT="<the credential above>" where the agent runs.'));
    }
    if (res.credentialLifetime?.statement) console.log(dim(`    ${res.credentialLifetime.statement}`));
  }
  afterRegistration(res);
}

async function registerKeyless(flags, { url, apiKey, source }) {
  let audience = String(flags.audience ?? process.env.NOFLY_AUDIENCE ?? '').trim();
  if (!audience) {
    if (!ORG_AUDIENCE_SOURCES.has(source)) {
      console.error(`\n  ${red('✗')} --audience is required for ${PROVIDER_LABEL[source] ?? source}: the audience of the app you registered for NoFly.\n`);
      process.exit(EXIT_USAGE);
    }
    try {
      audience = String((await api(url, apiKey, '/agents/register/workload', null, { method: 'GET' }))?.audience ?? '');
    } catch (e) {
      console.error(`\n  ${red('✗')} Could not read this org’s workload audience: ${e.message}\n`);
      process.exit(1);
    }
  }
  let token;
  try {
    token = await platformToken(source, audience);
  } catch (e) {
    console.error(`\n  ${red('✗')} No ${PROVIDER_LABEL[source] ?? source} identity token: ${e.message}\n`);
    process.exit(1);
  }
  const res = await callRegister(url, apiKey, { ...registrationBody(flags), workloadProvider: source, workloadToken: token });
  if (res.credential && res.credentialExpiresAt) {
    try {
      writeCachedCredential(workloadCachePath(), { url, source, audience, workload: workloadKey(source, process.env), credential: res.credential, expiresAt: res.credentialExpiresAt });
    } catch {}
  }
  const exported = exportSignIn(source, audience);
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const reg = res.registration ?? {};
  console.log(
    reg.existing
      ? `\n  ${green('✓')} Already registered as ${bold(res.name)} ${dim('(' + res.slug + ')')} ${dim('- nothing about it was changed')}`
      : `\n  ${green('✓')} Registered ${bold(res.name)} ${dim('(' + res.slug + ' · ' + res.type + ')')} ${green('with no stored agent credential')}`,
  );
  if (reg.binding?.subject) console.log(`  ${dim('Signs in as')} ${reg.binding.subject} ${dim(`(${PROVIDER_LABEL[source] ?? source})`)}`);
  if (res.credential) console.log(dim(`    Session valid ${reg.sessionMinutes ?? 60} minutes, renewed from the job’s own identity token - there is no agent credential to store or rotate.`));
  console.log(`  ${dim('Later steps')} NOFLY_WORKLOAD=${source} NOFLY_AUDIENCE=${audience}${exported ? dim('  (written to $GITHUB_ENV)') : ''}`);
  for (const w of reg.warnings ?? []) console.log(`  ${yellow('!')} ${w}`);
  if (reg.refused) console.log(`  ${red('!')} ${reg.refused}`);
  afterRegistration(res);
}

function afterRegistration(res) {
  if (res.status === 'PENDING') {
    console.log(`\n  ${yellow('!')} ${bold('Pending until someone activates it.')} ${dim('Every call it makes is flagged until it is activated in the dashboard. Pass --role <saved role> to register it under a policy someone already approved.')}`);
  }
  if (res.owner) {
    console.log(`  ${dim('Owner:')} ${res.owner.email ?? res.owner.name}`);
  } else {
    console.log(`\n  ${red('!')} ${bold('No owner recorded.')} ${dim('Nobody is accountable for this identity.')}`);
    console.log(dim('    Re-run with --owner <email> (an active NoFly seat), or assign one in the dashboard.'));
  }
  if (!res.description) {
    console.log(`  ${yellow('!')} ${bold('No purpose recorded.')} ${dim('Add --purpose "what it does" so its calls can be held to it.')}`);
  }
  if (res.reviewDueAt) console.log(`  ${dim('Review due')} ${String(res.reviewDueAt).slice(0, 10)}`);
  if (res.handleShadow) {
    console.log(`\n  ${red('!')} ${bold('Another identity already answers to this name.')}`);
    console.log(dim(`    ${res.handleShadow.statement}`));
    console.log(dim(`    ${res.handleShadow.remedy}`));
  }
  console.log(dim(`    The credential proves who is calling. The handle (${res.slug}) is only a name anyone can type.`));
  console.log(dim(`  Then narrow its capabilities in the dashboard → Agent Identities.\n`));
}

function printSecret(secret) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${secret}`);
  console.log(`    ${cyan(secret)}`);
}

export function exportSignIn(source, audience, env = process.env) {
  const file = String(env.GITHUB_ENV ?? '').trim();
  if (!file || env.GITHUB_ACTIONS !== 'true') return false;
  try {
    fs.appendFileSync(file, `NOFLY_WORKLOAD=${source}\nNOFLY_AUDIENCE=${audience}\n`);
    return true;
  } catch {
    return false;
  }
}

export function ownerEmail(flags) {
  if (flags && flags.owner) return String(flags.owner).trim() || undefined;
  if (flags && flags['no-owner']) return undefined;
  try {
    const configured = git(['config', '--get', 'user.email'], { timeout: 2000 })?.trim();
    return configured || undefined;
  } catch {
    return undefined;
  }
}

export function resolveAgentIdentityHandle(flags) {
  const v = (flags && flags['agent-id'] && String(flags['agent-id'])) || process.env.NOFLY_AGENT || '';
  return v && String(v).trim() ? String(v).trim() : null;
}

export function identityStatus(cfg, url, env = process.env) {
  const explicit = String(env.NOFLY_AGENT ?? '').trim();
  if (explicit) {
    return explicit.startsWith('shm_agt_')
      ? `credential ${explicit.slice(0, 14)}… from NOFLY_AGENT`
      : `handle "${explicit.slice(0, 40)}" from NOFLY_AGENT - a name anyone can type; register it to get a credential`;
  }
  const source = workloadSource(env);
  if (source) return `keyless via ${PROVIDER_LABEL[source] ?? source} (NOFLY_WORKLOAD) - no stored agent credential`;
  const all = cfg?.agentCredentials && typeof cfg.agentCredentials === 'object' ? cfg.agentCredentials : {};
  const saved = Object.entries(all).filter(([, e]) => typeof e?.credential === 'string' && e.credential.startsWith('shm_agt_') && (!url || !e.url || e.url === url));
  if (saved.length) return `saved credential for ${saved.map(([k, e]) => `${k} (${e.slug ?? e.credential.slice(0, 14)})`).join(', ')}`;
  const bound = Object.entries(all).filter(([, e]) => e?.machineBound === true && typeof e.slug === 'string' && (!url || !e.url || e.url === url));
  if (bound.length) return `bound to this machine for ${bound.map(([k, e]) => `${k} (${e.slug})`).join(', ')} - hour-long sessions, no stored credential`;
  return null;
}

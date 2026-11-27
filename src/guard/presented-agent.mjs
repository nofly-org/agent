import { resolveAgentIdentityHandle } from '../commands/agent-identity.mjs';
import { storedAgentCredential } from '../core/config.mjs';
import { workloadCredential } from '../core/workload-identity.mjs';
import { machineSessionCredential, storedMachineBinding } from '../core/machine-session.mjs';
import { isAgentCredential } from '../core/api-key.mjs';

export async function presentedAgent(flags, { cfg, agent, url, signIn = workloadCredential, machineSession = machineSessionCredential } = {}) {
  const presented = resolveAgentIdentityHandle(flags);
  if (presented) return presented;
  const fromWorkload = url ? await signIn({ url, onError: () => {} }).catch(() => null) : null;
  if (fromWorkload) return fromWorkload;
  const binding = storedMachineBinding(cfg, agent, url);
  if (binding) {
    const session = await machineSession({ cfg, url, binding, onError: () => {} }).catch(() => null);
    if (session) return session;
  }
  return storedAgentCredential(cfg, agent, url) ?? null;
}

export function agentHeader(agentId) {
  return agentId ? { 'X-NoFly-Agent': agentId } : {};
}

export function grantHeader(env = process.env) {
  const grant = String(env.NOFLY_GRANT ?? '').trim();
  return /^(?:nfy|shm|dgx)_grt_[A-Za-z0-9_-]{8,200}$/.test(grant) ? { 'X-NoFly-Grant': grant } : {};
}

export function keyFor(apiKey, agentId) {
  return apiKey || (typeof agentId === 'string' && isAgentCredential(agentId) ? agentId : undefined);
}

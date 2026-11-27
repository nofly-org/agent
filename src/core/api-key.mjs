export const KEY_PREFIX = 'nfy_';
const KEY_RE = /^(?:nfy|shm|dgx)_/;

export function isNoFlyKey(value, scope) {
  const s = typeof value === 'string' ? value : '';
  return KEY_RE.test(s) && (!scope || s.slice(s.indexOf('_') + 1).startsWith(`${scope}_`));
}

export const isAgentCredential = (value) => isNoFlyKey(value, 'agt');

export function keyScope(key) {
  if (!key) return null;
  if (isNoFlyKey(key, 'gw')) return 'gateway';
  if (isNoFlyKey(key, 'ci')) return 'CI';
  return 'agent';
}

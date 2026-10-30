const HOSTNAME_RULE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function egressHostRule(value         )                {
  const host = String(value ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return HOSTNAME_RULE_RE.test(host) ? host : null;
}


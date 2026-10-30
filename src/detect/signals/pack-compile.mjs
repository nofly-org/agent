import { sanitizeFlags } from './regex-safety.mjs';

import { egressHostRule } from './egress-host.mjs';

export const MAX_RULES_PER_PACK = 500;

const SEVERITIES = new Set(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export function emptyCompiledRules()                {
  return { injection: [], injectionRe: [], egress: [], risky: [], malicious: [], secrets: [], shell: [] };
}

function regex(pattern         , flags        , opts                )         {
  const source = String(pattern);
  const re = new RegExp(source, flags);
  if (opts.linearTime && !opts.linearTime(source, flags)) {
    throw new Error(`pattern can catastrophically backtrack (ReDoS) - skipped: ${source.slice(0, 80)}`);
  }
  return re;
}

export function compileRule(kind        , rule     , into               , opts                 = {})          {
  switch (kind) {
    case 'injection-phrases':
      into.injection.push(String(rule));
      return true;
    case 'injection-regexes':
      into.injectionRe.push({ label: String(rule.name ?? rule.label ?? 'mined'), re: regex(rule.pattern, sanitizeFlags(rule.flags, 'i'), opts) });
      return true;
    case 'egress-hosts': {
      const host = egressHostRule(rule);
      if (!host) throw new Error(`"${String(rule).slice(0, 80)}" is not a hostname`);
      into.egress.push(host);
      return true;
    }
    case 'risky-config':
      into.risky.push(String(rule));
      return true;
    case 'malicious-packages':
      into.malicious.push(String(rule).toLowerCase());
      return true;
    case 'secret-patterns':
      into.secrets.push({ name: String(rule.name), re: regex(rule.pattern, sanitizeFlags(rule.flags), opts) });
      return true;
    case 'shell-signals':
      into.shell.push({
        name: String(rule.name),
        re: regex(rule.pattern, sanitizeFlags(rule.flags, 'i'), opts),
        severity: SEVERITIES.has(String(rule.severity)) ? rule.severity : 'MEDIUM',
      });
      return true;
    default:
      return false;
  }
}

export function compilePacks(packs             , opts                 = {})                                                                {
  const compiled = emptyCompiledRules();
  const kept              = [];
  let rules = 0;
  for (const pack of packs) {
    const list = Array.isArray(pack.rules) ? pack.rules : [];
    const good            = [];
    for (const rule of list.slice(0, MAX_RULES_PER_PACK)) {
      try {
        if (compileRule(pack.kind, rule, compiled, opts)) {
          rules++;
          good.push(rule);
        }
      } catch (e     ) {
        opts.onSkip?.(pack, String(e?.message ?? e));
      }
    }
    kept.push({ ...pack, rules: good });
  }
  return { compiled, rules, kept };
}


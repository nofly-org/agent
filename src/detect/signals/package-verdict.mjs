import { MALICIOUS_PACKAGE_SEED, PUBLIC_NPM_SCOPES, compromisedRelease, editDistance, isKnownPackage, isMaliciousPackage, typosquatTarget } from './package-names.mjs';

function lookalikeOf(name        )                                             {
  if (isKnownPackage(name)) return null;
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  if (scoped) {
    const scope = scoped[1].toLowerCase();
    if (PUBLIC_NPM_SCOPES.includes(scope)) return null;
    const near = PUBLIC_NPM_SCOPES.find((s) => s.length >= 6 && editDistance(scope, s) === 1);
    return near ? { popular: near, scope: scoped[1] } : null;
  }
  const popular = typosquatTarget(name);
  return popular ? { popular } : null;
}

export function localPackageVerdict(name        , version                    , ecosystem              )                           {
  if (ecosystem !== 'npm' && ecosystem !== 'pypi' && ecosystem !== 'PyPI') return null;
  const eco = ecosystem === 'npm' ? 'npm' : 'pypi';
  const bare = name.replace(/^@[^/]+\//, '');
  if (isMaliciousPackage(eco, name) || MALICIOUS_PACKAGE_SEED.has(name) || MALICIOUS_PACKAGE_SEED.has(bare)) {
    return { package: name, version, classification: 'malicious', detail: `"${name}" is on the known-malicious package list.` };
  }
  const compromised = compromisedRelease(eco, name, version);
  if (compromised) {
    return { package: name, version, classification: 'malicious', detail: `${name} ${version} is a known-compromised release: ${compromised}.` };
  }
  const squat = lookalikeOf(name);
  if (!squat) return null;
  return {
    package: name,
    version,
    classification: 'typosquat',
    detail: squat.scope
      ? `"${name}" publishes under ${squat.scope}, one edit away from the well-known ${squat.popular} scope - possible typosquat.`
      : `"${name}" is one edit away from the popular package "${squat.popular}" - possible typosquat.`,
  };
}

export function packageVerdictTitle(v                   )         {
  const label = v.classification === 'malicious' ? 'Malicious' : v.classification === 'vulnerable' ? 'Vulnerable' : 'Possible typosquat';
  return `${label} dependency: ${v.package}${v.version ? `@${v.version}` : ''}`;
}

export function packageVerdictSeverity(v                   )                      {
  return v.classification === 'malicious' ? 'CRITICAL' : 'HIGH';
}


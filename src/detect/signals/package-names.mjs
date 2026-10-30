import { INTEL_LIMITS, normalizePackageName, unpackPackageIntel,                   } from './package-intel.mjs';
import { PACKAGE_INTEL_SNAPSHOT } from './package-intel.snapshot.mjs';

export const POPULAR_PACKAGES           = [];

export const PUBLIC_NPM_SCOPES           = [];

export const MALICIOUS_PACKAGE_SEED = new Set        ();

export const PACKAGE_INTEL_STATE = { source: 'none', fetchedAt: '', version: 0, known: 0, malicious: 0, releases: 0 };

const KNOWN_PACKAGES = new Set        ();

const MALICIOUS_NAMES = new Set        ();

const COMPROMISED_RELEASES = new Map                                                 ();

const releaseKey = (ecosystem        , name        ) => {
  const eco = String(ecosystem ?? '').toLowerCase();
  return `${eco}:${normalizePackageName(eco, name)}`;
};

function rebuild   (target     , next     )       {
  target.length = 0;
  target.push(...next);
}

export function loadPackageIntel(intel              , source        )       {
  const targets = (list          ) =>
    list.filter((n) => !n.startsWith('@') && n.length >= INTEL_LIMITS.typosquatMinLength).slice(0, INTEL_LIMITS.typosquatTargets);
  rebuild(POPULAR_PACKAGES, [...new Set([...targets(intel.npm), ...targets(intel.pypi)])]);
  KNOWN_PACKAGES.clear();
  for (const n of [...intel.npm, ...intel.pypi]) KNOWN_PACKAGES.add(n);
  rebuild(PUBLIC_NPM_SCOPES, [...new Set(intel.npm.filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]))]);

  MALICIOUS_PACKAGE_SEED.clear();
  MALICIOUS_NAMES.clear();
  COMPROMISED_RELEASES.clear();
  for (const m of intel.malicious) {
    const k = releaseKey(m.ecosystem, m.name);
    if (!m.versions) {
      MALICIOUS_NAMES.add(k);
      MALICIOUS_PACKAGE_SEED.add(m.name);
      continue;
    }
    const prev = COMPROMISED_RELEASES.get(k);
    COMPROMISED_RELEASES.set(k, { versions: new Set([...(prev?.versions ?? []), ...m.versions]), what: prev?.what ?? `${m.summary} (${m.id})` });
  }

  PACKAGE_INTEL_STATE.source = source;
  PACKAGE_INTEL_STATE.fetchedAt = intel.fetchedAt;
  PACKAGE_INTEL_STATE.version++;
  PACKAGE_INTEL_STATE.known = KNOWN_PACKAGES.size;
  PACKAGE_INTEL_STATE.malicious = MALICIOUS_NAMES.size;
  PACKAGE_INTEL_STATE.releases = COMPROMISED_RELEASES.size;
}

export function isKnownPackage(name        )          {
  const n = String(name ?? '').trim().toLowerCase();
  return !!n && (KNOWN_PACKAGES.has(n) || KNOWN_PACKAGES.has(n.replace(/[-_.]+/g, '-')));
}

export function isMaliciousPackage(ecosystem        , name        )          {
  return MALICIOUS_NAMES.has(releaseKey(ecosystem, name));
}

export function releaseScoped(ecosystem        , name        )          {
  return COMPROMISED_RELEASES.has(releaseKey(ecosystem, name));
}

export function compromisedRelease(ecosystem        , name        , version                           )                {
  if (!version) return null;
  const hit = COMPROMISED_RELEASES.get(releaseKey(ecosystem, name));
  const v = version.trim().replace(/^[=v]+/, '');
  return hit && hit.versions.has(v) ? hit.what : null;
}

export function editDistance(a        , b        )         {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

export function typosquatTarget(name        )                {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n || n.startsWith('@') || isKnownPackage(n)) return null;
  return POPULAR_PACKAGES.find((p) => p !== n && Math.abs(p.length - n.length) <= 1 && editDistance(n, p) === 1) ?? null;
}

export const SNAPSHOT_INTEL               = unpackPackageIntel(PACKAGE_INTEL_SNAPSHOT);

loadPackageIntel(SNAPSHOT_INTEL, 'snapshot');


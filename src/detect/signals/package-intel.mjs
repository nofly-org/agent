import { malScope } from './osv-malicious.mjs';

export const PACKAGE_INTEL_KIND = 'package-intel';

const env = (name        , fallback        ) => (typeof process !== 'undefined' && process.env?.[name]?.trim()) || fallback;

export const INTEL_SOURCES = {
  npmTop: env('NOFLY_NPM_TOP_URL', 'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/package_names?sort=downloads&order=desc&per_page=1000&page={page}'),
  pypiTop: env('NOFLY_PYPI_TOP_URL', 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json'),
  osvIndex: env('NOFLY_OSV_INDEX_URL', 'https://osv-vulnerabilities.storage.googleapis.com/{ecosystem}/modified_id.csv'),
  osvRecord: env('NOFLY_OSV_RECORD_URL', 'https://osv-vulnerabilities.storage.googleapis.com/{ecosystem}/{id}.json'),
};

export const INTEL_LIMITS = {
  npmPages: 20,
  pypiTop: 15_000,
  typosquatTargets: 1_000,
  typosquatMinLength: 4,
  maliciousRetentionDays: 90,
  maliciousBackfillDays: 30,
  maliciousMax: 20_000,
  maliciousFetchesPerRun: 3_000,
  fetchConcurrency: 8,
};

const OSV_ECOSYSTEM                                 = { npm: 'npm', pypi: 'PyPI' };

const NAME_RE = /^(?:@[a-z0-9][\w.-]{0,213}\/)?[a-z0-9][\w.-]{0,213}$/i;

export function normalizePackageName(ecosystem        , name        )         {
  const n = String(name ?? '').trim().toLowerCase();
  return ecosystem === 'pypi' ? n.replace(/[-_.]+/g, '-') : n;
}

function names(list           , ecosystem                , max        )           {
  const out           = [];
  const seen = new Set        ();
  for (const raw of list) {
    if (typeof raw !== 'string' || !NAME_RE.test(raw.trim())) continue;
    const n = normalizePackageName(ecosystem, raw);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export function parseNpmTop(json         , max = INTEL_LIMITS.npmPages * 1000)           {
  return Array.isArray(json) ? names(json, 'npm', max) : [];
}

export function parsePypiTop(json         , max = INTEL_LIMITS.pypiTop)           {
  const rows = (json       )?.rows;
  return Array.isArray(rows) ? names(rows.map((r     ) => r?.project), 'pypi', max) : [];
}

export function parseModifiedIndex(csv        , since               )                                     {
  const floor = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const out                                     = [];
  for (const line of String(csv ?? '').split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const modified = line.slice(0, comma).trim();
    const id = line.slice(comma + 1).trim();
    if (!/^MAL-\d{4}-\d+$/.test(id)) continue;
    const at = Date.parse(modified);
    if (!Number.isFinite(at) || at <= floor) continue;
    out.push({ id, modified });
  }
  return out.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

export function maliciousEntryOf(record     , ecosystem                )                        {
  const id = String(record?.id ?? '');
  if (!/^MAL-/.test(id)) return null;
  const affected = (Array.isArray(record?.affected) ? record.affected : []).find(
    (a     ) => String(a?.package?.ecosystem ?? '').toLowerCase() === OSV_ECOSYSTEM[ecosystem].toLowerCase() && typeof a?.package?.name === 'string',
  );
  const name = affected?.package?.name;
  if (!name || !NAME_RE.test(name)) return null;
  const scope = malScope(record, name, OSV_ECOSYSTEM[ecosystem]);
  if (!scope) return null;
  return {
    ecosystem,
    name: normalizePackageName(ecosystem, name),
    versions: scope.whole || !scope.versions.length ? null : scope.versions,
    id,
    modified: String(record?.modified ?? ''),
    summary: String(record?.summary ?? `${id} (${ecosystem})`).slice(0, 200),
  };
}

async function pool      (items     , limit        , run                         )               {
  const out      = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const message = (e         ) => String((e       )?.message ?? e).slice(0, 200);

export function emptyPackageIntel()               {
  return { fetchedAt: '', sources: {}, npm: [], pypi: [], malicious: [], maliciousCursor: { npm: null, pypi: null } };
}

export async function fetchPackageIntel(get           , previous                     , now = new Date())                        {
  const prior = previous ?? emptyPackageIntel();
  const at = now.toISOString();
  const sources                              = {};
  const intel               = { ...prior, fetchedAt: at, sources, maliciousCursor: { ...prior.maliciousCursor } };

  try {
    const pages = await Promise.all(
      Array.from({ length: INTEL_LIMITS.npmPages }, (_, i) => get(INTEL_SOURCES.npmTop.replace('{page}', String(i + 1))).then((t) => JSON.parse(t))),
    );
    const npm = parseNpmTop(pages.flat());
    if (npm.length < 100) throw new Error(`only ${npm.length} npm names came back`);
    intel.npm = npm;
    sources.npm = { url: INTEL_SOURCES.npmTop, ok: true, at };
  } catch (e) {
    sources.npm = { url: INTEL_SOURCES.npmTop, ok: false, at, error: message(e) };
  }

  try {
    const pypi = parsePypiTop(JSON.parse(await get(INTEL_SOURCES.pypiTop)));
    if (pypi.length < 100) throw new Error(`only ${pypi.length} PyPI names came back`);
    intel.pypi = pypi;
    sources.pypi = { url: INTEL_SOURCES.pypiTop, ok: true, at };
  } catch (e) {
    sources.pypi = { url: INTEL_SOURCES.pypiTop, ok: false, at, error: message(e) };
  }

  const keep = new Map(prior.malicious.map((m) => [m.id, m]));
  for (const ecosystem of ['npm', 'pypi']                    ) {
    const osv = OSV_ECOSYSTEM[ecosystem];
    const indexUrl = INTEL_SOURCES.osvIndex.replace('{ecosystem}', osv);
    try {
      const since = prior.maliciousCursor[ecosystem] ?? new Date(now.getTime() - INTEL_LIMITS.maliciousBackfillDays * 86_400_000).toISOString();
      const fresh = parseModifiedIndex(await get(indexUrl), since).slice(0, INTEL_LIMITS.maliciousFetchesPerRun);
      let failed = 0;
      const records = await pool(fresh, INTEL_LIMITS.fetchConcurrency, async (row) => {
        try {
          return JSON.parse(await get(INTEL_SOURCES.osvRecord.replace('{ecosystem}', osv).replace('{id}', row.id)));
        } catch {
          failed++;
          return null;
        }
      });
      for (const record of records) {
        const entry = record ? maliciousEntryOf(record, ecosystem) : null;
        if (entry) keep.set(entry.id, entry);
        else if (record?.withdrawn && typeof record.id === 'string') keep.delete(record.id);
      }
      if (fresh.length) intel.maliciousCursor[ecosystem] = fresh[0].modified;
      sources[`osv-${ecosystem}`] = failed
        ? { url: indexUrl, ok: false, at, error: `${failed} of ${fresh.length} records could not be read` }
        : { url: indexUrl, ok: true, at };
    } catch (e) {
      sources[`osv-${ecosystem}`] = { url: indexUrl, ok: false, at, error: message(e) };
    }
  }

  const horizon = now.getTime() - INTEL_LIMITS.maliciousRetentionDays * 86_400_000;
  intel.malicious = [...keep.values()]
    .filter((m) => !Number.isFinite(Date.parse(m.modified)) || Date.parse(m.modified) >= horizon)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .slice(0, INTEL_LIMITS.maliciousMax);
  return intel;
}

export function packPackageIntel(intel              )                     {
  return {
    fetchedAt: intel.fetchedAt,
    sources: intel.sources,
    npm: intel.npm.join('\n'),
    pypi: intel.pypi.join('\n'),
    malicious: intel.malicious.map((m) => [m.ecosystem, m.name, m.versions ? m.versions.join(',') : '*', m.id, m.modified].join('\t')).join('\n'),
    maliciousCursor: intel.maliciousCursor,
  };
}

export function unpackPackageIntel(packed                    )               {
  const lines = (s        ) => (s ? s.split('\n') : []);
  return {
    fetchedAt: packed.fetchedAt,
    sources: packed.sources,
    npm: lines(packed.npm),
    pypi: lines(packed.pypi),
    malicious: lines(packed.malicious).map((l) => {
      const [ecosystem, name, versions, id, modified] = l.split('\t');
      return { ecosystem: ecosystem                  , name, versions: versions === '*' ? null : versions.split(','), id, modified, summary: id };
    }),
    maliciousCursor: packed.maliciousCursor,
  };
}

export function isPackedPackageIntel(value         )                              {
  const v = value                      ;
  return !!v && typeof v.npm === 'string' && typeof v.pypi === 'string' && typeof v.malicious === 'string' && typeof v.fetchedAt === 'string';
}

export function isPackageIntel(value         )                        {
  const v = value                ;
  return !!v && Array.isArray(v.npm) && Array.isArray(v.pypi) && Array.isArray(v.malicious) && typeof v.fetchedAt === 'string';
}


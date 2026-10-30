const MAX_LISTED_VERSIONS = 200;

export function normPackageName(name        )         {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

export function isMalId(id         )          {
  return typeof id === 'string' && id.slice(0, 4).toUpperCase() === 'MAL-';
}

export function malIdsOf(advisory                                                        )           {
  const aliases = Array.isArray(advisory?.aliases) ? advisory.aliases : [];
  return [advisory?.id, ...aliases].filter(isMalId)            ;
}

function unboundedFromZero(range     )          {
  const events        = Array.isArray(range?.events) ? range.events : [];
  const opensAtZero = events.some((e) => e?.introduced === '0' || e?.introduced === '0.0.0');
  const closes = events.some((e) => e && (e.fixed !== undefined || e.last_affected !== undefined || e.limit !== undefined));
  return opensAtZero && !closes;
}

export function malScope(record     , pkgName        , osvEcosystem        )                        {
  if (typeof record?.withdrawn === 'string' && record.withdrawn) return null;
  const wanted = normPackageName(pkgName);
  const eco = String(osvEcosystem ?? '').toLowerCase();
  const affected        = (Array.isArray(record?.affected) ? record.affected : []).filter((a     ) => {
    const n = a?.package?.name;
    const e = a?.package?.ecosystem;
    if (typeof n === 'string' && normPackageName(n) !== wanted) return false;
    return !(typeof e === 'string' && eco && e.toLowerCase() !== eco);
  });
  if (!affected.length) return null;
  let whole = false;
  const versions = new Set        ();
  for (const a of affected) {
    const ranges        = Array.isArray(a?.ranges) ? a.ranges : [];
    const listed           = (Array.isArray(a?.versions) ? a.versions : []).filter((v         ) => typeof v === 'string' && v);
    if (ranges.some(unboundedFromZero)) whole = true;
    else if (!ranges.length && !listed.length) whole = true;
    for (const v of listed) if (versions.size < MAX_LISTED_VERSIONS) versions.add(v);
  }
  return { whole, versions: [...versions] };
}

export function releaseNamedMalicious(releases                                , version                           )                          {
  const v = String(version ?? '').trim().replace(/^[=v]+(?=\d)/, '');
  if (!v || !releases?.length) return null;
  return releases.find((r) => r.versions.includes(v)) ?? null;
}


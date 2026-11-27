const PROBE_UNITS = ['a', 'a ', '-a', '_a', '.a', '/a', 'a.', 'a-', ' a', '@a', 'a/', 'ab'];
const PROBE_REPEATS = [8, 12, 16, 20, 24, 28, 34, 40, 46];
const PROBE_BUDGET_MS = 40;

const GROWTH_TERMINATORS = ['!', ' ', '\u0000'];
const GROWTH_SMALL = 2000;
const GROWTH_LARGE = 8000;
const GROWTH_FLOOR_MS = 25;
const GROWTH_RATIO = 8;
const HUGE_COST_MS = 100;

function growthUnits(source        )           {
  const inPattern = new Set        ();
  for (const ch of source) if (/[A-Za-z0-9.\-_/@= ]/.test(ch)) inPattern.add(ch);
  const singles = [...inPattern].slice(0, 8);
  const units = new Set        ([...PROBE_UNITS, ...singles]);
  for (const a of singles.slice(0, 4)) for (const b of singles.slice(0, 4)) if (a !== b) units.add(a + b);

  const branches = new Set        ();
  for (const g of source.matchAll(/\((?:\?:)?([^()]{2,800})\)/g)) {
    if (!g[1].includes('|')) continue;
    for (const alt of g[1].split('|')) {
      const bare = alt.replace(/\\w[*+?]|\\w\{[^}]*\}|[*+?]$/g, '').trim();
      if (/^[A-Za-z0-9_]{2,24}$/.test(bare)) branches.add(bare);
    }
  }
  const stems = [...branches].slice(0, 24);
  for (const b of stems) units.add(b);
  for (const a of stems.slice(0, 4)) for (const b of stems.slice(0, 4)) if (a !== b) units.add(a + b);
  return [...units].slice(0, 72);
}

const SCREEN_REPEATS = [8, 16, 24, 32, 48];

export function growthProbeInputs(source        , extraUnits           = [])           {
  const out           = [];
  for (const unit of [...new Set([...growthUnits(source), ...extraUnits])]) {
    if (!unit) continue;
    for (const repeats of SCREEN_REPEATS) for (const term of GROWTH_TERMINATORS) out.push(unit.repeat(repeats) + term);
  }
  return out;
}

export function millis(re        , input        )         {
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  re.lastIndex = 0;
  try {
    re.test(input);
  } catch {
    return elapsed();
  }
  return elapsed();
}

function minMillis(re        , input        , samples = 3)         {
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, millis(re, input));
  return best;
}

export function probeBacktracking(re        , budgetMs = PROBE_BUDGET_MS)                 {
  for (const unit of PROBE_UNITS) {
    for (const repeats of PROBE_REPEATS) {
      const ms = millis(re, unit.repeat(repeats) + ' !');
      if (ms > budgetMs) return { safe: false, worst: { unit, repeats, ms: Math.round(ms) } };
    }
  }

  const grew = growsSuperLinearly(re, re.source);
  return grew ? { safe: false, worst: grew } : { safe: true };
}

export function growsSuperLinearly(
  re        ,
  source        ,
  extraUnits           = [],
)                                                       {
  for (const unit of [...new Set([...growthUnits(source), ...extraUnits])]) {
    if (!unit) continue;
    for (const term of GROWTH_TERMINATORS) {
      const smallN = Math.ceil(GROWTH_SMALL / unit.length);
      const largeN = Math.ceil(GROWTH_LARGE / unit.length);
      const small = millis(re, unit.repeat(smallN) + term);
      const large = millis(re, unit.repeat(largeN) + term);
      const ratio = large / Math.max(small, 0.02);
      if (ratio <= GROWTH_RATIO) continue;
      const smallMin = minMillis(re, unit.repeat(smallN) + term);
      const largeMin = minMillis(re, unit.repeat(largeN) + term);
      if (largeMin / Math.max(smallMin, 0.02) <= GROWTH_RATIO) continue;
      if (largeMin >= GROWTH_FLOOR_MS) return { unit, repeats: largeN, ms: Math.round(largeMin) };
      const hugeN = Math.ceil((GROWTH_LARGE * 4) / unit.length);
      const huge = minMillis(re, unit.repeat(hugeN) + term);
      if (huge >= HUGE_COST_MS) return { unit, repeats: hugeN, ms: Math.round(huge) };
    }
  }
  return null;
}

export function sanitizeFlags(flags     , fallback = '')         {
  const s = String(flags ?? fallback).replace(/[^gims]/g, '');
  return [...new Set(s)].join('');
}


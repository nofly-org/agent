import { installTargets } from './install-lab.mjs';
import { localPackageVerdict, packageVerdictSeverity, packageVerdictTitle } from './package-verdict.mjs';

export function installFindings(command) {
  const out = [];
  for (const t of installTargets(command)) {
    const v = localPackageVerdict(t.name, t.version, t.ecosystem);
    if (v) out.push({ label: packageVerdictTitle(v), severity: packageVerdictSeverity(v), category: 'supply', detail: v.detail });
  }
  return out;
}

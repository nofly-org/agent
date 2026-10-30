import { SEV_COLOR, VERDICT_COLOR, bold, dim, gray, green, red, yellow } from '../core/terminal.mjs';

const DECISIONS = new Set(['ALLOW', 'FLAG', 'BLOCK']);

export function isGateVerdict(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && DECISIONS.has(v.decision)
    && (v.findings === undefined || Array.isArray(v.findings));
}

export const severityColor = (severity) => SEV_COLOR[String(severity ?? '').toUpperCase()] ?? gray;

export const REWORDING_NOT_RUN = {
  check: 'reworded-instructions',
  why: 'Instructions reworded to slip past the rules. The AI and model checks that catch those run on your NoFly server, and this verdict came from the on-machine rules only.',
  enabledBy: 'Run it again with a reachable NoFly server (nofly init --key shm_… --url <backend>) to add them.',
};

export function localAsGateResult(local, name, kind) {
  return {
    decision: local.verdict,
    name: name || 'artifact',
    kind: kind || 'auto',
    riskScore: local.riskScore,
    findingCount: local.findings.length,
    findings: local.findings.map((f) => ({ severity: f.severity, title: f.title, remediationText: f.remediationText, ...(f.line ? { line: f.line } : {}) })),
    notAttempted: [REWORDING_NOT_RUN],
  };
}

export function printGateResult(res, source, flags) {
  if (flags.json) {
    console.log(JSON.stringify({ source, ...res }, null, 2));
    return;
  }
  const dc = res.decision === 'BLOCK' ? red : res.decision === 'FLAG' ? yellow : green;
  console.log(dc(res.decision) + (source === 'local' ? dim('  (on-machine)') : ''));
  console.log(`\n  ${dc('●')} ${bold(res.name)} ${dim(`${res.kind} · risk ${res.riskScore}/100 · ${res.findingCount ?? (res.findings || []).length} finding(s)`)}`);
  for (const f of res.findings || []) {
    console.log(`     ${severityColor(f.severity)(String(f.severity ?? 'INFO').toUpperCase().padEnd(8))} ${f.title}`);
    if (f.remediationText) console.log(`     ${dim('fix: ' + f.remediationText)}`);
  }
  for (const c of res.catalog || []) {
    const vc = VERDICT_COLOR[c.verdict] || gray;
    console.log(`     ${dim('catalog:')} ${c.name} ${vc(c.verdict ?? 'UNSCANNED')} ${dim('risk ' + c.riskScore)}`);
  }
  for (const p of res.policyHits || []) {

    const note = p.suppressed ? dim('  (not enforced - accepted risk / ignored in your org)') : '';
    console.log(`     ${dim('policy:')} ${p.policy} ${dim('→')} ${p.action}${note}`);
  }
  const triaged = (res.policyHits || []).filter((p) => p.suppressed).length;
  if (triaged) console.log(`     ${dim(`${triaged} policy hit(s) suppressed by triage - reopen or let the acceptance expire to re-enforce.`)}`);
  const orgNote = source === 'local' ? dim(' (on-machine analysis; org policy not applied)') : '';

  const sev = (res.findings || []).reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {});
  const highish = (sev.CRITICAL || 0) + (sev.HIGH || 0);
  const highNote = highish
    ? `${sev.CRITICAL || 0} critical · ${sev.HIGH || 0} high still present - allowed by your org policy, not by the analysis.`
    : 'No high-risk findings.';
  if (res.decision === 'BLOCK') console.log(`\n  ${red('✗ Blocked.')}${orgNote} ${dim('Review the findings above.')}\n`);
  else if (res.decision === 'FLAG') console.log(`\n  ${yellow('⚠ Flagged.')}${orgNote} ${dim('Proceed with caution.')}\n`);
  else if (highish) console.log(`\n  ${green('✓ Allowed')} ${yellow('by policy.')}${orgNote} ${dim(highNote)}\n`);
  else console.log(`\n  ${green('✓ Allowed.')}${orgNote} ${dim(highNote)}\n`);

  for (const n of res.notAttempted || []) {
    console.log(`  ${yellow('!')} ${bold('Not checked:')} ${n.why}`);
    console.log(`     ${dim(n.enabledBy)}\n`);
  }
}

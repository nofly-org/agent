import path from 'node:path';
import { bold, cyan, dim, gray, yellow } from '../core/terminal.mjs';
import { rollupArtifacts } from '../inventory/agent-artifacts.mjs';

export function printAssets(assets) {
  const extensions = assets.filter((a) => a.metadata?.category === 'ide-extension');
  const rest = assets.filter((a) => a.metadata?.category !== 'ide-extension');
  const byType = {};
  for (const a of rest) byType[a.type] = (byType[a.type] ?? 0) + 1;
  console.log(bold('\n  Discovered AI assets'));
  console.log(
    '  ' +
      Object.entries(byType)
        .map(([t, n]) => `${cyan(n)} ${dim(t.replace('_', ' ').toLowerCase())}`)
        .join(dim('  ·  ')),
  );
  for (const a of rest) {
    console.log(`  ${gray('•')} ${bold(a.name)} ${dim(a.type)} ${a.vendor ? gray('(' + a.vendor + ')') : ''}`);
    if (a.identifier && a.identifier !== a.name) console.log(`      ${dim(a.identifier)}`);
  }
  printExtensions(extensions);
}

const SENSITIVE_READS = new Set(['credential-files', 'auth-sessions', 'clipboard', 'terminal']);

function printExtensions(extensions) {
  if (!extensions.length) return;
  const editors = {};
  for (const a of extensions) editors[a.metadata.editor] = (editors[a.metadata.editor] ?? 0) + 1;
  console.log(bold('\n  Editor extensions'));
  console.log('  ' + Object.entries(editors).map(([e, n]) => `${cyan(n)} ${dim(e)}`).join(dim('  ·  ')));
  const notable = extensions.filter((a) => (a.metadata.reads ?? []).some((r) => SENSITIVE_READS.has(r)));
  for (const a of notable) {
    const m = a.metadata;
    const reads = (m.reads ?? []).filter((r) => SENSITIVE_READS.has(r)).join(', ');
    const hosts = (m.hosts ?? []).length;
    console.log(`  ${gray('•')} ${bold(a.name)} ${dim(m.editor)} ${yellow('reads ' + reads)}${hosts ? dim(` · names ${hosts} host${hosts === 1 ? '' : 's'}${m.hostsTruncated ? '+' : ''}`) : ''}${m.activation === 'always' ? dim(' · always on') : ''}`);
  }
  const unread = extensions.filter((a) => a.metadata.bundleRead === 'skipped' || a.metadata.bundleRead === 'unread').length;
  if (unread) console.log(`  ${yellow('⚠')} ${dim(`${unread} extension(s) were listed but their code was NOT read (scan budget or unreadable) - not the same as clean.`)}`);
}

export function printArtifacts(artifacts, capped = [], available = []) {
  if (!artifacts.length && !capped.length && !available.length) return;
  const by = rollupArtifacts(artifacts);
  console.log(bold('\n  Installed agent artifacts'));
  console.log(
    '  ' +
      (Object.keys(by).length
        ? Object.entries(by)
            .map(([k, n]) => `${cyan(n)} ${dim(k + (n === 1 ? '' : 's'))}`)
            .join(dim('  ·  '))
        : dim('none found')),
  );
  for (const a of artifacts) {
    const scope = a.scope === 'user' ? yellow('user') : dim('project');
    console.log(`  ${gray('•')} ${bold(a.name)} ${dim(a.kind)} ${scope} ${a.vendor ? gray('(' + a.vendor + ')') : ''}`);
    console.log(`      ${dim(a.path)}`);
    if (a.files?.length) console.log(`      ${dim(a.files.length + ' bundled file(s)')}`);
  }
  if (available.length) {
    const total = available.reduce((n, a) => n + a.count, 0);

    console.log(
      dim(`\n  ${total} more available in ${available.length} checked-out catalogue(s), none enabled:`),
    );
    for (const a of available) console.log(`      ${dim(a.marketplace)} ${gray(a.count)}`);
  }
  if (capped.length) {
    console.log(dim(`\n  Sweep capped (${capped.length}) - this list is a floor, not a total.`));
    const byReason = new Map();
    for (const c of capped) byReason.set(c?.reason, (byReason.get(c?.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`      ${dim(CAP_LABELS[reason] ?? String(reason ?? 'Unknown'))} ${gray(n)}`);
  }
}

const CAP_LABELS = {
  'artifact-cap': 'Artifact Limit Reached',
  'walk-budget': 'Folder Limit Reached',
  'source-cap': 'Source File Limit Reached',
  'byte-budget': 'Size Budget Reached',
  'bundle-cap': 'Bundled File Limit Reached',
  'link-outside': 'Links Leaving Your Home Or Project, Not Followed',
  'link-withheld': 'Links To Key Or Credential Files, Not Read',
  'source-failed': 'Discovery Step Failed',
  'manifest-too-large': 'Manifest Too Large To Read',
  'parse-failed': 'File Could Not Be Parsed',
  oversized: 'File Too Large To Read',
  'sqlite-unavailable': 'Database Reader Unavailable',
};

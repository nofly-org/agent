import fs from 'node:fs';
import path from 'node:path';
import { readRegularFile } from '../artifacts/matchers.mjs';
import { api } from '../core/api-client.mjs';
import { writeFileAtomic } from '../core/json-file.mjs';
import { loadConfig, resolveSettings } from '../core/config.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { SEV_COLOR, bold, cyan, dim, green, red, yellow } from '../core/terminal.mjs';
import { GATE_KINDS } from '../gate/environment.mjs';

export async function cmdFix(flags, positional) {
  const file = positional[0];
  if (!file) {
    console.error(red('✗') + ' Usage: ' + bold('shomra fix <file> [--apply] [--kind mcp|skill|command|subagent|hook|rules] [--json]'));
    process.exit(EXIT_USAGE);
  }
  const cfg = loadConfig();
  const { apiKey, url } = resolveSettings(cfg);
  if (!apiKey) {
    console.error('\n' + red('✗') + ' ' + bold('shomra fix') + ' needs enrollment - the fix is generated on the platform with your org AI key.');
    console.error('  ' + dim('Run ') + bold('shomra init --key shm_live_…') + dim(', or apply the guidance from ') + bold('shomra check') + dim(' by hand.\n'));
    process.exit(EXIT_USAGE);
  }
  let target = path.resolve(String(file));
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const skillMd = path.join(target, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      console.error(red('✗') + ` ${file} is a directory with no SKILL.md - point at a file instead.`);
      process.exit(EXIT_USAGE);
    }
    target = skillMd;
  }
  if (!fs.existsSync(target)) {
    console.error(red('✗') + ` File not found: ${file}`);
    process.exit(EXIT_USAGE);
  }
  const result = await fixOneFile(target, { apiKey, url, flags });
  if (result === false && fixFailed.has(target)) process.exitCode = 1;
}

const fixFailed = new Set();

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function fixOneFile(target, { apiKey, url, flags }) {
  const rel = path.relative(process.cwd(), target).split(path.sep).join('/');
  const say = flags.silent ? () => {} : (line) => console.log(line);
  const fail = (line) => {
    fixFailed.add(target);
    if (!flags.json && !flags.silent) console.error(line);
    return false;
  };
  if (isSymlink(target)) return fail(`  ${red('✗')} ${rel} is a symlink - Shomra will not write a fix through it. Fix the file it points at directly.`);
  const read = readRegularFile(target);
  if (read.skip) return fail(`  ${red('✗')} cannot read ${rel}: ${read.skip}`);
  const { content } = read;
  const kind = flags.kind && GATE_KINDS.includes(String(flags.kind)) ? String(flags.kind) : undefined;

  let res;
  try {
    if (!flags.json && !flags.quiet && !flags.silent) process.stdout.write(dim(`  Generating fix for ${rel}… `));
    res = await api(url, apiKey, '/gate/fix', {
      ...(kind ? { kind } : {}),
      path: rel,
      name: rel.split('/').pop(),
      content,
    });
    if (!flags.json && !flags.quiet && !flags.silent) console.log('');
  } catch (e) {
    if (flags.json && !flags.silent) console.log(JSON.stringify({ path: rel, canFix: false, error: e.message }, null, 2));
    return fail(`  ${red('✗')} ${e.message}`);
  }
  if (!res || typeof res !== 'object') return fail(`  ${red('✗')} the backend answered without a fix for ${rel}`);

  if (flags.json && !flags.silent) console.log(JSON.stringify({ path: rel, ...res }, null, 2));

  if (!res.canFix) {
    if (!flags.json && !flags.silent) {
      if (res.reason === 'clean') console.log(`  ${green('✓')} ${dim(rel + ' - nothing to fix.')}`);
      else if (res.reason === 'ai-disabled') {
        console.log(`  ${yellow('⚠')} ${res.message}`);
        for (const g of res.guidance || []) {
          console.log(`     ${SEV_COLOR[g.severity](String(g.severity).padEnd(8))} ${g.title}`);
          if (g.remediationText) console.log(`     ${dim('fix: ' + g.remediationText)}`);
        }
        console.log('');
      } else console.log(`  ${yellow('⚠')} ${dim(rel + ' - ')}${res.message || 'no fix produced.'}`);
    }
    return false;
  }

  if (!flags.json && !flags.silent) {
    printDiff(res.diff);
    if (res.explanation) console.log(`  ${dim(res.explanation)}`);
    const conf = res.confidence != null ? `  ${dim('confidence ' + Math.round(res.confidence * 100) + '%')}` : '';
    if (conf) console.log(conf);
    console.log('');
  }

  const apply = flags.apply || flags.write || flags.yes;
  if (!apply) {
    if (!flags.json) say(`  ${dim('Preview only - re-run with')} ${bold('--apply')} ${dim('to write this fix to ' + rel + '.')}\n`);
    return true;
  }
  if (typeof res.fixedContent !== 'string') return fail(`  ${red('✗')} the backend sent no fixed content for ${rel} - nothing was written`);
  try {
    writeFileAtomic(target, res.fixedContent);
    if (!flags.json && !flags.quiet) {
      say(`  ${green('✓ Applied')} ${dim('→ ' + rel + '  (' + (res.findingCount || (res.findings || []).length) + ' finding(s) addressed)')}\n`);
    }
    return true;
  } catch (e) {
    return fail(`  ${red('✗')} could not write ${rel}: ${e.message}`);
  }
}

export function fixDidFail(target) {
  return fixFailed.has(target);
}

function printDiff(diff) {
  if (!diff) return;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) console.log('  ' + green(line));
    else if (line.startsWith('-') && !line.startsWith('---')) console.log('  ' + red(line));
    else if (line.startsWith('@@')) console.log('  ' + cyan(line));
    else console.log('  ' + dim(line));
  }
}

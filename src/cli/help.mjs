import { HELP_SECTIONS } from './help-sections.mjs';
import { bold, cyan, dim } from '../core/terminal.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;

function commandLines(full, command) {
  const lines = full.split('\n');
  const at = lines.findIndex((line) => line.replace(ANSI, '').startsWith(`  ${command} `));
  if (at === -1) return null;
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i++) {
    const plain = lines[i].replace(ANSI, '');
    if (!/^ {6,}\S/.test(plain)) break;
    out.push(lines[i]);
  }
  return out;
}

export function cmdHelp(command) {
  const full = HELP_SECTIONS.map((section) => section()).join('\n');
  const lines = command ? commandLines(full, command) : null;
  if (!lines) {
    console.log(full);
    return;
  }
  console.log(`\n${lines.join('\n')}\n\n  ${dim('Every command and option:')} ${bold('shomra help')}\n`);
}

export function cmdAdminHelp() {
  console.log(`
${bold(cyan('shomra admin'))} ${dim('- governance & advanced security operations')}

  ${dim('Deep scans (backend + key)')}
  ${cyan('scan-zip')}      Static-scan a workspace ZIP            ${dim('<file.zip> [--project <id>] [--json]')}
  ${cyan('model-scan')}    SAST-scan a public AI model            ${dim('<hf-url | owner/model | github-url> [--project <id>] [--json]')}
  ${cyan('memory-scan')}   Scan memory + rules files for poisoning ${dim('[path] [--machine] [--scope …] [--writer …] [--json]')}
  ${cyan('memory-restore')} Write back memory files an operator rolled back in Shomra

  ${dim('Offense & runtime identity')}
  ${cyan('redteam')}       Continuously red-team your guardrails  ${dim('[--target llm-guard|model] [--evolve] [--min 80] [--fail-on-regression] [--json]')}
  ${cyan('campaign')}      Autonomous multi-turn adversary run    ${dim('[--objectives exfil-canary,tool-abuse] [--turns 6] [--min 80] [--json]')}
  ${cyan('harden')}        Auto-fix what the red-team breached     ${dim('[--run <id>] [--target llm-guard|model] [--apply] [--json]')}
  ${cyan('agent-identity')} Register a non-human agent identity    ${dim('register --name "…" --type coding-agent [--purpose "…"] [--owner <email>] [--for claude] [--workload github] [--json]')}
  ${cyan('llm-proxy')}     Guardrail live LLM traffic             ${dim('[--port 4141] [--project <id>] [--agent-id <handle>]')}

  ${dim('Fleet rollout')}
  ${cyan('mdm-script')}    Print a Jamf/Intune/Kandji bootstrap script ${dim('--os macos|windows|linux [--url <url>] [--key <key>] [--every 6h] [--guard]')}
                ${dim('Without --key the script reads SHOMRA_API_KEY from the MDM secret variables.')}

  ${dim('Each also runs as a bare top-level verb (e.g.')} ${dim(bold('shomra redteam'))}${dim(') for back-compat.')}
  ${dim('Full details for any command:')} ${bold('shomra help')}
`);
}

import { HELP_DETAILS, HELP_SECTIONS } from './help-sections.mjs';
import { COMMANDS } from './registry.mjs';
import { didYouMean } from './suggestions.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { bold, cyan, dim, red } from '../core/terminal.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;
const HELP_NAMES = { 'agent-id': 'agent-identity', 'mcp-guard': 'mcp guard' };

function commandLines(text, command) {
  const lines = text.split('\n');
  const out = [];
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].replace(ANSI, '').startsWith(`  ${command} `)) continue;
    out.push(lines[at]);
    while (at + 1 < lines.length && /^ {6,}\S/.test(lines[at + 1].replace(ANSI, ''))) out.push(lines[++at]);
  }
  return out.length ? out : null;
}

function findLines(name, sub) {
  for (const text of [HELP_SECTIONS.map((section) => section()).join('\n'), adminHelpText()]) {
    const lines = (sub && commandLines(text, `${name} ${sub}`)) || commandLines(text, name);
    if (lines) return lines;
  }
  return null;
}

function printCommand(name, lines) {
  const detail = HELP_DETAILS[name];
  console.log(`\n${lines.join('\n')}\n${detail ? `\n${detail()}` : ''}\n  ${dim('Every command and option:')} ${bold('nofly help')}\n`);
}

export function cmdHelp(command, sub) {
  if (command === 'admin') return cmdAdminHelp(sub);
  const name = command ? HELP_NAMES[command] ?? command : null;
  const lines = name && command !== 'help' ? findLines(name, sub) : null;
  if (lines) return printCommand(name, lines);
  if (name && !COMMANDS[command] && !['help', 'version'].includes(command)) {
    const near = didYouMean(command, [...Object.keys(COMMANDS), 'help', 'version', 'admin']);
    console.error(red(`✗ Unknown command: ${command}`) + (near ? `  did you mean ${bold(near)}?` : ''));
    console.error(dim('Run `nofly help` for the full command list.'));
    process.exitCode = EXIT_USAGE;
    return;
  }
  console.log(HELP_SECTIONS.map((section) => section()).join('\n'));
}

function adminHelpText() {
  return `
${bold(cyan('nofly admin'))} ${dim('- governance & advanced security operations')}

  ${dim('Deep scans (backend + key)')}
  ${cyan('scan-zip')}      Static-scan a workspace ZIP            ${dim('<file.zip> [--project <id>] [--json]')}
  ${cyan('model-scan')}    SAST-scan a public AI model            ${dim('<hf-url | owner/model | github-url> [--project <id>] [--json]')}
  ${cyan('memory-scan')}   Scan memory + rules files for poisoning ${dim('[path] [--machine] [--scope …] [--writer …] [--json]')}
  ${cyan('memory-restore')} Write back memory files an operator rolled back in NoFly

  ${dim('Offense & runtime identity')}
  ${cyan('redteam')}       Continuously red-team your guardrails  ${dim('[--target llm-guard|model] [--evolve] [--min 80] [--fail-on-regression] [--json]')}
  ${cyan('campaign')}      Autonomous multi-turn adversary run    ${dim('[--objectives exfil-canary,tool-abuse] [--turns 6] [--min 80] [--json]')}
  ${cyan('harden')}        Auto-fix what the red-team breached     ${dim('[--run <id>] [--target llm-guard|model] [--apply] [--json]')}
  ${cyan('agent-identity')} Register a non-human agent identity    ${dim('register --name "…" --type coding-agent [--purpose "…"] [--owner <email>] [--for claude] [--workload github] [--json]')}
  ${cyan('llm-proxy')}     Guardrail live LLM traffic             ${dim('[--port 4141] [--project <id>] [--agent-id <handle>]')}

  ${dim('Fleet rollout')}
  ${cyan('mdm-script')}    Print a Jamf/Intune/Kandji bootstrap script ${dim('--os macos|windows|linux [--url <url>] [--key <key>] [--every 6h] [--guard]')}
                ${dim('Without --key the script reads NOFLY_API_KEY from the MDM secret variables.')}

  ${dim('Each also runs as a bare top-level verb (e.g.')} ${dim(bold('nofly redteam'))}${dim(') for back-compat.')}
  ${dim('Details for one command:')} ${bold('nofly admin <command> --help')}${dim(' · every command:')} ${bold('nofly help')}
`;
}

export function cmdAdminHelp(command) {
  const name = command ? HELP_NAMES[command] ?? command : null;
  const lines = name ? commandLines(adminHelpText(), name) : null;
  if (lines) return printCommand(name, lines);
  console.log(adminHelpText());
}

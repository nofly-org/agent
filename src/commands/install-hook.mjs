import { AGENT_INSTALLERS, AGENT_KEYS, AGENT_LABELS, AGENT_UNINSTALLERS } from '../agents/installers.mjs';
import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { bold, dim, green, red, yellow } from '../core/terminal.mjs';
import { PROMPT_HOOK_AGENTS } from '../guard/prompt-guard.mjs';

function requestedAgents(flags, fallback) {
  const requested = flags.agent
    ? String(flags.agent).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
    : [fallback];
  const unknown = requested.filter((a) => a !== 'all' && !AGENT_KEYS.includes(a));
  if (unknown.length) {
    console.error(red('✗') + ` Unknown agent(s): ${unknown.join(', ')}. Supported: ${AGENT_KEYS.join(', ')}, all.`);
    process.exit(EXIT_USAGE);
  }
  return requested.includes('all') ? AGENT_KEYS : requested;
}

function uninstallHooks(flags) {
  const global = !!flags.global;
  const targets = requestedAgents(flags, 'all');
  let removed = 0;
  let failed = 0;
  for (const agent of targets) {
    try {
      const result = AGENT_UNINSTALLERS[agent](global);
      if (result.changed) {
        removed += result.removed;
        console.log(green('✓') + ` Removed the Shomra runtime firewall for ${bold(AGENT_LABELS[agent])} from ${bold(result.file)}`);
      } else if (flags.agent) {
        console.log(dim(`  • No Shomra hook for ${AGENT_LABELS[agent]} in ${result.file}`));
      }
    } catch (error) {
      failed++;
      console.error(red('✗') + ` ${AGENT_LABELS[agent]}: ${error.message}`);
    }
  }
  if (!removed && !failed) console.log(dim(`  No Shomra hooks found ${global ? 'in your user settings' : 'in this repo'}${global ? '' : ' (use --global for your user settings)'}.`));
  else if (removed) console.log(dim('\n  Restart the agent to pick up the change. Your own hooks and settings were left as they were.'));
  if (failed) process.exitCode = 1;
}

export function cmdInstallHook(flags) {
  if (flags.uninstall) return uninstallHooks(flags);
  const global = !!flags.global;
  const targets = requestedAgents(flags, 'claude');
  if (!flags.agent) {
    console.log(dim('  No --agent given - installing for Claude Code only. Use ') + bold('--agent all') + dim(' (or ') + bold('shomra protect') + dim(') to cover every agent.'));
  }

  let failed = 0;
  for (const agent of targets) {
    let result;
    try {
      result = AGENT_INSTALLERS[agent](global);
    } catch (error) {
      failed++;
      console.error(red('✗') + ` Could not install for ${AGENT_LABELS[agent]}: ${error.message}`);
      continue;
    }
    const { file, changed } = result;
    if (changed) {
      console.log(green('✓') + ` Installed the Shomra runtime firewall for ${bold(AGENT_LABELS[agent])} → ${bold(file)}`);
    } else {
      console.log(yellow('•') + ` Shomra runtime firewall already installed for ${AGENT_LABELS[agent]} in ${bold(file)}`);
    }
    if (result.note) console.log(dim(`    Note: ${result.note}`));
    if (agent === 'windsurf') {
      console.log(dim('    Note: Windsurf\'s post-hooks can flag/log but not withhold a tool result.'));
    }
    if (agent === 'aider') {
      console.log(dim('    Note: Aider has no tool hook - this routes its model calls through the'));
      console.log(dim('          Shomra LLM Guard proxy. Start it with ') + 'shomra llm-proxy' + dim(' and set your API key.'));
    }
  }
  if (failed) process.exitCode = 1;
  if (failed === targets.length) return;
  console.log(dim('\n  PreToolUse:  screens every shell command, artifact write, and MCP call BEFORE it runs -'));
  console.log(dim('               and vets AI model loads the agent writes (from_pretrained / hf_hub /'));
  console.log(dim('               torch.hub …) against the Shomra Model Index, so a known-vulnerable model'));
  console.log(dim('               is flagged with its fix BEFORE the load lands. (SHOMRA_MODEL_GUARD=0 to silence.)'));
  console.log(dim('  PostToolUse: screens content fetched pages / file reads / MCP responses bring BACK'));
  console.log(dim('               into the agent context - prompt injection, exfil sinks, hidden payloads.'));
  if (targets.some((a) => PROMPT_HOOK_AGENTS.has(a))) {
    console.log(dim('  Prompt:      screens what YOU submit before it leaves the machine - a pasted live'));
    console.log(dim('               credential is refused; pasted injection text is flagged to the model as'));
    console.log(dim('               untrusted data. (SHOMRA_PROMPT_GUARD_OFF=1 to disable just this one.)'));
  }
  console.log(dim('  Blocked calls/results are refused with a reason; every decision lands in Shomra → Gate Activity.'));
  console.log(dim('  Dangerous calls (curl|sh, reverse shells, secrets, injection) are blocked ON-MACHINE with'));
  console.log(dim('  no network; only policy-relevant calls escalate to the backend, so a slow/down backend'));
  console.log(dim('  never freezes the agent. Tip: ') + 'SHOMRA_GUARD_STRICT=1' + dim(' also fails-closed on the server tier.'));
  console.log(dim('  Remove it again with ') + bold(`shomra install-hook --uninstall${global ? ' --global' : ''}`) + dim('.'));
}

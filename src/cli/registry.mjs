const lazy = (load, name, call = (fn, f, p) => fn(f, p)) => async (f, p) => call((await load())[name], f, p);

const guardCommand = (load, name, refuse, what) => async (f) => {
  const [mod, { strictOnCrash }, emit] = await Promise.all([load(), import('../guard/crash.mjs'), import('../guard/emit.mjs')]);
  return strictOnCrash(mod[name], emit[refuse], what)(f);
};

export const COMMANDS = {
  init: lazy(() => import('../commands/init.mjs'), 'cmdInit', (fn, f) => fn(f)),
  scan: lazy(() => import('../commands/scan.mjs'), 'cmdScan', (fn, f) => fn(f)),
  report: lazy(() => import('../commands/scan.mjs'), 'cmdScan', (fn, f) => fn({ ...f, report: true })),
  schedule: lazy(() => import('../commands/schedule.mjs'), 'cmdSchedule'),
  'mdm-script': lazy(() => import('../commands/mdm-script.mjs'), 'cmdMdmScript', (fn, f) => fn(f)),
  gate: lazy(() => import('../commands/gate.mjs'), 'cmdGate'),
  run: lazy(() => import('../commands/run.mjs'), 'cmdRun'),
  check: lazy(() => import('../commands/check.mjs'), 'cmdCheck'),
  pr: lazy(() => import('../commands/pr.mjs'), 'cmdPr'),
  baseline: lazy(() => import('../commands/check.mjs'), 'cmdBaseline'),
  fix: lazy(() => import('../commands/fix.mjs'), 'cmdFix'),
  why: lazy(() => import('../commands/why.mjs'), 'cmdWhy'),
  provenance: lazy(() => import('../commands/provenance.mjs'), 'cmdProvenance'),
  'install-precommit': lazy(() => import('../commands/git-hooks.mjs'), 'cmdInstallPrecommit'),
  'scan-zip': lazy(() => import('../commands/scan-zip.mjs'), 'cmdScanZip'),
  'model-scan': lazy(() => import('../commands/model-scan.mjs'), 'cmdModelScan'),
  models: lazy(() => import('../commands/models.mjs'), 'cmdModels'),
  'memory-scan': lazy(() => import('../commands/memory-scan.mjs'), 'cmdMemoryScan'),
  'memory-restore': lazy(() => import('../guard/memory-restore.mjs'), 'cmdMemoryRestore', (fn) => fn()),
  redteam: lazy(() => import('../commands/redteam.mjs'), 'cmdRedteam', (fn, f) => fn(f)),
  campaign: lazy(() => import('../commands/redteam.mjs'), 'cmdCampaign', (fn, f) => fn(f)),
  harden: lazy(() => import('../commands/redteam.mjs'), 'cmdHarden', (fn, f) => fn(f)),
  'agent-identity': lazy(() => import('../commands/agent-identity.mjs'), 'cmdAgentIdentity'),
  'agent-id': lazy(() => import('../commands/agent-identity.mjs'), 'cmdAgentIdentity'),
  'llm-proxy': lazy(() => import('../commands/llm-proxy.mjs'), 'cmdLlmProxy', (fn, f) => fn(f)),
  'tool-guard': guardCommand(() => import('../guard/tool-guard.mjs'), 'cmdToolGuard', 'emitGuardDeny', 'guard'),
  'mcp-guard': lazy(() => import('../commands/mcp.mjs'), 'cmdMcpGuard'),
  'result-guard': guardCommand(() => import('../guard/result-guard.mjs'), 'cmdResultGuard', 'emitResultBlock', 'result-guard'),
  'prompt-guard': lazy(() => import('../guard/prompt-guard.mjs'), 'cmdPromptGuard', (fn, f) => fn(f)),
  'plan-guard': lazy(() => import('../commands/plan.mjs'), 'cmdPlanGuard', (fn, f) => fn(f)),
  'session-guard': lazy(() => import('../guard/session-guard.mjs'), 'cmdSessionGuard', (fn, f) => fn(f)),
  plan: lazy(() => import('../commands/plan.mjs'), 'cmdPlan'),
  corpus: lazy(() => import('../commands/corpus.mjs'), 'cmdCorpus'),
  rules: lazy(() => import('../commands/rules.mjs'), 'cmdRules'),
  design: lazy(() => import('../commands/design.mjs'), 'cmdDesign'),
  add: lazy(() => import('../commands/add.mjs'), 'cmdAdd'),
  'install-hook': lazy(() => import('../commands/install-hook.mjs'), 'cmdInstallHook', (fn, f) => fn(f)),
  selftest: lazy(() => import('../commands/selftest.mjs'), 'cmdSelftest', (fn, f) => fn(f)),
  protect: lazy(() => import('../commands/protect.mjs'), 'cmdProtect', (fn, f) => fn(f)),
  ledger: lazy(() => import('../commands/ledger.mjs'), 'cmdLedger', (fn, f) => fn(f)),
  doctor: lazy(() => import('../commands/doctor.mjs'), 'cmdDoctor', (fn, f) => fn(f)),
  new: lazy(() => import('../commands/new.mjs'), 'cmdNew'),
  mcp: lazy(() => import('../commands/mcp.mjs'), 'cmdMcp'),
  secrets: lazy(() => import('../commands/secrets.mjs'), 'cmdSecrets'),
  status: lazy(() => import('../commands/status.mjs'), 'cmdStatus', (fn) => fn()),
};

export const ADMIN_VERBS = new Set([
  'scan-zip', 'model-scan', 'memory-scan',
  'redteam', 'campaign', 'harden',
  'agent-identity', 'agent-id', 'llm-proxy',
  'mdm-script',
]);

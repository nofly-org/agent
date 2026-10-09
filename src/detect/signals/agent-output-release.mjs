import { parseYaml } from '../../core/yaml-lite.mjs';
import { locate } from './agentic-shim.mjs';

const MERGE_ACTION_RE = /^(?:pascalgn\/automerge-action|reitermarkus\/automerge|KeisukeYamashita\/auto-pull-request-merge|ridedott\/merge-me-action|plm9606\/automerge_actions|actions-cool\/merge-pr|sudo-bot\/action-pull-request-merge)@/i;
const AUTO_MERGE_ACTION_RE = /^(?:peter-evans\/enable-pull-request-automerge|alexwilson\/enable-github-automerge-action)@/i;
const APPROVE_ACTION_RE = /^(?:hmarr\/auto-approve-action|juliangruber\/approve-pull-request-action|andrewmusgrave\/automatic-pull-request-review)@/i;
const PUSH_ACTION_RE = /^(?:stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|ad-m\/github-push-action)@/i;

const GH_MERGE_RE = /\bgh\s+pr\s+merge\b[^\n;&|]*/;
const GH_APPROVE_RE = /\bgh\s+pr\s+review\b[^\n;&|]*?(?:--approve\b|\s-a\b)/;
const API_MERGE_RE = /\bpulls\.merge\s*\(|\/pulls\/\S{1,80}\/merge\b|\benablePullRequestAutoMerge\b|\bmergePullRequest\b/;
const API_APPROVE_RE = /["']?\bevent["']?\s*:\s*["']APPROVE["']|-[fF]\s+event=APPROVE\b/;
const PUSH_DEFAULT_RE = /\bgit\s+push\b[^\n;&|]*?[\s:](?:main|master|trunk|\$\{\{\s*github\.event\.repository\.default_branch\s*\}\})(?=\s|$|;|&|\|)/m;
const DEPLOY_RE =
  /\b(?:vercel\b[^\n]{0,80}--prod\b|netlify\s+deploy\b[^\n]{0,80}--prod\b|fly(?:ctl)?\s+deploy\b|firebase\s+deploy\b|(?:npm|pnpm)\s+publish\b|yarn\s+(?:npm\s+)?publish\b|twine\s+upload\b|cargo\s+publish\b|gh\s+release\s+create\b|kubectl\s+apply\b|helm\s+(?:upgrade|install)\b|terraform\s+apply\b[^\n]{0,80}-auto-approve\b|gcloud\s+(?:app|run|functions)\s+deploy\b|az\s+webapp\s+deploy\b|(?:serverless|sls)\s+deploy\b|wrangler\s+(?:deploy|publish)\b)/;

const REVIEWED_RE = /\breview\.state\s*==\s*['"]approved['"]|\breviewDecision\s*==\s*['"]APPROVED['"]/i;
const BOT_AUTHOR_RE = /\b(?:github\.actor|github\.event\.pull_request\.user\.login|github\.triggering_actor)\s*==\s*['"](?:dependabot\[bot\]|renovate\[bot\]|dependabot-preview\[bot\])['"]/i;
const PR_TRIGGERS = new Set(['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment']);

const obj = (v         )                             => (v && typeof v === 'object' && !Array.isArray(v) ? (v                       ) : null);

function jobShapes(src        )                        {
  const out = new Map                  ();
  let doc                             = null;
  try {
    doc = obj(parseYaml(src));
  } catch {
    return out;
  }
  for (const [id, raw] of Object.entries(obj(doc?.jobs) ?? {}).slice(0, 100)) {
    const job = obj(raw);
    if (!job) continue;
    const needs = Array.isArray(job.needs) ? job.needs.map(String) : typeof job.needs === 'string' ? [job.needs] : [];
    out.set(id, { needs, environment: job.environment != null && job.environment !== '' });
  }
  return out;
}

function downstream(shapes                       , from        )              {
  const out = new Set        ([from]);
  for (let changed = true, n = 0; changed && n < 100; n++) {
    changed = false;
    for (const [id, s] of shapes) {
      if (!out.has(id) && s.needs.some((d) => out.has(d))) {
        out.add(id);
        changed = true;
      }
    }
  }
  return out;
}

function releaseOf(step        , job       , pushIsDefault         )                 {
  const uses = step.uses ?? '';
  const code = [step.run ?? '', step.with.script ?? ''].join('\n');
  const at = (kind             , needle        )          => ({ kind, step, job, needle });
  if (MERGE_ACTION_RE.test(uses)) return at('merge', uses);
  if (AUTO_MERGE_ACTION_RE.test(uses)) return at('auto-merge', uses);
  if (APPROVE_ACTION_RE.test(uses)) return at('approve', uses);
  if (PUSH_ACTION_RE.test(uses)) {
    const branch = (step.with.branch ?? '').trim();
    if (/^(?:main|master|trunk)$/.test(branch) || (!branch && pushIsDefault)) return at('push-default', uses);
  }
  const approve = code.match(GH_APPROVE_RE) ?? code.match(API_APPROVE_RE);
  if (approve) return at('approve', approve[0]);
  const merge = code.match(GH_MERGE_RE);
  if (merge) return at(/--auto\b/.test(merge[0]) && !/--admin\b/.test(merge[0]) ? 'auto-merge' : 'merge', merge[0]);
  const api = code.match(API_MERGE_RE);
  if (api) return at(/AutoMerge/.test(api[0]) ? 'auto-merge' : 'merge', api[0]);
  const push = code.match(PUSH_DEFAULT_RE);
  if (push) return at('push-default', push[0]);
  const deploy = code.match(DEPLOY_RE);
  if (deploy) return at('deploy', deploy[0]);
  return null;
}

const DOES                              = {
  merge: 'merges the pull request',
  'auto-merge': 'turns on auto-merge for the pull request',
  approve: 'approves the pull request',
  'push-default': 'pushes straight to the default branch',
  deploy: 'deploys or publishes',
};

const SEVERITY                                         = { merge: 'HIGH', approve: 'HIGH', 'push-default': 'HIGH', 'auto-merge': 'MEDIUM', deploy: 'MEDIUM' };

export function agentReleaseFindings(a                  , wf            )                    {
  if (wf.vendor !== 'github' || !wf.parsed) return [];
  const agents = wf.jobs.flatMap((j) => j.steps.filter((s) => s.ai));
  if (!agents.length) return [];
  const shapes = jobShapes(a.content ?? '');
  const pushIsDefault = !wf.triggers.some((t) => PR_TRIGGERS.has(t));
  const out                    = [];
  const seen = new Set        ();
  for (const agent of agents.slice(0, 20)) {
    const reach = downstream(shapes, agent.job);
    for (const job of wf.jobs) {
      if (!reach.has(job.id)) continue;
      const shape = shapes.get(job.id);
      for (const step of job.steps) {
        if (job.id === agent.job && step.index <= agent.index) continue;
        if (step.ai) continue;
        const release = releaseOf(step, job, pushIsDefault);
        if (!release) continue;
        const gate = [job.if, step.if].filter(Boolean).join(' ');
        if (REVIEWED_RE.test(gate) || BOT_AUTHOR_RE.test(gate) || shape?.environment) continue;
        const key = `${release.kind}|${job.id}|${step.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const agentName = agent.id ?? agent.ai .product;
        out.push({
          class: 'UNSAFE_OUTPUT',
          severity: SEVERITY[release.kind],
          title: `Workflow "${a.name}" ${DOES[release.kind]} after an agent step with no person in between`,
          detail:
            `Agent step "${agentName}" runs in job "${agent.job}", and then step ${step.index + 1} of job "${job.id}" ${DOES[release.kind]} (${release.needle.trim().slice(0, 120)}). ` +
            'Nothing in this file waits for a person: no approved-review condition, no protected environment. Whatever the agent wrote or decided - including what an injected instruction in an issue, a pull request or a fetched page made it write - reaches the branch or production unread.' +
            (release.kind === 'auto-merge' ? ' Auto-merge still waits for branch protection, so this holds only if the branch requires no review; the file cannot say whether it does.' : '') +
            (release.kind === 'approve' ? ' An approval from the workflow token counts toward required reviews when the repository lets GitHub Actions approve pull requests.' : ''),
          remediationText:
            'Let the agent open a pull request and stop there. Require a human review in branch protection, and gate any merge, approval or deploy on an approved review or a protected environment with required reviewers.',
          remediationTier: 1,
          evidence: { agentStep: agentName, agentJob: agent.job, releaseJob: job.id, releaseStep: step.index + 1, release: release.kind, path: a.path, ...locate(release.needle.trim(), a.content) },
        });
      }
    }
  }
  return out;
}


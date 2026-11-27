# @nofly/agent

**Adversarial assurance for AI agents**, as a local-first CLI. NoFly sits inside
your coding agent and CI and blocks dangerous tool calls, shell commands and data
exfiltration *before they run* - on your machine, even offline. It vets AI
artifacts (MCP configs, Skills, slash commands, hooks, rules files) before they
install, finds the MCP servers and models your machine and code use and checks
them for known vulnerabilities, and, when enrolled, attacks your own guardrails to
prove they hold.

[nofly.ai](https://www.nofly.ai) · [GitHub](https://github.com/nofly-org/agent) · Apache-2.0 · zero dependencies, Node ≥ 18

## Install

```bash
npm i -g @nofly/agent          # gives you the `nofly` command
npx @nofly/agent check         # or run it without installing
```

There is no `curl … | sh` installer, deliberately: NoFly's own guard blocks piping
a downloaded script into a shell.

## Quickstart

```bash
# Is my repo safe?
nofly check                           # gate every AI artifact in the repo at once
nofly check --staged                  # only what's git-staged (pre-commit / on save)
nofly check --fix                     # gate, then remediate what isn't clean, in place
nofly gate .mcp.json                  # vet ONE artifact before you install it
nofly fix .mcp.json --apply           # AI-fix one artifact and write it back
nofly why .mcp.json                   # why each finding matters + is it a false positive

# What AI is on this machine and in this code?
nofly scan                            # discover AI tooling on this machine
nofly mcp list                        # every MCP server your agents have installed
nofly mcps                            # MCP servers in agent configs + code, with known vulns
nofly models                          # models the code loads, with known vulns
nofly secrets --history               # leaked keys in the tree and git history
nofly doctor                          # posture of this machine's AI setup

# Vet before anything lands
nofly add mcp @modelcontextprotocol/server-github   # vet an MCP server, skill, model or package
nofly mcp add github npx -y @modelcontextprotocol/server-github   # vet it, then add it to .mcp.json

# Runtime firewall
nofly protect                         # wire the firewall into every coding agent you use
nofly install-hook --agent claude     # ...or into one agent
nofly install-hook --uninstall        # take it out again (your own hooks are kept)
nofly selftest --agent all            # prove the firewall is really in path on THIS machine
nofly rules --write                   # teach the agent what gets blocked, so it never writes it
nofly mcp install                     # let the agent gate its own content BEFORE writing it
nofly mcp guard                       # route local MCP servers through NoFly

# CI and repo hygiene
nofly install-precommit               # block risky staged AI artifacts on git commit
nofly pr --init                       # PR check with inline annotations (GitHub Actions)
nofly baseline                        # accept today's findings; only NEW ones fail

# Threat-model before you build
nofly design docs/rfc.md              # does a design open a path from untrusted input to harm?
nofly plan plan.md                    # the same, on the agent's own plan
nofly corpus ./docs                   # screen RAG documents before they are indexed
nofly new agent triage-bot            # scaffold an agent project that starts compliant

nofly status                          # config + firewall health
nofly help                            # every command and option
```

Every command takes `--json`, and findings carry a **file:line**, so the output
drives editor squiggles and CI annotations directly.

## Local-first

`check`, `gate`, `mcps`, `models`, `secrets` and the runtime firewall all run on
your machine with no account and no telemetry. The one lookup that goes out
without a key is the name and version of each pinned MCP server package, checked
against the public advisory database at [osv.dev](https://osv.dev); pass
`--offline` (or set `NOFLY_OFFLINE=1`) to keep even that on the machine.

Connect to a NoFly org to add your **org policy**, AI fixes, deep scans, the MCP
and Model Security Index and the dashboard:

```bash
nofly init --key nfy_live_… --url https://nofly.your-co.com   # dev machine
```

In CI, set `NOFLY_API_KEY` (a scoped `nfy_ci_` key) and `NOFLY_URL` instead.
Without them, every backend feature falls back to the on-machine result. Secret
values are replaced on the machine by a same-shape stand-in before anything is
sent, so the backend sees that a credential is there, never the credential.

## Runtime firewall

`nofly install-hook` wires NoFly into the hooks each coding agent actually loads -
Claude Code, Codex CLI, GitHub Copilot CLI, Gemini CLI, Cursor, Windsurf, Cline,
Aider and more. Catastrophic calls (`curl | sh`, reverse shells, live secrets,
prompt injection, guard tampering) are blocked on the machine with zero network;
only policy-relevant calls go to your backend, behind a short timeout and a
circuit breaker, so a slow backend never freezes the agent. It fails open by
default; `NOFLY_GUARD_STRICT=1` fails closed.

`sudo nofly install-hook --managed` writes the hooks where a developer cannot
remove them (Claude Code managed settings, `/etc/codex/hooks.json`, Copilot CLI
`policy.d`), and `nofly admin mdm-script --guard` adds that to a Jamf, Intune or
Kandji rollout.

## MCP servers and models

`nofly mcps [dir]` finds MCP servers in every agent config on the machine (Claude,
Cursor, VS Code, Windsurf, Gemini, Codex and more), in the project's configs, and
in source code - `command`/`args` launch specs and remote MCP URLs passed to an
MCP transport, in TypeScript, JavaScript and Python. Each is checked against
NoFly's built-in list of known-vulnerable MCP packages, OSV advisories for pinned
versions, and your MCP Security Index when enrolled. `nofly models` does the same
for the models your code loads. Both exit `1` on a known-vulnerable entry and `2`
on items to review under `--strict`.

## CI

```yaml
name: NoFly AI-artifact gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx @nofly/agent check --strict
        env:
          NOFLY_API_KEY: ${{ secrets.NOFLY_API_KEY }}   # optional - the gate is local-first
          NOFLY_URL: ${{ secrets.NOFLY_URL }}
```

Make it a **required status check** and it becomes the control GitHub.com has no
server-side hook for. `nofly pr --init` writes a workflow that posts a Check Run
with inline annotations on the changed lines; `--sarif` emits SARIF 2.1.0 for
GitHub and GitLab code scanning. On self-hosted Git and GitHub Enterprise,
`nofly install-precommit --pre-receive` refuses the push on the server itself.

## Agent identity

```bash
nofly agent-identity register --name "Dana's Claude Code" --type coding-agent \
  --purpose "Writes and reviews code in the payments repos" --owner dana@acme.com --for claude
```

Each agent gets its own `nfy_agt_` credential and least-privilege policy; the
firewall presents it from the next call. In GitHub Actions, GitLab, Kubernetes,
Entra or Okta the workload registers itself with its own identity token, so no
secret is stored. `nofly status` shows which identity this machine presents.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | clean |
| `1` | hard fail - a BLOCK, a known-vulnerable MCP server or model, a secret |
| `2` | soft fail - a FLAG under `--strict` |
| `3` | usage or config error |

Environment variables, every option and per-command details: `nofly help` and
`nofly <command> --help`.

## License

Apache-2.0 - see [LICENSE](LICENSE).

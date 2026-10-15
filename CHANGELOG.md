# Changelog

All notable changes to `@shomra/agent` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Worth knowing before you upgrade
- **`shomra pr` with no base branch in the checkout now checks every AI
  artifact and trusts no waiver.** It used to fall back to the last commit, so a
  multi-commit pull request could hide a file in an earlier commit. In GitHub
  Actions it first fetches the base commit itself; elsewhere use
  `fetch-depth: 0`.
- **A pull request can no longer excuse its own findings.** `.shomraignore`,
  `.shomra/baseline.json`, `.shomra/policy.yml` and `shomra-ignore` marks are
  read from the base branch in `shomra pr`; a mark the pull request adds applies
  once it is merged, and the check run says so on the finding.
- **Flags are stricter.** `--apply=false` now means off (it meant on), a value
  flag given no value (`init --key --url …`) is refused with exit 3, words after
  `--` are kept, and `<command> --help` shows help instead of running the
  command.
- **The baseline counts, line by line.** A new copy of an accepted finding now
  fails, including a second copy of a problem in a file that was already
  accepted once; the baseline records the lines it accepted, so moving them
  does not matter. Run `shomra baseline` again to accept a new copy, and re-run
  it once to upgrade a baseline written by an older version.
- **The pre-receive hook reads pushed commits straight from git** with the new
  `shomra check --rev <sha> [--base-rev <sha>]`. It checks what a push changes,
  takes waivers only from before the push, and cannot be blinded by a pushed
  `.gitattributes`. Re-run `shomra install-precommit --pre-receive` to upgrade an
  existing hook (a backup is kept).
- **A `shomra-ignore` mark covers only the line it governs.** In a pull request
  it counts only together with the line it covered on the base branch, a file
  mark only if the base branch had it in the first five lines, and the same
  problem on another line of the file is still reported.
- **`check --changed` includes files git does not track yet.**
- **`install-hook` adds a prompt hook for Codex and Gemini CLI**, and the
  GitHub Action and the `pr --init` workflow now run on Node 22 (Node 20 is
  past end of life).
- **`https://localhost` stays `localhost`.** Only plain-http localhost is
  rewritten to 127.0.0.1, so TLS names keep matching.

### Runtime firewall
- **A flagged call never runs silently when no server answers.** On a machine
  with no key, during an outage, or when the credential is refused, a call the
  on-machine tier flags now asks the person and names what matched
  (`SHOMRA_GUARD_LOCAL_FLAG=ask|allow|deny`).
- **One slow screen no longer switches org policy off.** The breaker opens after
  3 failures in a row (`SHOMRA_GUARD_BREAKER_FAILURES`), not after one - a slow
  screen is something content can cause, so a poisoned page could buy a window
  with no server checks.
- **You are told when policy is off.** When the server cannot be reached the
  firewall says so once every 30 minutes (Claude Code, Codex, Gemini CLI)
  instead of only writing to a log nobody sees.
- **Refusals made offline reach the server later.** A local refusal or a tamper
  attempt whose report failed is kept in a small outbox under `~/.shomra` and
  sent once the server answers again; a 5xx no longer counts as delivered.
- **A blocked tool result is withheld, not just annotated.** Claude Code gets a
  same-shape replacement (`updatedToolOutput`, and `updatedMCPToolOutput` for MCP
  tools), Codex and Copilot CLI theirs, and every agent's block text says what to
  do if the original is still visible.
- **Strict mode refuses on a crash.** Under `SHOMRA_GUARD_STRICT` an unexpected
  error in a hook answers with a refusal instead of an error exit the agent
  ignores.
- **Hooks cannot hang.** Every timer covers the response body, so a backend that
  sends headers and stalls no longer holds a tool call.
- **What an MCP tool types into a running process is screened as text**, and
  Gemini CLI MCP calls are read as MCP calls.
- **Agent memory edits are rebuilt the way each agent writes them** (Gemini
  `save_memory`, Claude Code curly-quote edits, Codex `apply_patch`), so they no
  longer read as changes made outside the agent; a refused memory write is never
  recorded as landed; a rollback writes through a symlinked memory file only
  when the file it names is itself a memory or rules file.
- **Long prompts stay private.** Prompts over 200,000 characters skipped
  on-machine masking; masking now covers the whole prompt, and at most 4 MB is
  sent.
- **Codex and Gemini CLI get the prompt guard**, so a pasted live credential is
  refused before it reaches the model, as in Claude Code and Cursor.
- **The tool hook loads only what it needs**, about 55 ms faster per call.
- **A call too large to screen asks you instead of running unscreened.** A
  request over the server's limit used to open the outage window, so that call
  and the next ones ran with no server check. Reconstructed files are dropped
  first; a call still too large is put to you (`SHOMRA_GUARD_LOCAL_FLAG`
  decides), and the outage window stays closed.
- **The on-machine screen cannot be crashed by a large write.** It reads the
  first and last 512 KB of very large text and flags what it did not read, and
  a screen that cannot finish flags the call instead of exiting with an error
  the agent ignores.
- **A named pipe or device can no longer hang the hook.** Every file the guard
  reads for an edit is opened without blocking and read only if it is a regular
  file.
- **Variable-expanded commands now reach the server's screen.** The expansion
  was being dropped on arrival; it is now graded and can only add findings. It
  is bounded at 16 KB, never expands a credential-named or very long variable,
  and is masked before it is sent.
- **Search and replace edits are read line by line**, so a large edit no longer
  takes minutes to read, a block that deletes text is applied correctly, and a
  Roo Code `:start_line:` hint is understood.
- **A memory change seen during an outage is reported once the server is back.**
  It used to be marked as delivered when the server never received it.
- **Rollbacks write only memory and rules documents.** A rollback naming a
  hooks file, an MCP config, a settings file, an extension manifest or a script
  is refused, even inside a folder named "memory", and a rollback that is
  already in place after a lost acknowledgement is reported as applied.
- **Outage counts are never lost to a damaged ledger.** A window whose start
  time is unreadable is still reported, with its length marked as not measured.
- **On-machine masking covers every match**, not the first 5,000 of each kind.

### Agent installs
- **Hooks are written in the format each agent loads.** Codex reads hooks only
  under `"hooks"` in hooks.json (and asks you to trust them at its next start);
  Copilot CLI needs `{ version: 1, hooks: { preToolUse, postToolUse } }`; Cline
  runs one script per event. All three were written in shapes the agent ignored.
- **`shomra protect` now wires Copilot CLI**, and status reports guarded agents
  from the real hook files.
- **`install-hook --uninstall`** removes exactly Shomra's entries and keeps
  yours; one malformed settings file no longer stops `--agent all` or `protect`
  from protecting the rest; settings writes are atomic, follow symlinks and keep
  their owner and permissions.
- **Claude Code's Monitor tool** is screened like Bash.
- **Windows hook commands are shell-neutral**, and re-running an install repairs
  hooks left pointing at a removed Node or Shomra install.
- **An Aider config that already sets `openai-api-base` is left alone** with a
  note, instead of being shadowed by a second key.

### Organization rollout
- **`sudo shomra install-hook --managed`** writes hooks a developer cannot remove:
  Claude Code's managed-settings.d (2.1.83 or later), `/etc/codex/hooks.json` and
  Copilot CLI's policy.d. It warns when the Node or Shomra install those hooks
  run could be changed by a non-root user. `shomra admin mdm-script --guard`
  adds it to the Jamf, Intune or Kandji bootstrap.

### MCP
- **The shim's reply-id bypass is closed.** A server could get a poisoned
  `tools/call` result or a denied `tools/list` past every screen by answering
  with an id that looked different (`"5"` for `5`). Replies are now matched to a
  pending request or dropped.
- **JSON-RPC batches are refused** in both directions, UTF-8 survives chunk
  boundaries, the shim forwards signals, flushes before exiting, applies
  backpressure and caps a line, and a refused server answers the client's own
  initialize id.
- **`shomra mcp guard` covers every config**: servers kept per project in
  `~/.claude.json`, Claude Desktop, VS Code, Cline and Gemini; a server guarded
  by an install that moved is repointed, never wrapped twice; backups keep the
  original's permissions.
- **Secrets in launch lines stay on the machine.** The connect check masks
  secret flags and URL credentials, and inventory reports replace each secret
  with a stable same-shape stand-in, so the backend still sees that a credential
  is there without seeing it.
- **Padding no longer hides content from the screen**: large results are read at
  both ends in linear time, base64 text blobs are decoded, and tool descriptors
  and arguments are screened in full.
- **Windows launches work**: `npx` resolves to `npx.cmd` (not the extensionless
  script beside it), only absolute PATH folders are searched, and arguments
  through cmd.exe keep trailing backslashes and quotes.
- **`shomra mcp serve` never turns a model-supplied path into a CLI flag.**
- **`mcp add`** keeps comma lists in `--env`, honours quotes in `--command`,
  accepts arguments after `--`, and will not rewrite a commented config.

### CI gates
- **Gates fail on what they could not analyze.** Skill folders named build or
  dist, namespaced commands, oversized, unreadable or symlinked artifacts, an
  HTML page from a wrong `SHOMRA_URL`, and a mistyped target all passed before.
- **`check --staged` checks what the commit carries**: the staged copy (not the
  working copy), renamed files, non-ASCII paths, staged symlinks and the scripts
  a staged skill ships.
- **`--strict` fails closed in every output mode**, including `--sarif`, a
  refused credential, and `pr`.
- **The pre-receive hook cannot be blinded** by a pushed `.gitattributes`
  `export-ignore`, and refuses a push it cannot read.
- **SARIF paths are right**: one base (the repo root), encoded segments, and the
  same base for pull request annotations. `gate <file> --sarif` works, and
  `report --json` and `pr --sarif` print one clean document.
- **`pr` uses `GITHUB_API_URL`** on GitHub Enterprise Server.
- **Edits to what an artifact pulls in count as edits to it.** `--staged`,
  `--changed` and `pr` now check a skill when only its scripts change, and a
  symlinked artifact when only its target changes. Staged links through a
  linked folder, and linked skill scripts, are read from the index; a staged
  link to nothing is reported, not dropped.
- **Limits report what they skipped.** A bundled file over 1 MB is read at both
  ends with a HIGH note on the middle, and files past the 200-file or 16 MB
  limit (skills and extension bundles) each raise a HIGH "not analyzed" finding.
- **An enrolled verdict is never weaker than the offline one.** Masked secrets
  keep their fixed parts (`AWS_SECRET_ACCESS_KEY=`, PEM headers, webhook hosts)
  and JSON escapes, and anything masking still hid from the server, plus the
  "not read whole" warning, is added to its verdict.
- **A config cannot reach the object prototype** (`__proto__` keys in TOML,
  YAML or frontmatter are refused), so a crafted `.mcp.json` can no longer make
  other files read as clean.
- **`pr --json` prints JSON when nothing changed**, the Action passes every line
  of a multi-line `args`, and launching MCP servers on Windows stays fast on
  long runs of backslashes.
- **`secrets` reads big files.** Files up to 64 MB are read in overlapping
  parts, so a token in a large log is found with its line number; devices like
  `/dev/zero` are skipped, and anything larger is reported as not scanned.
- **Large rules files check fast.** A long paragraph no longer takes seconds to
  split into sentences.
- **No input can stall the guard for minutes.** A YAML write of mostly blank
  lines, a memory file of blank lines before an authority claim, and a command
  of repeated substitutions or separators each took from seconds to hours to
  grade, long past the hook's wait - and a guard that gives up lets the call
  run. Five patterns that backtracked over runs of whitespace now read each
  character once, and they agree with the old ones on every input tested.
- **The GitHub Action no longer pastes its inputs into a shell script.**

### Detection
- **Scripts and reference docs bundled with a skill are graded**, as the backend
  grades them; a skill shipping an `install.sh` with a download-and-run line
  used to pass.
- **Extension bundles (`.mcpb`, `.dxt`) are read whole**: duplicate or
  disagreeing entry names block, every manifest copy is graded, and the scripts
  and server code inside are checked.
- **Configs are parsed the way the agents parse them**: comment markers inside
  JSONC and TOML strings, TOML multi-line strings and inline tables, and YAML
  crafted to take quadratic time.
- **Invisible characters are judged by their neighbours, as on the server.** A
  zero-width non-joiner in Persian or Hindi, a joiner in an emoji, a
  right-to-left mark beside Arabic, a BOM at the start of a file and a flag's tag
  sequence no longer raise a row offline. Text hidden in Unicode tag characters,
  variation selectors, invisible operators or zero-width alphabets is decoded and
  graded: an instruction or payload is HIGH, a secret CRITICAL, and invisible
  characters inside a link are flagged as ASCII smuggling. An instruction whose
  letters are interleaved with invisible marks is read with them removed.

### CLI
- **`secrets`** exits 1 on a find in every mode, refuses a missing path, scans a
  single file, streams git history, says when a scan was incomplete and reports
  each line once.
- **`init`** validates the URL and key, warns on plain http to another machine,
  and keeps a working config when the new one fails.
- **Large or broken MCP stores are reported**, not shown as empty (a
  `~/.claude.json` over 1 MB is read whole).
- **Artifacts sent for org policy have their secret values replaced** by
  same-shape stand-ins; `shomra fix` restores the real values in the returned
  fix.
- **The docs and `status` say exactly what leaves the machine without a key**:
  only pinned MCP package names, checked against osv.dev (`SHOMRA_OFFLINE=1`
  stops that).
- **`scan` and `report` never send a credential.** Every asset and artifact is
  masked before it is printed or uploaded, including permission allow-lists,
  registry addresses with a login in them and files bundled with a skill.
- **One odd file no longer stops the inventory.** A config nested thousands of
  levels deep, a named pipe or a link to a device is skipped and listed instead
  of crashing or hanging `scan`, `report`, `models` and `corpus`, and a failed
  discovery step is listed as skipped instead of ending the scan.
- **Agent folders linked from a dotfiles folder are scanned.** Links inside your
  home (or inside the project, for project folders) are followed; a link that
  leaves them, or points into a key or credential folder, is not read and is
  listed as skipped, and the scan summary says why each item was skipped.
- **A hook script in a folder whose name looks sensitive is still checked.**
  Only the part of the path inside the project or home is judged, and a script
  that resolves into a key folder is reported as withheld, not missing.
- **`--all-users` reports each user's own setup.** Other users are no longer
  credited with the guard, permissions or hook scripts of the project the scan
  was started from, and machine-wide MCP servers are listed once.
- **The folder you scan is always covered.** It is walked first with its own
  budget, large cache folders under your home are skipped, and a walk that
  ran out of budget is listed as skipped instead of ending silently.
- **A `headersHelper` command keeps its shape but never its credential.**


### Agent identity registration
- **`agent-identity register` works with the key `shomra init` stores.** The
  server refused every org endpoint key as "an agent credential"; it now refuses
  only a real agent credential.
- **`--owner` and `--no-owner` work.** Neither was a known flag, so the command
  exited before sending anything and the owner was always your git email.
- **A workload registers itself, and the agent holds no secret.** In GitHub Actions (with
  `id-token: write`) and GitLab (`id_tokens`) registration is keyless
  automatically; `--workload kubernetes|entra|okta` elsewhere. Re-running it on
  every build returns the same agent instead of minting `name-2`, `name-3`…
  Registering with a stored credential from CI now needs `--static`, because it
  minted a new secret per run and printed it into the build log.
- **No copy-paste, no restart.** On a developer machine the credential is saved
  to `~/.shomra/config.json` (0600) and presented by the firewall, `llm-proxy`
  and the MCP shim; `--for claude` keeps one per coding agent, `--no-save`
  prints it instead.
- **`--purpose`** records what the agent is for, so its calls can be graded
  against it, and `shomra status` shows which identity the machine presents.
- **A keyless session is never reused by another job.** The cached session was
  keyed only by backend and audience, so on a self-hosted runner a later job
  could present an earlier job's agent for up to an hour. It is now keyed to the
  job (GitHub, GitLab) or to the token's subject (clusters), and a refused
  session is dropped at once.
- **A refusal says which credential was refused and why.** Every 401/403 was
  reported as a rejected API key, including a suspended agent or one awaiting
  approval.

### Security (agent runtime hardening)
- **What a named script runs is screened, not just its name.** `npm test`,
  `make deploy` and `./setup.sh` showed the server only a name. The hook now
  reads the package.json script (with npm's pre and post hooks), the make recipe
  or the script file a command runs, sends it as `run_targets`, and sends the
  call to the server when the on-machine scan finds a dangerous line in it - or
  asks you when the server cannot answer.
- **A download whose output flag is bunched with others is still a download.**
  `curl -fsSLo install.sh <url> && sh install.sh` read as nothing to the staged
  fetch-then-run rule, which only knew a standalone `-o`; it is caught offline
  now, as on the server.
- **Every install reaches the server's package checks.** On a machine with no
  agent identity, `npm install`, `pip install`, `npx`, `docker pull`, `helm
  install`, `brew tap`, an editor extension, a model download and a dependency
  written into a manifest were decided on the machine unless the org had a rule
  of that type - so the server never looked the name up, and a package an agent
  invented went unchecked. They are now always sent (`SERVER_SCREENED_TYPES`),
  and the self-test expects them to be.
- **A call waiting for the person tells the person.** When an agent's policy
  asks the person it acts for to confirm a tool on their phone, Claude Code now
  shows them the code directly (`systemMessage`), not only the agent. Control
  and bidi-override characters in a tool name never reach their screen.
- **The server now answers before the hook gives up.** The hook waits
  `SHOMRA_GUARD_TIMEOUT_MS` (2s by default) and then fails open, while the
  server allowed its enrichment passes 4s - so a slow pass ran the call
  unscreened and opened a 30s breaker. Every tool call and every prompt now
  declares its wait (`guard_timeout_ms`), and the server bounds its screen
  inside it: a pass cut short is recorded and raises the floor instead.
  `SHOMRA_GUARD_TIER=fast` now reaches the server from both hooks.
- **The org key never follows a redirect to another host.** Node's `fetch`
  strips only `Authorization` on a cross-origin redirect, so `X-Shomra-Key` and
  an `shm_agt_` credential in `X-Shomra-Agent` went wherever a 3xx pointed.
  Every keyed call now goes through `keyedFetch`, which follows same-origin
  redirects (and an https upgrade on the same host) and refuses the rest.
- **A forged breaker can no longer switch the server tier off.** A breaker
  stamped in the future used to hold the circuit open forever. Only a stamp in
  the last cooldown window counts, and the file is written `0600`.
- **The guard protects its own state.** A tool call that writes, moves or
  deletes anything under `~/.shomra` (the key, the breaker, the ledger, the
  cached subject types) asks a person first, is reported to the server, and is
  refused outright under `SHOMRA_GUARD_STRICT` or on an agent that cannot ask.
- **`llm-proxy` serves this machine only.** A non-loopback `Host` or `Origin`
  is refused, which stops a web page reaching it through DNS rebinding. The
  configured `SHOMRA_AGENT` now wins over an `x-shomra-agent` a local client
  sends.
- **`agent-identity register` recommends the credential**, not the bare handle,
  and prints the credential's lifetime.

### Added (shift-left, batch 3)
- **`shomra plan` + `shomra_review_plan` + `plan-guard`** - threat-model what an
  agent is ABOUT to build. `design` reads a document a human remembered to write;
  coding agents produce a plan before every non-trivial task, automatically. Same
  engine, a hundred times the frequency, zero human effort: agent proposes a plan
  → Shomra threat-models it → the controls land in its context before it writes
  line one. Three redundant paths, strongest first: the MCP tool (any MCP-capable
  agent, no vendor hook), a `rules` section that asks the agent to call it (added
  only when the Shomra MCP server is actually registered - telling an agent to
  call a tool it does not have is noise that trains it to ignore the block), and
  a Claude Code `PreToolUse` hook on `ExitPlanMode`. That tool name is NOT in the
  published hook docs, so it gets its OWN PreToolUse entry rather than being
  folded into the tool-guard matcher: if it never fires, only this hook is dead.
  ⚠ A plan is a proposal - the default is to inform, never refuse. Only
  untrusted-input-reaches-a-hard-sink escalates to `ask`, and only under
  `SHOMRA_GUARD_STRICT=1`. `SHOMRA_PLAN_GUARD_OFF=1` disables just this channel.
- **`shomra corpus`** - screen RAG documents at INDEX time. The result firewall
  screens what a retrieval brings back; nothing screened what went in, so a
  poisoned document sat in the vector store indefinitely and was judged for the
  first time as one chunk, stripped of its document, inside a live request. Index
  time has the whole document (a payload split across paragraphs is visible),
  costs once per document instead of once per retrieval, and a failing document
  is simply never embedded. Findings carry the CHUNK index, not just the line,
  because retrieval returns chunks. `--manifest` emits the quarantine list for an
  ingestion job to consume. Invisible/bidi characters are a first-class BLOCK.
  ⚠ Absence accounting: real corpora are mostly PDF/DOCX/PPTX, which this cannot
  read - every unreadable file is counted and reported as NOT covered, and
  `--strict` fails on them.

### Fixed
- **`design` missed untrusted input by format and by provenance** - `pdf`
  could not match the plural in "ingests uploaded PDFs", and no rule keyed on
  content being RECEIVED FROM a party outside the trust boundary. Found by
  running plan-guard against a realistic plan. Both fixed and pinned.

### Added (shift-left, batch 2)
- **`shomra design <file|dir|->`** - threat-model a system that does not exist
  yet. Reads an RFC / design doc / Jira or Linear ticket / PR body and says
  whether what is described closes a path from untrusted input to a consequence.
  Reuses the platform's own model (`attack-graph.ts`: sources = untrusted input /
  sensitive data / filesystem; sinks = network egress / execution / destructive
  action; a closed pair is an attack path) - that model does not care whether the
  capabilities came from a scan or from a sentence. Each capability cites the
  line that evidenced it, ranked so the citation is the line that DESCRIBES the
  behaviour rather than the first line the word appeared on. `--checklist` emits
  the conditions as a markdown task list to paste into the ticket as acceptance
  criteria. Ticket integration is a pipe, deliberately:
  `gh issue view 42 --json body -q .body | shomra design -`.
  ⚠ There is no clean verdict, by design: `NOT_DESCRIBED` is a statement about
  the DOCUMENT, not the system. Exit 1 when untrusted input reaches execution or
  a destructive action; 2 for any other closed path under `--strict`.
- **`shomra add mcp|skill|model|package <ref>`** - one gate for every channel an
  agent acquires from, not just MCP. `skill` gates the manifest AND the scripts
  the skill bundles; `model` checks the Model Index before any weights download;
  `package` catches the dominant failure - an agent suggesting a plausible
  package name - with edit-distance typosquat detection against the AI package
  catalog, fully offline. ⚠ Unknown is never clean: an unreachable index, an
  unscanned model and an unrecognised package all return FLAG, never ALLOW.
- **`shomra install-precommit --pre-receive`** - the un-bypassable sibling of the
  pre-commit hook. Runs on the git SERVER, on every push, for every developer;
  no `--no-verify`, no per-machine install. Deliberately FAILS CLOSED (the client
  hook fails open): at an enforcement point, deleting the binary must not be the
  bypass. Self-hosted Git + GitHub Enterprise; on GitHub.com the equivalent is
  the Action as a required status check.
- **`shomra new agent [name] --framework vercel-ai`** - a whole project that
  starts compliant: guard enforcing on every model call, an egress allowlist in
  code rather than in the prompt, untrusted input kept out of the system prompt,
  secrets referenced from the environment, and the gate wired into CI from commit
  zero.
- **Reusable GitHub Action** (`action.yml`) - replaces the copy-pasted workflow
  snippet that no consumer ever updated. Composite, not Docker.
- **Dev Container Feature** (`devcontainer-feature/`) - installs the CLI and runs
  `shomra protect` at provision time, so the guard exists before the first
  keystroke in Codespaces / Gitpod / a local rebuild. `rules` is off by default:
  a feature that edits a developer's committed files unasked is a surprise.
  There is deliberately no `curl … | sh` installer - Shomra's own Tier-0 blocks
  that pattern, and shipping one would be the product contradicting its own
  control in its own README.

### Added
- **`shomra rules`** - compiles what Shomra enforces into the coding agent's own
  context files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/shomra.mdc`,
  `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurfrules`,
  `.clinerules/shomra.md`), so the blocked pattern is never generated. Every
  other surface intercepts *after* the model wrote something; this one runs
  before it. The block is derived, not boilerplate: the always-on directives
  mirror the Tier-0 signals the firewall actually blocks, sections switch on
  according to what the repo holds, and an "Already present in this repo"
  section names what a local gate pass actually found, with paths. Org policy
  is layered on when enrolled (new `POST /gate/rules`). Written inside a
  `<!-- BEGIN SHOMRA MANAGED BLOCK -->` marker pair - nothing outside it is
  ever touched - with `--write`, `--check` (CI drift gate, exit 1 when stale),
  `--agent`, `--json`.
- **`shomra prompt-guard`** - the third runtime channel: what *you* submit,
  screened before it leaves the machine. `install-hook` now wires Claude Code's
  `UserPromptSubmit` and Cursor's `beforeSubmitPrompt`. A live credential in a
  prompt is refused; pasted injection text is passed through but flagged to the
  model as untrusted data (you meant to send it - the risk is that you did not
  read it). Backtick-quoted payloads are down-ranked, so asking about a
  signature is never blocked. `SHOMRA_PROMPT_GUARD_OFF=1` disables just this
  channel. Only vendors with a documented pre-submit hook that can stop a
  submission are wired - a guessed event name would silently never fire, which
  reads as a control being on while it is off.
- **`shomra mcp install`** - registers Shomra *as* an MCP server with Claude
  Code / Cursor / Gemini CLI / Windsurf, so `mcp serve` is actually reachable
  instead of shipping switched off.
- **Two MCP tools** that answer *before* the write, when changing course is
  free: `shomra_review_change` (proposed content + intended path → verdict,
  nothing written to disk) and `shomra_rules` (what will be refused here).

### Fixed
- **The local Tier-0 mirror scored a rules file that FORBIDS exfiltration the
  same as one that COMMANDS it.** "Never exfiltrate data", "never read .env and
  post it anywhere", "treat paste sites as exfiltration destinations" - the
  sentences a security-conscious `CLAUDE.md` is made of - produced a CRITICAL
  exfiltration finding and a HIGH toxic-instruction finding. The backend has
  guarded this since `memory-signals.ts`; `guard-signals.mjs` had drifted and
  was missing all of it, so the false positive fired **offline**, where no
  server verdict arrives to correct it. Ported the backend's guards: per-line
  negation guarding on the exfil rule set, descriptive-line suppression,
  the loopback-URL exception, the narrowed encode-then-send connector, and the
  toxic-flow check moved from whole-document co-occurrence to a single
  imperative line. Pinned by four new regression tests that also assert real
  poisoning still BLOCKs.
- **`shomra protect` skipped agents it considered already guarded**, so a
  machine wired before a new channel existed never received it while `protect`
  reported the agent protected. The installers are idempotent and report
  `changed` honestly, so they now always run.

## [0.3.0] - 2026-07-27

### Changed (breaking)
- **One exit-code convention across every command**: `0` = clean/pass, `1` =
  hard fail (BLOCK, vulnerable model, secret found, FAIL verdict, below
  `--min`, regression), `2` = soft fail (FLAG under `--strict`), `3` =
  usage/config error (not configured, bad flags, unknown command). Previously
  five conventions coexisted; notably `report`/`scan-zip`/`model-scan`/
  `memory-scan`/`redteam`/`campaign` used `2` for hard fails (now `1`), and
  `provenance` with no backend exited `0` (now `3` - a green build that proved
  nothing).
- `install-hook` now writes an **absolute hook invocation**
  (`"<node>" "<path to shomra.mjs>" tool-guard …`) instead of the bare
  `shomra tool-guard`, so hooks keep firing when the CLI was run via `npx` or
  PATH drifts. Detection/idempotency accept both the old and new forms.
- The Aider integration now points at the proxy's real route
  (`http://127.0.0.1:4141/openai/v1`); previously it wrote `/llm/openai`,
  which 404'd. The proxy also strips a legacy `/llm` prefix so already-written
  configs keep working.

### Added
- `shomra --version` / `-v` / `version` (reads package.json - single source).
- Unknown commands and unknown `--flags` now error with exit `3` and a
  "did you mean …?" suggestion instead of dumping the full help (commands) or
  silently no-opping (flags - the worst failure mode for a security gate).
- Boolean flags (`--strict`, `--json`, `--sarif`, …) no longer swallow the
  next argument: `shomra check --strict <dir>` and `shomra gate --json <file>`
  now work in any order.
- `status` reports the runtime-firewall hook per agent (all 8 supported
  agents' config files, both bare and absolute command forms) and prints
  "none (local mode …)" instead of `null` for an unconfigured backend.
- Local `check` output: clean display name (path shown once), `(path:line)`
  on findings that carry one, and an explicit "… and N more (run with --json
  for all)" instead of silent truncation at 3.
- `pr --sarif` (stdout) / `--sarif=<file>` - SARIF 2.1.0 for the changed
  artifacts, matching the platform docs.
- The gate now covers its own attack surface: the other agents' hook/config
  files install-hook writes (`.cursor/hooks.json`, `.gemini/settings.json`,
  `.cline/hooks.json`, `.codex/hooks.json`, windsurf/copilot hook files,
  `.aider.conf.yml`) are matched and checked like `.claude/settings.json`.
- `models` no longer claims "no known-vulnerable models" when lookups failed -
  it reports how many references could not be checked and why. `mcp add`
  skips the index lookup cleanly when no backend is configured (no more raw
  fetch errors).
- `--json` output of `model-scan`, `memory-scan`, `redteam`, `campaign` and
  `harden` is now pure JSON (progress chatter no longer breaks `| jq`).
- Shared "Not configured" error (exit `3`) that says where to get a key
  (app → Settings → API Keys).
- `install-precommit`'s hook now prints an unmissable warning when `shomra`
  is not on PATH (the gate did NOT run), instead of a silent skip.
- `install-hook` with no `--agent` says it defaults to Claude Code only and
  suggests `--agent all` / `shomra protect`; help lists all 8 agents.
- Help: exit-code table, `report`, `mcp list`, and the full `SHOMRA_*` env
  var set; README documents the same plus the baseline/.shomraignore/
  policy.yml adoption story.
- CLI-level tests (`tests/cli.test.mjs`): flag parsing, unknown-flag/command
  rejection, `--version`, JSON purity, and exit-code mapping.

## [0.2.x] (0.2.1 - 0.2.11)

Consolidated - these releases shipped between 0.2.0 and 0.3.0:

- `fix` (AI remediation with unified-diff preview / `--apply`) and `why`
  (per-finding explanation + false-positive read; works offline).
- `baseline` - accept current findings so only NEW ones fail; plus
  `.shomraignore`, inline `shomra-ignore` comments, and `.shomra/policy.yml`
  policy-as-code (block/flag thresholds + allow-list, worst-wins vs org).
- `provenance` - evidence-backed "which changed files did an AI agent write?"
  from runtime-firewall telemetry, with `--trailer` and `--fail-on-blocked`.
- `campaign` - autonomous multi-turn adversary runs; `harden` - the
  self-hardening flywheel (propose → FP-verify → `--apply` signatures).
- `llm-proxy` - local guard proxy for OpenAI/Anthropic/Gemini + compatible
  providers; `agent-identity register` - per-agent credentials presented as
  `x-shomra-agent`.
- `mcp serve` - Shomra as an MCP server (check / scan_models / fix / explain
  tools over stdio JSON-RPC); `mcp add` vets servers against the MCP Security
  Index before writing configs.
- `pr --init` - one-shot scaffold of the GitHub Actions PR-review workflow.
- Model-load screening in the PreToolUse hook (Model Security Index cache,
  guard-budgeted lookups), tiered Tier-0/Tier-2 guard hardening, circuit
  breaker, and multi-agent hook support (cursor/windsurf/gemini/codex/
  copilot/cline/aider).
- Relicensed to **Apache-2.0** and prepared the package for public release
  (added `LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, `.gitignore`,
  `CODEOWNERS`).

## [0.2.0]

- Local-first scanner and runtime firewall for AI artifacts (skills, slash
  commands, subagents, hooks, MCP configs, rules/instruction files, memory).
- `check` / `gate` / `gate --all` with `--json` and `--sarif` output and
  CI-friendly exit codes (0 allowed / 1 blocked / 2 flagged with `--strict`).
- `models` - detects AI-model loads in source and looks them up in the Shomra
  Model Security Index (enrichment; degrades offline).
- `install-hook` / `tool-guard` / `result-guard` - tiered runtime firewall for
  coding agents (local Tier-0 block, optional backend escalation).
- `secrets`, `doctor`, `protect`, `new`, `mcp add`, `why`, `pr` (GitHub PR bot),
  `install-precommit`.
- `discovery.mjs` machine scan for local AI tooling, runtimes, and exposed keys.

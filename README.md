# S.A.M. | Secret Agent Man

**A local-first commander for an AI agent workforce.**

SAM is an experimental, CLI-first system for turning a goal into a coordinated mission: plan tasks, assign capable operatives, track progress, preserve context, and require human approval for risky actions. The long-term vision includes model-provider adapters, arbitrary MCP servers, coding agents, browser/computer-use workers, hierarchical teams (including agents supervising other agents), and CLI or Telegram control.

**Built in public through hourly development sprints.** ChatGPT runs a scheduled SAM build cycle approximately once per hour, reviewing the repository, open PRs, and CI before attempting one focused improvement. Each sprint reports actual commits, tests, blockers, and the next assignment. These are scheduled development attempts, **not** SAM independently programming itself; an hourly sprint does not guarantee a commit, a completed feature, or passing tests.

**Current reality:** SAM is an early-stage TypeScript/Node.js prototype, not a working autonomous workforce. Its mission, task, memory, routing, lease, approval, configuration, MCP authorization policy, and local daemon foundations exist, and it can execute one deterministic offline echo task and persist verified evidence on a fenced lease. It has a provider-neutral text conversation contract, deterministic fake-provider CLI, and opt-in live OpenAI-compatible text chat via `chat --live` and interactive `talk --live`. A user has verified live MiniMax chat from Windows. Live conversations inject SAM's built-in identity and optional workspace `SOUL.md`, but chat transcripts are not persistent. SAM does not yet execute MCP tools, let the model use computer tools, or perform real agent work. An explicit CLI-only read-only directory inventory is available for manual inspection; it is not a security sandbox. End-to-end model-driven delegation, general MCP execution, computer use, and Telegram control are still future work.

**Not tied to Second Shift.** Second Shift is a possible early MCP integration, not a requirement. SAM is designed to be provider-agnostic and integration-agnostic.

## Current experimental milestone: owner-approved live memory write (unmerged)

On this branch, `node dist/cli.js talk --live --memory-write` offers a bounded `memory_add` model tool. Each proposed record is printed and requires the owner to type exact `YES` in the local terminal. A denied record is not saved; approved records are stored in workspace-local SQLite with model-proposed provenance. Existing `--memory-tools` supports read-only `memory_search`; combine flags to write and retrieve. Model text and stored memories are untrusted, not authority. No unattended writes, edits, deletion, external actions, or autonomous execution. **GitHub code committed; Windows build, tests and live MiniMax verification pending.** The follow-up audit fix on this branch distinguishes owner-denied memory writes from completed calls; it has a new regression test, also pending execution. This work is stacked on unmerged review/timeout branches. See [scoreboard](docs/SCOREBOARD.md).

## Current sprint: model output hygiene (PR pending, unmerged)

This branch adds filtering of embedded `<think>...</think>` text in OpenAI-compatible model responses, rejects unterminated/reasoning-only replies, and makes invalid memory-kind errors actionable. Automated test coverage was added but has **not yet been run in this GitHub-only build environment**. Run `npm run build && npm test` on Windows before merging. This does **not** connect the model to SQLite memory or implement skills.

**Next implementation:** bounded model-to-memory tool bridge, then local `SKILL.md` discovery from `.agents/skills/` with permissioned invocation. See [build scoreboard](docs/SCOREBOARD.md).

## Experimental opt-in memory recall (unmerged feature branch)

`node dist/cli.js talk --live --with-memory` sends up to ten recent workspace SQLite memory records (each truncated to 500 characters, total bounded to 6000 characters) to the configured model as explicitly untrusted context. This requires deliberate opt-in because memory content is sent to the model provider. It reads existing records across CLI restarts, but does **not** let the model search, write, edit, or archive memory. It does not persist conversation transcripts. Tests and live behavior must be verified before merge.

During `talk --live`, `/memory <query>` performs a local read-only SQLite FTS search and prints up to ten bounded records. It makes no model request and does not automatically insert results into model context. This is a stepping stone toward actual model tool calls, not an autonomous search tool.

## Experimental native model-to-memory tool (unmerged)

Run `node dist/cli.js talk --live --memory-tools` to allow the configured OpenAI-compatible model to request **read-only** `memory_search` against local SQLite. This explicitly sends relevant returned records to the model provider and may incur a second API request. At most three read-only memory searches per user turn are allowed; unsupported tool names and invalid arguments are rejected. Console audit lines report requested/completed/failed calls. Model-initiated writes, filesystem access, commands, skill execution, and durable tool audit logs are not implemented. Provider compatibility, Windows build, tests, and live behavior require verification before merge.

## Experimental scoped workspace read tools (unmerged)

Run `node dist/cli.js talk --live --workspace-tools` to opt in to model-selected `list_directory`, `read_file`, `search_files` and `memory_search`. The workspace is the CLI's configured `--workspace` root. File reads are capped at 32KB, search is shallow and bounded, and hidden paths, .env, .git, .sam, node_modules, key files and symlinks are blocked. Tool results are untrusted content and may be sent to the configured model provider. No writes, command execution or Git modifications are granted. Windows and live model verification pending.

## Follow the build

- [Open pull requests](https://github.com/ReactionLabs/sam/pulls) for work in progress and review.
- [Commit history](https://github.com/ReactionLabs/sam/commits/main/) for changes merged into the default branch.
- [GitHub Actions](https://github.com/ReactionLabs/sam/actions) for available automated checks.

> Public source can be viewed, cloned, and forked. Never commit API keys, tokens, or client credentials.

## Quick start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js mission create "Audit this repository"
node dist/cli.js mission list
node dist/cli.js status
node dist/cli.js chat "hello" # offline fake provider, no network
# For an offline test: create a mission, add a task, transition through
# PLANNING, READY, RUNNING, then run task run-offline <mission-code>.
# Inspect its durable evidence with task result <task-id>.
```

All state lives in one SQLite database at `.sam/missions.db` in the
workspace (override the workspace with `--workspace <path>`; add `--json`
for machine-readable output).

## Next major milestone: SAM completes one real task on the owner's computer

**Status: NOT YET IMPLEMENTED.** This is the next product milestone, not a claim of current computer control.

**Demonstration:** The owner authorizes one disposable local project folder and asks SAM to inspect it, diagnose a deliberately failing test, propose a fix, request approval for any write or command, execute only the approved operation in an isolated environment, rerun the test, and show the actual diff and results. The owner can deny or cancel at any point.

**Acceptance criteria:**

1. Explicit workspace grant: no ambient filesystem browsing. Reject path traversal, symlink escapes, and sensitive files.
2. Read-only inspection works first and returns grounded filenames and file contents with bounded output.
3. Any write, shell command, or coding-agent CLI invocation requires an authenticated, action-bound owner approval. No prompt text can grant permission.
4. Commands run under a real restricted boundary, not just a working-directory setting; enforce timeouts, output limits, cancellation, and no inherited secrets.
5. Optionally delegate an approved coding task to a configurable CLI such as Claude Code or Codex; no dependency on any single model or paid provider.
6. Record requests, approvals, tool actions, outcomes, and test evidence in an audit trail. Report failures without claiming success.
7. Windows Node 22/24 automated tests cover unauthorized paths, denied commands, stale approvals, cancellation, and a successful disposable-folder end-to-end task.

**Build order:** authorized read-only file tools -> owner-authenticated approval boundary -> sandboxed command runner -> coding CLI adapter -> end-to-end supervised task.

**Definition of done:** A fresh user can reproduce the demo locally from documented setup instructions, see the tests pass, and inspect an honest audit log. Until then, SAM can converse but cannot operate the owner's computer.

## Manual read-only directory inventory (experimental)\n\n`node dist/cli.js inspect-local --root ./sample-project` lists up to 100 immediate entries of an explicitly selected folder, with `--dir src` for a relative subfolder. Hidden and sensitive-looking entries are marked blocked; symlinks are never followed. No file contents are read or sent to a model. This is a local diagnostic command only, **not a secure sandbox or a permission grant to SAM**. A privileged local user can invoke other programs independently. Filesystem races and OS-level confinement must be addressed before model-driven file tools are enabled.\n\n## What is in this build

- **Missions** (`mission create|list|inspect|transition`): a 12-state
  mission state machine with an append-only event history, persisted in
  SQLite (WAL).
- **Offline execution** (`task run-offline|result`): one deterministic local echo task per invocation, with request-bound SHA-256 evidence and transactional SQLite persistence. This is a test adapter, not a model or tool runner. The CLI requires a RUNNING mission and a valid scheduler lease. No automatic retries or network calls.
- **Tasks** (`task add|list`): dependency-aware task planning per mission.
  The scheduler core also provides fenced worker leases (generation +
  expiry + heartbeat) so a crashed worker's task can be recovered safely.
- **Memory** (`memory add|list|search|archive`): durable records with
  source provenance and SHA-256 hashes, FTS5 search, soft archive.
  Memory is evidence, never an instruction with authority over policy.
  See `docs/hermes-lessons.md`.
- **Operatives** (`operative register|list|state|heartbeat|candidates`):
  a capability registry with heartbeat freshness and capacity-aware
  routing. Declarations are never credentials.
- **Assignments** (`assignment claim|active|renew|finish`): durable,
  exclusive, crash-recoverable leases binding an operative to a task.
  A lease is capacity reservation, not execution permission.
- **Approvals** (`approval request|list|inspect`): an action-bound,
  expiring, one-shot approval ledger. The CLI deliberately has **no**
  decide or consume command: deciding requires an owner-authenticated
  boundary that is not built yet. See `docs/approval-boundary.md`.
- **Daemon** (`daemon serve|status|stop`): a single-instance, local-only
  IPC daemon over a workspace Unix socket.
- **Configuration** (`config show`): environment configuration for the
  future MiniMax model adapter and Second Shift MCP connection
  (see `.env.example`). Remote endpoints must be HTTPS, URLs may not
  carry credentials, and the CLI reports secrets only as present or
  absent, never their values. `doctor` reports model/MCP readiness.
- **MCP policy** (`mcp authorize`): a local dry-run of the deny-by-default
  authorization boundary for a future MCP executor. Exact-match,
  owner-approved read-only allowlist only: no wildcards, no prefix
  matching, untrusted servers and duplicate tool names are denied.
  The command makes no network connection. See `docs/mcp-security.md`.

## Verify

```bash
npm run build
npm test
```

The test suite covers the state machine, the task scheduler, memory,
operatives, assignment leases, approvals, the daemon, and an integrated
CLI walk that runs a mission, task, memory record, operative, assignment
lease, and approval request through one workspace database across
separate processes.

## Model conversation foundation

The `chat` command exercises a provider-neutral text-only contract using a deterministic fake provider. It makes **no model API calls**, uses no credentials, and does not execute tools. The interface is groundwork for real provider adapters and future mission integration, not a working AI chat product.

## Not implemented yet

- Real model adapters (including MiniMax) and actual operative execution
- An authenticated MCP client/executor (configuration and the
  deny-by-default authorization policy are in; no transport is
  connected and the policy is not yet integrated into one)
- Owner-authenticated approval decisions
- Memory curation, deduplication, and automatic skill extraction

### Experimental live model chat (PR #20 only, not on main)

By default `sam chat "hello"` uses a deterministic fake provider and makes **no network request**.
An explicitly opted-in `--live` command supports an OpenAI-compatible chat-completions endpoint.
It sends one prompt to the configured model service, which **may incur charges**. No key is saved by SAM.
On PowerShell, set `SAM_MODEL_ENDPOINT` to the provider's HTTPS URL ending in
`/chat/completions`, set `SAM_MODEL_API_KEY` locally, and set `SAM_MODEL` to its model ID.
Then run `node dist/cli.js chat "Hello" --live`.
For local model servers, loopback HTTP is permitted and the API key may be blank.
No streaming, multi-turn persistence, tools, agent planning, or autonomous execution yet.
Do not commit keys, and never use `--live` until you intentionally accept the provider's terms and costs.

### MiniMax terminal sprint (experimental PR branch only)

These commands require the unmerged model conversation PR. In Windows PowerShell,
check out `feat/model-conversation-contract`, then run `npm install` and
`npm run build`. The default `main` branch does not include live chat.

```powershell
$env:SAM_MODEL_PROVIDER = "minimax"
$env:SAM_MODEL = "MiniMax-M2"
$env:MINIMAX_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "MiniMax API key" -AsSecureString)).Password
node dist/cli.js talk --live
```

Use the exact model ID enabled on your MiniMax developer account if different.
The key stays in this PowerShell process environment, not in a repository file
or command-history literal. Close the terminal or run
`Remove-Item Env:MINIMAX_API_KEY` afterward. Environment variables may still
be accessible to local processes running under your account.

`talk --live` starts a multi-turn conversation, keeps up to 40 messages in
memory, and exits on `/exit`. Every turn sends conversation content to the
configured provider and may incur charges. There is no tool access, persistent
transcript, autonomous execution, or spending limit yet. Never paste your key
into chat or a GitHub issue.

## Experimental SAM identity (unmerged feature branch)

Live `chat --live` and `talk --live` inject a system identity describing SAM's actual abilities and limitations. Optionally create `SOUL.md` in the selected workspace to add local personality instructions (up to 16,000 characters). Do not put API keys or credentials in `SOUL.md`. This does not enable file access, tool execution, persistent chat history, or autonomous agents. The CLI reads this file itself; the model cannot browse your computer.

The scheduled development cycle runs approximately hourly. Each run may produce a tested PR update, but does not guarantee a commit. Unmerged feature branches are not features on `main`.

## Durable agent-loop journal (experimental)

Live `talk --live --workspace-tools` and `--memory-tools` now record each user goal, tool events, round/call counts, and final outcome in workspace-local SQLite. `sam loop inspect <id>` inspects a known loop ID; `sam loop recover` explicitly marks orphaned running loops as interrupted without replaying tools. This is **checkpointing, not automatic resume**. The current loop remains limited to four tool rounds and eight tool calls; the journal is not a grant to execute commands or install skills. New tests and Windows live verification pending.

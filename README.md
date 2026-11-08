# S.A.M. | Secret Agent Man

**A local-first commander for an AI agent workforce.**

SAM is an experimental, CLI-first system for turning a goal into a coordinated mission: plan tasks, assign capable operatives, track progress, preserve context, and require human approval for risky actions. The long-term vision includes model-provider adapters, arbitrary MCP servers, coding agents, browser/computer-use workers, hierarchical teams (including agents supervising other agents), and CLI or Telegram control.

**Built in public, one careful step at a time.** ChatGPT is contributing code to this repository through a scheduled build cycle approximately every two hours. Each cycle is intended to inspect the current code and PRs, implement a focused improvement, and report verification honestly. This is an automated development workflow, **not** SAM independently running itself, and scheduled runs do not guarantee a new commit or a passing test.

**Current reality:** SAM is an early-stage TypeScript/Node.js prototype, not a working autonomous workforce. Its mission, task, memory, routing, lease, approval, configuration, MCP authorization policy, and local daemon foundations exist, and it can execute one deterministic offline echo task and persist verified evidence on a fenced lease. It has a provider-neutral text conversation contract and deterministic fake-provider CLI, but does not call real models, MCP tools, or real agent work. End-to-end model-driven delegation, general MCP execution, computer use, and Telegram control are still future work.

**Not tied to Second Shift.** Second Shift is a possible early MCP integration, not a requirement. SAM is designed to be provider-agnostic and integration-agnostic.

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

## What is in this build

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

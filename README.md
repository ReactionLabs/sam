# S.A.M. | Secret Agent Man

**A local-first commander for an AI agent workforce.**

SAM is an experimental, CLI-first system for turning a goal into a coordinated mission: plan tasks, assign capable operatives, track progress, preserve context, and require human approval for risky actions. The long-term vision includes model-provider adapters, arbitrary MCP servers, coding agents, browser/computer-use workers, hierarchical teams (including agents supervising other agents), and CLI or Telegram control.

**Built in public, one careful step at a time.** ChatGPT is contributing code to this repository through a scheduled build cycle approximately every two hours. Each cycle is intended to inspect the current code and PRs, implement a focused improvement, and report verification honestly. This is an automated development workflow, **not** SAM independently running itself, and scheduled runs do not guarantee a new commit or a passing test.

**Current reality:** SAM is an early-stage TypeScript/Node.js prototype, not a working autonomous workforce. Its mission, task, memory, routing, lease, approval, and local daemon foundations exist; end-to-end model-driven delegation, general MCP execution, computer use, and Telegram control are still future work. Some changes are proposed in open PRs and are not yet on `main`.

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
```

All state lives in one SQLite database at `.sam/missions.db` in the
workspace (override the workspace with `--workspace <path>`; add `--json`
for machine-readable output).

## What is in this build

- **Missions** (`mission create|list|inspect|transition`): a 12-state
  mission state machine with an append-only event history, persisted in
  SQLite (WAL).
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

## Not implemented yet

- Model adapters, MCP, and operative execution
- Owner-authenticated approval decisions
- Memory curation, deduplication, and automatic skill extraction

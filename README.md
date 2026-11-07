# S.A.M. | Secret Agent Man

CLI-first agent commander and durable mission runtime.

> Status: early implementation, not production ready. SAM plans, tracks,
> leases, remembers, and gates work. It can execute one deterministic offline echo task and persist verified evidence on a fenced lease. It does not run models, MCP tools, or real agent work.

## Quick start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js mission create "Audit this repository"
node dist/cli.js mission list
node dist/cli.js status
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

- Real model adapters (including MiniMax), authenticated MCP client, deny-by-default tool authorization integration, and actual operative execution
- Owner-authenticated approval decisions
- Memory curation, deduplication, and automatic skill extraction

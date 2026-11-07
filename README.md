# S.A.M. | Secret Agent Man

CLI-first agent commander and durable mission runtime.

> Status: early implementation, not production ready. SAM plans, tracks,
> leases, remembers, and gates work. It does not execute agent work yet:
> there is no model adapter, MCP server, or tool executor in this build.

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

## Not implemented yet

- Model adapters and operative execution
- An authenticated MCP client/executor (configuration and the
  authorization policy are in; no transport is connected)
- Owner-authenticated approval decisions
- Memory curation, deduplication, and automatic skill extraction

# SAM Build Scoreboard

Last repository audit: 2026-11-08 (America/New_York).
Source of truth: [README](../README.md), [open PRs](https://github.com/ReactionLabs/sam/pulls), [CI](https://github.com/ReactionLabs/sam/actions).

## Current milestone

**Connect live model chat to persistent memory and permissioned tools.**

| Capability | Status on main | Verification |
| --- | --- | --- |
| SQLite memory with FTS5, provenance and archive | Implemented | Source inspected; tests not run this cycle |
| CLI memory add/list/search/archive | Implemented | Source inspected; not accessible to model chat on main |
| Offline mission runner and leases | Foundations implemented | README reviewed; tests not rerun |
| Provider-neutral model conversation | PR #20 | Not merged to main |
| Live MiniMax talk --live | Owner reports working on local branch | Not verified on main; model cannot update memory |
| Model-driven memory read/write/update/delete | Not on main | Needs typed tool router, authorization, audit |
| Local dashboard and native agents | Planned | Not shipped |
| Computer tools, MCP and skills | Planned / foundations | Not end-to-end |
| Webhook wake and Tailscale Serve/Funnel | Planned | Not shipped |

## Observed user test

On Windows in C:\Projects\sam, the owner used node dist/cli.js talk --live and asked SAM whether it could update memory. The model answered that it had no persistent memory tool in that session. This does not mean storage is absent: src/memory.ts already persists records in SQLite, while src/cli.ts exposes separate manual commands. The live model branch and default branch must be reconciled before implementing the integration.

## Next assignment: real live-chat memory tool slice

Target: src/memory.ts, src/cli.ts, live model adapter/conversation module (PR #20 or successor), new permissioned memory tool dispatcher and tests.

Acceptance criteria:
1. Model may request bounded memory.search/read and propose memory.add/update/archive through a typed tool router. Durable writes require owner-authorized policy; sensitive facts require explicit consent and secret filtering.
2. Save a harmless fact in one real live chat; restart process and retrieve it in a new chat against the same workspace DB.
3. Version updates and archive/delete with audit history; never claim success unless committed.
4. Test denied writes, prompt injection, duplicate/oversized records, provenance, workspace isolation, and cross-process persistence. Verify Node 22/24 CI.
5. Update README and scoreboard with exact commit, test evidence, limitations and next task.

Dependencies: inspect current live-model branch and open PRs #19-#21, then implement on correct base. No merge without owner approval.

## Roadmap after this milestone

- Local-first Control Center: main chat, sidechats, agents/teams, missions, approvals and settings.
- Scoped filesystem actions, supervised commands, coding CLI adapters.
- Extensible capability registry: MCP, Agent Skills/SKILL.md, skills.sh, OpenAPI, custom CLI/API tools and channels.
- Episodic memory: outcomes, failures, evidence, retrieval; self-authored versioned skills promoted only after tests and owner approval.
- Durable cron/heartbeat/watchers and signed webhook-triggered wake-ups.
- Optional Tailscale Serve for private dashboard; Funnel only for isolated webhook ingress. No public exposure by default.
- Optional desktop wrapper and managed hosting later. SAM remains generic and self-hostable.

## Sprint history

| Date | Outcome | Verification | Next |
| --- | --- | --- | --- |
| 2026-11-08 | Inspected main README, CLI/memory source and open PRs; proposed scoreboard and README update in review branch. No runtime feature claimed. | GitHub source review only; no local build or tests. | Live-chat memory tool integration. |

**Rule:** Never confuse a PR, a local build, or a plan with shipped default-branch behavior. No forced commit quota. Record blockers and no-change cycles honestly.

# SAM build scoreboard

Updated: 2026-11-08 owner-local date (the latest GitHub Actions runs are timestamped 2026-11-09 UTC).

## Current milestone

Connect the existing local Mission Control dashboard, live model runtime, persistent SQLite memory, and permissioned tools without claiming unmerged work is on main.

## Repository and integration state

| Item | State | Evidence |
|---|---|---|
| `main` | Earlier CLI/mission foundation; does not yet contain the integrated dashboard stack | Default branch at PR #64 base `42c82e9e441fe51362abcf7bbb9b832005120f6f` |
| PR #64 | Open, not merged; integration of post-#18 stack plus PR #19 clock fence and multi-profile work | [PR #64](https://github.com/ReactionLabs/sam/pull/64), head `129c71f35e0859457540546cd16d574f88cfd9d9`, 58 files |
| PR #64 CI | Passed on Node 22 and Node 24; build and test steps succeeded | [Run #42550646841](https://github.com/ReactionLabs/sam/actions/runs/42550646841); PR author reports 107/107 tests |
| PR #65 | Draft, open, not merged; strict validation of persisted MCP connector registry; based on PR #64 | [PR #65](https://github.com/ReactionLabs/sam/pull/65), head `24dc4a69e7ad6819a7e7d7be2c3124a4b453cd67` |
| PR #65 CI | Passed on Node 22 and Node 24; build and test steps succeeded | [Run #42551687637](https://github.com/ReactionLabs/sam/actions/runs/42551687637); PR author reports 108/108 tests on each version |
| Current branch | PR #66, based on PR #65; prior head passed 115/115 on Node 22/24; latest memory-recall query-bound fix awaits CI | [PR #66](https://github.com/ReactionLabs/sam/pull/66), latest code `866be83f072ab2d4debaf0def1bdc86c16c588e9` |

PR #64's integration description says its stack includes the Mission Control dashboard, chats, branches, agent profiles, connector UI, model conversation, memory/workspace tools, skills, research team, and PR #19's offline-runner clock fence. The individual stacked PRs remain open in GitHub; do not merge them independently while #64 is the integration path.

PRs #13 and #17 are merged, and PR #18 is merged as the integration of #10-#17. PRs #14-#16 remain open as stacked historical branches; PR #18 is the integration record for that scheduler stack. PR #19 is folded into PR #64 and should not be merged separately.

## Verified capabilities on the integration stack

- **Dashboard exists:** local Mission Control on `127.0.0.1`, randomized URL token, persistent chats, chat branching, named agent profiles, model chat, status panels, and connector management.
- **Dashboard connector chat:** model-selected read-only MCP calls are available when a profile is pinned to an authorized connector. Dashboard chat does not yet call local SQLite memory or workspace file tools.
- **Live terminal chat:** OpenAI-compatible/MiniMax model transport with bounded in-process conversation context.
- **Memory:** SQLite persistence, provenance, source/content hash, CLI add/list/search/archive, and opt-in model-selected read-only `memory_search` on PR #64. This branch adds `memory_list` and approval-gated `memory_add`.
- **Workspace:** opt-in, bounded read-only list/read/search and skill inspection; protected-path, traversal, symlink, and size checks are covered by tests in the integration stack.
- **Skills:** project-local `SKILL.md` list/find/show/read; instructions are returned as untrusted text, never executed.
- **Research team:** bounded Research/QA/SAM model workflow; optional workspace evidence, Brave Search snippets, and read-only agent tools.
- **MCP:** local connector registry, environment-backed credentials, exact endpoint host allowlist, and read-only tool allowlist.
- **Mission foundations:** durable mission/task state, leases, local daemon IPC, and deterministic offline echo execution. No general autonomous mission worker.

## This build cycle: owner-approved model memory writes

Branch: `feat/approved-model-memory-write-20261109`, based on PR #65.

### Implemented in code, awaiting CI

- Added `memory_list` to the bounded model tool registry.
- Added opt-in `memory_add`, advertised only when the owner starts `talk --live --memory-write`.
- Every write proposal is shown in the local terminal and requires a separate owner confirmation. Missing approval callback or a declined prompt fails closed.
- The model can choose only `kind` and `content`. The runtime validates the four allowed kinds, rejects extra fields, bounds content to 2,000 characters, and assigns provenance itself.
- Common credential patterns are rejected before owner confirmation. This is defense in depth, not a guarantee that all sensitive information can be detected.
- Successful writes return the actual persisted record ID and include that ID in the durable agent-loop audit event.
- `memory_list` now applies a ten-row SQL `LIMIT` rather than loading the entire memory table and slicing afterward. `MemoryStore.list` accepts a validated limit capped at 1,000 rows. Explicit `--with-memory` recall now passes its requested row limit to SQLite instead of fetching the default list and slicing in process.
- Added tests for explicit opt-in, approval, denial, missing approval handler, credential rejection, provenance, SQLite reopen persistence, bounded list queries, and conditional tool advertisement.
- Corrected SAM's default identity so it describes capabilities as session-scoped instead of claiming all file/memory tools are unavailable; `talk --live` now injects an accurate tool-capability contract before user messages. Updated identity tests.

### Not yet verified

- First CI run [#42552720833](https://github.com/ReactionLabs/sam/actions/runs/42552720833) exposed an existing over-escaped loopback hostname regex in `completeToolTurn`; Node 22 tests failed at the new mock-provider test and Node 24 was cancelled.
- Fixed the regex in commit `91cedf16`. Head `7e3118ed` passed [run #42552804697](https://github.com/ReactionLabs/sam/actions/runs/42552804697): Node 22 **113/113**, Node 24 **113/113**.
- Added a SQL-level row limit for model memory listing and tests for bounded queries and missing approval handlers. Head `c747eae` passed [run #42553001709](https://github.com/ReactionLabs/sam/actions/runs/42553001709): Node 22 **115/115**, Node 24 **115/115**.
- Follow-up commit `866be83` applies the same query-level limit to explicit memory recall; its CI run is pending.
- Windows Node 22/24 build and tests are pending.
- Real MiniMax tool-call compatibility is pending.
- Owner acceptance is pending: approve one memory write in a live session, exit, start a fresh process, read the exact record, then verify a denied proposal creates no record.
- Model memory update and delete/archive tools are not implemented. The CLI's existing archive command remains a separate manual operation.

## Capability boundaries

| Capability | Current status | Boundary |
|---|---|---|
| Local dashboard and durable chat | Implemented on PR #64 stack; CI green | Not yet on main; no persistent background worker |
| Agent profiles and chat branches | Implemented on PR #64 stack; CI green | Profiles are not independent Agent Boxes |
| Live MiniMax chat | Owner previously verified on an earlier Windows branch | Re-test against the exact current integration head |
| Model memory search | Implemented on PR #64 stack; CI green | Read-only search only |
| Model memory list | Added on current branch; CI pending | Read-only, bounded to ten recent records |
| Model memory add | Added on current branch; CI pending | Explicit per-write local owner confirmation |
| Model memory update/delete | Planned | Requires action-bound approval and audit |
| Local workspace list/read/search | Implemented on PR #64 stack; CI green | Explicit opt-in, read-only, bounded |
| Model shell/computer control | Not implemented | No unrestricted shell or remote PC control |
| MCP connector read calls | Implemented on PR #64 stack; PR #65 hardening CI green | Read-only allowlist; not a universal MCP manager |
| Agent Box isolation | In progress in separate PR chain | PRs #40/#42/#48/#57/#59/#62/#63 are not included in #64; no live two-box verification |
| Skill discovery/read | Implemented on PR #64 stack; CI green | No install/update/remove/activation or arbitrary skill execution |
| Durable autonomous mission loop | Planned/in progress foundations | Scheduler/leases and journal exist; no verified browser-independent worker loop |
| Obsidian, Agent Reach, Blender, channels, webhooks, Tailscale | Planned | No connection or adapter should be described as active |

## Current blockers

1. The integrated dashboard stack is still an open PR, not main.
2. The previous code head passed Node 22/24 CI; the latest memory-recall query-bound fix needs its own run. Windows owner verification and live MiniMax tool-call verification remain pending.
3. Dashboard chat still lacks the local memory/workspace tool loop.
4. Multi-profile configuration is not equivalent to independent Agent Boxes. Current profiles share workspace-level stores, connectors, and process environment.
5. Do not install untrusted skills or Agent Reach dependencies, add credentials, expose the dashboard, merge, or deploy without owner approval.

## Next single assignment

**Verify and harden the owner-approved memory write vertical slice.**

- **Targets:** `src/memory-tool.ts`, `src/openai-compatible.ts`, `src/cli.ts`, `src/memory-tool.test.ts`, `src/openai-compatible.test.ts`.
- **Acceptance:** Node 22/24 CI green; Windows build and full tests green; MiniMax actually requests `memory_add`; owner approval writes a record with runtime provenance; a fresh `talk --live` process can retrieve it; declining approval writes nothing; credential-like input is rejected; audit contains the persisted record ID.
- **Dependencies:** PR #64 integration stack and PR #65 connector hardening.
- **Ready:** owner-approved memory-write path and bounded memory-list/recalI changes are staged; the previous code head passed Node 22/24 CI.
- **Not ready:** latest-head CI, live MiniMax verification, Windows owner acceptance, merge.

After this passes, connect the **existing** dashboard chat to the same memory/workspace tool router with explicit owner-controlled read grants and approval-gated memory writes. Do not build a second dashboard.

## Longer roadmap

- Complete independent Agent Box identity, storage, connector credentials, grants, and cross-instance denial tests.
- Add approved memory update/archive operations and verified episodic outcome capture.
- Add the durable asynchronous mission loop with lease recovery, bounded budgets, approvals, and persistent activity/outbox.
- Complete the standards-based Skill Engine: inspect, approve, stage, test, version, activate, update, disable, rollback, and remove Agent Skills. Research the exact Agent Reach upstream and its Windows, license, dependency, and security requirements before adapter work.
- Add optional Obsidian vault access with explicit folder authorization, conflict-safe writes, backups, and vault-specific grants.
- Add signed webhook inbox/wakeups and optional Tailscale Serve for private access. Funnel, if ever used, is restricted to a separate webhook ingress and never the dashboard or command API.
- Add application adapters beginning with Blender's documented background Python API after supervised file/command tools and the mission loop are verified.
- Later: channels, voice, coding-agent CLI adapters, and optional desktop packaging.

No roadmap item is shipped until its tests and actual end-to-end acceptance are verified.

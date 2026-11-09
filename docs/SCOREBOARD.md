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
| PR #66 | Open draft, stacked on #65; owner-approved terminal memory writes and bounded memory list | [PR #66](https://github.com/ReactionLabs/sam/pull/66), latest tested source head `fd474ed0373df9e7aa81c41646050cc2b6e585bf`, [run #42553391897](https://github.com/ReactionLabs/sam/actions/runs/42553391897), 115/115 on Node 22 and Node 24 |
| PR #67 | Open draft, based on #64; per-box mission/memory/chat/profile storage namespaces; not in the #66/#68 stack | [PR #67](https://github.com/ReactionLabs/sam/pull/67), head `b723f90313ebfaee5d6feafb4978916a81268c50`, [run #42556313860](https://github.com/ReactionLabs/sam/actions/runs/42556313860), 113/113 on Node 22 and Node 24 |
| Current branch / PR #68 | Open draft, stacked on #66; connects the existing dashboard main chat to opt-in read-only memory/workspace tools | [PR #68](https://github.com/ReactionLabs/sam/pull/68), latest tested code head `44651649925d9e76b071d277da2eed797aeec38e`, [run #42558439222](https://github.com/ReactionLabs/sam/actions/runs/42558439222), 117/117 on Node 22 and Node 24; later commits are documentation-only |

PR #64's integration description says its stack includes the Mission Control dashboard, chats, branches, agent profiles, connector UI, model conversation, memory/workspace tools, skills, research team, and PR #19's offline-runner clock fence. The individual stacked PRs remain open in GitHub; do not merge them independently while #64 is the integration path.

PRs #13 and #17 are merged, and PR #18 is merged as the integration of #10-#17. PRs #14-#16 remain open as stacked historical branches; PR #18 is the integration record for that scheduler stack. PR #19 is folded into PR #64 and should not be merged separately.

## Verified capabilities on the integration stack

- **Dashboard exists:** local Mission Control on `127.0.0.1`, randomized URL token, persistent chats, chat branching, named agent profiles, model chat, status panels, and connector management.
- **Dashboard connector chat:** model-selected read-only MCP calls are available when a profile is pinned to an authorized connector. PR #64's baseline main chat is text-only; PR #68 adds opt-in local SQLite memory and bounded workspace tools for the built-in SAM profile, with durable chat/journal audit. PR #68 is unmerged; its Node 22/24 CI passed 117/117 tests per version.
- **Agent Box storage:** PR #67 adds separate box-scoped databases/workspaces for mission, memory, chat, and profiles, with two-box persistence tests; it is open and separate from the #66/#68 stack. Credential/process isolation is not implemented.
- **Live terminal chat:** OpenAI-compatible/MiniMax model transport with bounded in-process conversation context.
- **Memory:** SQLite persistence, provenance, source/content hash, CLI add/list/search/archive, and opt-in model-selected read-only `memory_search` on PR #64. This branch adds `memory_list` and approval-gated `memory_add`.
- **Workspace:** opt-in, bounded read-only list/read/search and skill inspection; protected-path, traversal, symlink, and size checks are covered by tests in the integration stack.
- **Skills:** project-local `SKILL.md` list/find/show/read; instructions are returned as untrusted text, never executed.
- **Research team:** bounded Research/QA/SAM model workflow; optional workspace evidence, Brave Search snippets, and read-only agent tools.
- **MCP:** local connector registry, environment-backed credentials, exact endpoint host allowlist, and read-only tool allowlist.
- **Mission foundations:** durable mission/task state, leases, local daemon IPC, and deterministic offline echo execution. No general autonomous mission worker.

## This build cycle: owner-approved model memory writes

Branch: `feat/approved-model-memory-write-20261109`, based on PR #65.

### Implemented and Node 22/24 CI verified

- Added `memory_list` to the bounded model tool registry.
- Added opt-in `memory_add`, advertised only when the owner starts `talk --live --memory-write`.
- Every write proposal is shown in the local terminal and requires a separate owner confirmation. Missing approval callback or a declined prompt fails closed.
- The model can choose only `kind` and `content`. The runtime validates the four allowed kinds, rejects extra fields, bounds content to 2,000 characters, and assigns provenance itself.
- Common credential patterns are rejected before owner confirmation. This is defense in depth, not a guarantee that all sensitive information can be detected.
- Successful writes return the actual persisted record ID and include that ID in the durable agent-loop audit event.
- `memory_list` now applies a ten-row SQL `LIMIT` rather than loading the entire memory table and slicing afterward. `MemoryStore.list` accepts a validated limit capped at 1,000 rows. Explicit `--with-memory` recall now passes its requested row limit to SQLite instead of fetching the default list and slicing in process.
- Added tests for explicit opt-in, approval, denial, missing approval handler, credential rejection, provenance, SQLite reopen persistence, bounded list queries, and conditional tool advertisement.
- Corrected SAM's default identity so it describes capabilities as session-scoped instead of claiming all file/memory tools are unavailable; `talk --live` now injects an accurate tool-capability contract before user messages. Updated identity tests.

### Remaining owner acceptance

- First CI run [#42552720833](https://github.com/ReactionLabs/sam/actions/runs/42552720833) exposed an existing over-escaped loopback hostname regex in `completeToolTurn`; Node 22 tests failed at the new mock-provider test and Node 24 was cancelled.
- Fixed the regex in commit `91cedf16`. Head `7e3118ed` passed [run #42552804697](https://github.com/ReactionLabs/sam/actions/runs/42552804697): Node 22 **113/113**, Node 24 **113/113**.
- Added a SQL-level row limit for model memory listing and tests for bounded queries and missing approval handlers. Head `c747eae` passed [run #42553001709](https://github.com/ReactionLabs/sam/actions/runs/42553001709): Node 22 **115/115**, Node 24 **115/115**.
- Follow-up commit `866be83` applies the same query-level limit to explicit memory recall. The latest tested head `fd474ed0` passed [run #42553391897](https://github.com/ReactionLabs/sam/actions/runs/42553391897): Node 22 **115/115**, Node 24 **115/115**; both build and test steps succeeded. A subsequent status-only sync leaves source code unchanged.
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
| Model memory list | Implemented on PR #66; Node 22/24 CI green | Read-only, bounded to ten recent records |
| Model memory add | Implemented on PR #66; Node 22/24 CI green | Explicit per-write local owner confirmation |
| Model memory update/delete | Planned | Requires action-bound approval and audit |
| Local workspace list/read/search | Implemented on PR #64 stack; CI green | Explicit opt-in, read-only, bounded |
| Model shell/computer control | Not implemented | No unrestricted shell or remote PC control |
| MCP connector read calls | Implemented on PR #64 stack; PR #65 hardening CI green | Read-only allowlist; not a universal MCP manager |
| Agent Box isolation | Storage namespace slice in PR #67; Node 22/24 CI green at 113/113 | PR #67 is separate from #66/#68; no authenticated instance identity, process/credential isolation, or Windows two-box verification |
| Skill discovery/read | Implemented on PR #64 stack; CI green | No install/update/remove/activation or arbitrary skill execution |
| Durable autonomous mission loop | Planned/in progress foundations | Scheduler/leases and journal exist; no verified browser-independent worker loop |
| Obsidian, Agent Reach, Blender, channels, webhooks, Tailscale | Planned | No connection or adapter should be described as active |

## This build cycle: dashboard local read-only tool bridge

Branch: `feat/dashboard-local-tool-bridge-20261108`, draft PR [#68](https://github.com/ReactionLabs/sam/pull/68), stacked on PR #66.

### Implemented and Node 22/24 CI verified

- `dashboard --memory-tools` enables the existing bounded `memory_search` and `memory_list` model tools.
- `dashboard --workspace-tools` additionally enables bounded read-only `list_directory`, `read_file`, `search_files`, `list_skills`, and `read_skill`.
- `--tool-root` separates the filesystem grant from SAM's state workspace. Example: `--workspace C:\Projects\sam` plus `--tool-root C:\Projects`.
- The Agent Skills registry remains rooted in the SAM state workspace even when the file tool root is broader.
- Local tools are available only to the built-in SAM chat. Named profiles do not inherit these grants. Profile-pinned MCP connector chat remains a separate route.
- Tool request/completion/failure events are recorded in the existing chat activity feed and durable SQLite loop journal. The UI reloads the selected chat after a reply so the events appear immediately.
- Common credential-bearing filenames are blocked; common private-key, API-key, bearer-token, password, and token-like content patterns are withheld from file reads/searches. This is defense in depth, not a complete secret scanner.
- Dashboard local tools are read-only. No model memory writes, shell, arbitrary file writes, installs, or desktop actions are exposed.
- Added mock-provider tests for SQLite memory evidence, a separate file root, skill discovery from the state root, durable audit, and disabled-workspace-tool denial.

### Remaining owner acceptance

- PR #68 GitHub Actions run [#42558439222](https://github.com/ReactionLabs/sam/actions/runs/42558439222) passed build and **117/117 tests on Node 22 and Node 24**, including protected credential-path and content-withholding checks.
- Windows build and full test suite: pending.
- Live MiniMax dashboard tool-call acceptance: pending. No paid model call was made during this build cycle.
- The dashboard memory-write approval UI is not implemented. Terminal `--memory-write` remains the only model-proposed write path, and every terminal write requires local confirmation.

## Current blockers

1. The integrated dashboard stack is still an open PR, not main.
2. GitHub CI is green on Node 22/24; Windows owner verification and live MiniMax tool-call verification remain pending.
3. PR #68's Node 22/24 CI is green at 117/117 tests per version; Windows behavior and live MiniMax acceptance remain pending, and it is not on main.
4. PR #67 adds per-box storage but is not integrated into the #66/#68 stack; authenticated identity, process isolation, and credential isolation remain missing.
5. Do not install untrusted skills or Agent Reach dependencies, add credentials, expose the dashboard, merge, or deploy without owner approval.

## Next single assignment

**Run the Windows owner acceptance pass for PRs #66 and #68.**

- **Targets:** PR #66 terminal memory tools and PR #68 dashboard local tool bridge.
- **Acceptance:** On Node 22, run `npm ci`, `npm run build`, and `npm test`; repeat on Node 24 if installed. In terminal chat, approve one non-sensitive memory write, restart `talk --live`, and retrieve the exact record; decline a second proposal and verify no record exists. In Mission Control, verify memory search/list and workspace file read with `--workspace C:\Projects\sam --tool-root C:\Projects`; verify the skill registry still reads from the SAM state root; verify workspace calls are rejected when the flag is off; verify named profiles do not inherit local tools; inspect chat activity and `loop list` for durable evidence.
- **Dependencies:** PR #64 integration, #65 connector hardening, #66 terminal memory write, and #68 dashboard local tools.
- **Ready:** PR #66 Node 22/24 CI is green at 115/115; PR #68 Node 22/24 CI is green at 117/117 and its mock-provider tool/audit tests pass.
- **Not ready:** Windows owner verification, live MiniMax compatibility, dashboard memory-write approvals, merge.

Do not build another dashboard. After this acceptance pass, add a separate browser approval flow for dashboard memory writes, then continue the durable mission loop.

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

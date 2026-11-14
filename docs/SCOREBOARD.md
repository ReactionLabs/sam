# S.A.M. Scoreboard: what "better" means

Adopted 2026-11-14 (Dip's ruling: "Define what better is and just make it happen. I want to see Sam and it just feel like AGI."). This is the standing definition of better for S.A.M. (Secret Agent Man), measured against OpenClaw on the same tasks. Every consolidated landing report names the scoreboard deltas it moved. A dimension that has not been measured says so; estimates are never dressed up as measurements.

## The five dimensions

### 1. Knows you cold
Memory and standing law: zero re-explaining, corrections become law through the gate, zero cross-profile leaks.
Measured by: the growing recall eval battery; leak tests at zero.

### 2. Proves what it says
Perplexity-style citations with runtime honesty enforcement: fabricated citation rate zero, unsourced claims admitted plainly.
Measured by: the task battery's citation checks.

### 3. Does the work
Real multi-step owner tasks finished end to end without rescue, gated only where the owner's law requires a gate.
Measured by: completion rate and cost per task, Sam vs OpenClaw, same battery.

### 4. Is already there
Heartbeats and proactivity: Sam briefs the owner before being asked, and it is the same Sam with the same memory on every surface (dashboard, Telegram, next doors).
Measured by: cross-surface thread pickup; heartbeat signal quality.

### 5. Anyone can run it
Cold install by a stranger: clone to first useful answer in under 10 minutes with zero help.
Measured by: an actual cold walk in a clean environment, timed, not by reading the README.

## The experience bar ("feel like AGI")

When the owner opens Sam, Sam opens with his world: what changed, what needs him, what it already handled, every claim cited. He throws it a messy, spoken-style, multi-step ask and watches it execute across his systems in view. Next session, it remembers all of it. If a demo moment makes him explain something Sam should already know, that is a defect, logged like one.

## Current standings (2026-11-14, honest)

| # | Dimension | Standing |
|---|-----------|----------|
| 1 | Knows you cold | Partially measured. Recall battery growing (eval battery 24 tasks, incl. the governed consolidation case landed 2026-11-14). Cross-profile fences tested in the citation and memory suites; a dedicated leak battery is still owed. |
| 2 | Proves what it says | Chat-history citations live with fabricated-source rejection (#92, 2026-11-14). General source citations (files, commands, web) in build 2026-11-14. Fabricated-rate measurement on the task battery still owed. |
| 3 | Does the work | Not yet measured against OpenClaw. Internal signals: eval battery 24/24; self-work has landed 0 fixes in 3 cycles (each block honestly ledgered). Task battery is Program C. Parallel coding (Program E) LANDED 2026-11-14: a job is surveyed once, fanned out into slices that run the real engine concurrently in isolated git worktrees (bounded concurrency cap, per-slice budgets, one retry each), merged by a coordinator in declaration order, verified by the merged battery with bounded fix iterations, and goldfish-reviewed before it can close done; the push still goes through the owner's git-push approval, exactly as single-thread coding does. Proof on the box (scratch repo, real Codex, spec fixed in advance): an 11-slice job built a 23-file library (9 source modules, 9 test files, 2 docs, changelog, demo) green end to end in 268s at concurrency 4, with 1 coordinator fix iteration and a PASS review. Same job at concurrency 1 vs 4, back to back: 633s vs 242s (2.6x faster), identical outcome (done, 23 files, 1 fix iteration, PASS). Honest scale note: one small scratch library, not a production codebase, and still no OpenClaw comparison (Program C). The proofs also caught and fixed a platform defect in the shared engine runner: it left the child's stdin pipe open, and Codex reads stdin to EOF before starting on its argv prompt, so real Codex engine runs hung until their timeout; the runner now closes stdin at spawn, with a regression test. Owner-turn budgets fixed 2026-11-14 (Dip hit the defect live): BEFORE, a dashboard turn asking "What is the secret phrase" died on the 3-round / 6-call chat budget after 5 calls (memory_search, search_chats, workspace_list, memory_list, workspace_list again) and answered "I ran out of steps... this answer is incomplete. Ask me to continue." AFTER: owner surfaces (dashboard, Telegram, CLI chats) ride 30 rounds / 120 calls with automatic tranche continuation to a hard 60 round / 300 call guardrail ceiling that ledgers budget-guardrail and closes with a synthesis, never a dead end; identical repeat calls in a turn return the cached result instead of re-executing; visitor chats and scoped-door (mini) turns keep 3/6, heartbeat 2/4, background 6/16. Acceptance run on the box, fresh dip-profile dashboard chat, same question: 14 model invocations on the owner turn (13 tool rounds, past the old cap four times over) plus a nested linked-profile turn, finished sourced answer in one continuous run (the phrase, with two memory-record citations), 46 seconds, no budget message, no continue prompt. Orchestration (Program G) live proof, 2026-11-14: Sam now hires its own lane workers under one coordinator (src/orchestration.ts, engine tip 4109123, suite 1048/1048, deployed to the box and verified byte-identical). Five real team jobs ran end to end in scratch workspaces on the box, each touched once at the ask (Zorblax Field Kit one-pager: research + build + verify lanes). Research verified on attempt 1 in 5/5 jobs (five sourced facts from brief.md). The coordinator caught, by name: a build worker's mid-work narrative marked verified while NO file existed (run 2, proof repo confirmed empty; hardened a2a7f83: build lanes now require a checkable artifact, extracted from the landsAt sentence when needed); a verify lane returning no parseable verdict (run 2; hardened: verdict format is told to verify workers, verify budget 2 rounds); a research result naming no source, held unverified and never landed (run 2); a failed build worker's budget carve leaking and starving the verify lane (run 3: pool read "0 rounds, 0 calls left"; fixed 4109123: the worker id is recorded before the run settles, so a failed worker is retired and its carve returns). One build landed fully verified (run 3, attempt 2 after replacement: one-pager.md, 1,237 bytes, all five facts passing mustMention). On the final tip (runs 4 and 5, 13.6s and 22.3s wall), no pool exhaustion recurred and every false claim was rejected by name ("The claimed artifact does not exist"), but both jobs closed partial: the build lane's MiniMax worker is the binding constraint, failing most attempts with "Unsafe model output" (openai-compatible.ts: the reply's visible content sanitizes to nothing; research-role turns on the same model succeed 5/5). Honest standing: the orchestration machinery (plan, hire, replace, verify, consolidate) is proven; a full 3-lane close on the final tip is still owed and waits on worker-output reliability, not on coordinator fixes. Worker budgets ride the spawn pool {6 rounds, 16 calls}: research {2,5}, build {2,6}, verify {2,3}, coordinate {2,4}, general {2,4}; depth capped at 2 in code; one replacement per lane; submission idempotent by ask for 15 minutes. |
| 4 | Is already there | Heartbeat live on the box (15 min). Same-instance dashboard + Telegram behavior proven on a scratch instance 13/13 (#93 part B). The opening brief (Sam opening with the owner's world) is NOT built yet; it is the Program D reveal's core. |
| 5 | Anyone can run it | Not yet walked. Program B is running the first timed cold walk; target under 10 minutes, clone to first answered chat. |

## Release discipline (Program A)

First release under this cadence: **v0.2.0**, PR #94, main `945b834`, suite 997/997 measured on main itself (fresh clone, npm ci, build, full test) on 2026-11-14.

The cadence, standing from 2026-11-14:

- The engine branch (`dip/mita/sam-engine`) lands to main by pull request after each verified landing batch, and at least daily on active build days. Main never drifts a program behind again; a lag measured in weeks is a defect, reported like one.
- Every main landing is pristine-clone verified at the exact head SHA before merge (fresh clone, npm ci, build, full suite green), and the suite is re-measured on main itself after the merge.
- Versioning: patch bump per landing batch, minor bump per program milestone; each minor release is tagged on its main merge SHA.
- The README suite count is refreshed at every release landing from the on-main measurement, so public claims track the measured tree.

## Program status

- A. Release discipline (main stops lagging the engine branch): LANDED 2026-11-14 (PR #94; cadence above).
- B. Cold install (one-command path, timed cold walk): RUNNING 2026-11-14.
- C. Task battery (10-15 real owner tasks, Sam vs OpenClaw): queued behind A and B.
- D. The reveal (live dashboard session: Sam's opening brief on the owner's actual operation, cited, then live asks): staged when A to C are far enough that it will land.
- G. Orchestration (Sam hires, coordinates, and verifies its own lane workers; one consolidated result): LANDED 2026-11-14 (engine 4109123, suite 1048/1048, box-verified). Live proof: dimension 3 above. A full 3-lane close on the final tip is still owed; the blocker is worker-model output reliability, named there.
- E. Coding depth + parallel work (repo survey before slices are cut, fan-out into isolated worktrees, coordinator merge and battery, bounded fix iterations, goldfish diff review, git-push still owner-gated): LANDED 2026-11-14. Measured on the box with the real Codex engine in a scratch repo: 23-file job done in 268s at concurrency 4; serial vs parallel 633s vs 242s (2.6x) with identical outcomes. Detail in dimension 3 above. Its two proofs become Program C battery entries. Follow-up owed: a chat-side sam_parallel_task tool (queueing today is CLI plus the heartbeat drain).
---

# Historical build log (pre-2026-11-14, kept for the record)

## SAM build scoreboard (historical, pre-adoption)

Updated: 2026-11-08 UTC. This scoreboard describes the unmerged `feat/sam-model-output-hygiene-20261108` branch, not `main`.

## Verified by owner on Windows

- `npm run build`: passed on earlier `feat/model-conversation-contract` at `c6f47f8`.
- `npm test`: 55/55 passed on that earlier commit.
- `memory add observation ... --source owner-test`, `memory list`, and `memory search`: succeeded across separate CLI invocations.
- `talk --live` with MiniMax: worked but could not access SQLite memory and displayed `<think>` content.

## This sprint: code committed, tests pending

- `src/openai-compatible.ts`: redact complete embedded `<think>` blocks; reject incomplete or reasoning-only content.
- `src/openai-compatible.test.ts`: mock-provider regression tests for above.
- `src/memory.ts`: enumerate valid memory kinds in error messages.
- Test status: **NOT RUN** in the connected GitHub editing environment. No claim of passing CI or live MiniMax verification.

## Next single assignment

Implement a bounded and auditable model-to-memory bridge in `talk --live` using the existing `MemoryStore`, with explicit tool schemas and provenance, verified write/search in different processes, no tool authority from memory content, no false success reporting, and no unrestricted shell. Add Windows integration tests and documentation. Then add read-only discovery of standard `SKILL.md` from `.agents/skills` and `skills` with path and symlink controls.

## Longer roadmap (not implemented)

- Skills discovery/install/use/create/update and Agent Reach adapter.
- Authorized filesystem reading, approved shell actions, durable missions, dashboard, and Obsidian/Blender integrations.

## Skill discovery slice (2026-11-08, unmerged, tests pending)

- Implemented read-only `skills list` and `skills show <name>` CLI commands.
- Scans `.agents/skills/<name>/SKILL.md` and `skills/<name>/SKILL.md` within the chosen workspace.
- Validates bounded frontmatter, rejects symlinked paths, limits files to 64 KiB and registry to 200 entries, and does not execute instructions or installation scripts.
- Added Node tests for valid metadata, invalid/oversized files and symlink escape.
- **Not yet run in the connected GitHub-only editing environment.** No model skill invocation, installation, creation, or Agent Reach integration yet.
- Verify on Windows: `npm run build`, `npm test`, `node dist/cli.js skills list`.

## Follow-up sprint: installed skill search

- Added `skills find <query>` for case-insensitive matching of all query terms against name and description, without executing skill instructions.
- Added tests for matching, no matches, and invalid blank queries.
- GitHub CI for prior commit `723c364` passed (SAM CI run 42507066587). **The new search commit is awaiting its own CI result.**

## Read-only live memory recall slice (2026-11-08, unmerged)

- Added `talk --live --with-memory` to include bounded, provenance-labeled, untrusted SQLite memory records in model context with explicit user opt-in.
- Added tests for cross-instance persistence, provenance, and empty memory.
- No model memory write/search tool calls yet, and no automatic memory retrieval without owner opt-in.
- **Validation pending on new commit.** Prior owner Windows build passed 58/58 tests on the skill discovery branch, before this feature.
- Next: typed model-to-memory tool bridge, permission checks, bounded tool loops, and durable audit.

## Local memory search in terminal (2026-11-08)

- Added `/memory <query>` to `talk --live` for read-only SQLite search, up to ten results, bounded displayed content. No model call or memory write for the slash command.
- This is NOT model-selected tool calling. Validation on new branch pending; owner verified prior 60/60 tests and live opt-in recall.

## Native model-selected memory search (2026-11-08)

- Added opt-in `talk --live --memory-tools`, OpenAI-compatible `memory_search` tool declaration, bounded one-call router, strict JSON arguments, read-only SQLite results, and terminal audit events.
- Added offline mock tests for actual SQLite evidence, invalid tools/arguments and bounded call loop.
- **Not yet validated on Windows or MiniMax live.** No writes, shell, filesystem access, persistent tool audit, or retries.

## Workspace read tool sprint (2026-11-08)

- Added opt-in model tools `list_directory`, `read_file`, and `search_files` with bounded shallow reads and path checks. Existing `memory_search` retained.
- Tests added for valid operations and protected paths, traversal, symlinks and unauthorized tool names.
- **New branch not yet Windows/live verified**. Owner verified 64/64 tests and two successful live model-selected memory searches on parent branch.
- Next: verify on Windows, audit provider compatibility, improve path hardening, then Git read-only tools.

## Coding agent and delegated CLI roadmap (owner direction, 2026-11-08)

- **Goal:** SAM is a strong coding agent that can inspect, plan, patch, test and review work directly, or delegate scoped tasks to installed Codex CLI / Claude Code CLI.
- **Phase 1:** finish read-only workspace tools and add Git status/diff; verify on Windows.
- **Phase 2:** approval-gated local command adapter with executable allowlist, workspace confinement, timeouts, output caps, persisted stdout/stderr and explicit tool audit; no shell-string execution by default.
- **Phase 3:** Codex and Claude Code adapters with installation/version detection, per-task workspace, explicit permissions, cost/time limits, structured result and independent diff/test verification. Do not pass credentials to the model.
- **Phase 4:** skill/tool lifecycle: discover, inspect, propose, approve, install into workspace-local registry, pin versions/hashes, test, rollback and uninstall. Treat downloaded skill instructions and installation scripts as untrusted.
- **Phase 5:** SAM-authored skills via staged proposals and automated evaluation, never silent self-installation or unrestricted privilege escalation.
- **Acceptance:** SAM can fix a seeded bug with direct tools or delegated CLI, produce a reviewable patch, run verification, and report what was observed versus assumed.
- Windows test feedback: 65/66 passed on first workspace-tool branch; symlink test failed due to Windows EPERM during fixture setup. Test updated to tolerate permission denial; re-verification pending.

## Durable agent loop checkpoint sprint

- Added SQLite journal for goals, read-only tool events, progress, outcomes and explicit interrupted-orphan fencing.
- Integrated with live model tool loop and added CLI inspect/recover operations.
- No auto-replay or automatic resume. No coding writes or delegated CLI execution.
- Tests added for persistence, restart, monotonic progress and terminal-state fencing. Windows verification pending.

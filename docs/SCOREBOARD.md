# SAM build scoreboard

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

## 2026-11-08 19:37 UTC: owner-confirmed memory write slice

- Branch: `feat/sam-memory-write-consent-20261108`, stacked on unmerged `feat/sam-review-gate-20261108`.
- Added opt-in `talk --live --memory-write`, bounded typed `memory_add`, terminal exact-YES confirmation per record, SQLite provenance, and read-after-restart/denial tests.
- Files: `src/memory-tool.ts`, `src/openai-compatible.ts`, `src/cli.ts`, `src/memory-write.test.ts`.
- **Status: committed, unmerged, NOT VERIFIED** on Windows, CI or live MiniMax. No approval is granted by model output. No model-driven archive/update/delete.
- Test commands (PowerShell): `git fetch origin; git switch -c test-sam-memory-write origin/feat/sam-memory-write-consent-20261108; npm run build; npm test`. For opt-in live check: `node dist/cli.js talk --live --memory-tools --memory-write` and explicitly confirm a harmless test memory, then restart and ask model to search it.
- Next single assignment: validate Node 22/24 build and tests; fix regressions, verify MiniMax actually calls `memory_add` and `memory_search` across separate processes; then document observed evidence and add durable authenticated approvals.
- Remaining planned: dashboard, durable mission worker, skills invocation, Obsidian, Agent Reach, Blender, webhook gateway, Tailscale, supervised command runner. None verified by this sprint.


## Owner consent audit correction (2026-11-08, unmerged)

- Branch `fix/sam-memory-consent-audit-20261108`, stacked on `feat/sam-memory-write-consent-20261108` (PR #41).
- Fixed misleading `tool_completed` audit on explicitly denied `memory_add` proposals; emits `tool_denied` instead, with no SQLite insert.
- Added regression test checking exact requested/denied audit events and absence of persisted denied content after reopening SQLite.
- **GitHub changes committed, build/tests/CI and live MiniMax NOT VERIFIED in this run.** No change to owner approval requirements or shell permissions.
- Next: Windows `npm run build && npm test`; live `talk --live --memory-tools --memory-write` owner-approved write, exit, reopen and search, then denied write audit inspection. Do not merge before verification.

## 2026-11-08 21:38 UTC: denial audit regression hardening

- Branch: `fix/sam-memory-consent-audit-20261108`, still unmerged.
- Commits: `5e626df`, `611083a`. Added an integration-style mock model-turn test asserting the exact audit sequence `requested -> denied`, no `completed`, a structured `saved:false` tool result delivered back to the model, and absence of the denied record from SQLite search.
- Verification: GitHub source edits only; **build, test and live MiniMax verification NOT RUN** in this environment. Previous owner Windows results belong to earlier branches and cannot certify this branch.
- Blocker: Windows owner or CI must run `npm run build`, `npm test`, then approved/denied live memory cases.
- Next single assignment: complete Windows build and owner-confirmed live write/restart/search/denial test, then integrate the audited memory tool bridge into dashboard chat without granting unattended writes.

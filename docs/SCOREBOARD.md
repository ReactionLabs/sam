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

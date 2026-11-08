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

## Autonomous mission loop acceptance gate

After live chat and scoped tools work, build a durable worker independent of browser sessions. Persist mission queue, leases/checkpoints, bounded steps/time/token budgets, approval pauses, cancellation and recovery. Every step must append to a persistent outbox/activity feed. Acceptance: enqueue via chat, close browser, observe continued progress, reopen to see events, restart daemon and verify recovery. Running machine is required. **Status: planned, not tested.**

## Desktop application adapter acceptance gate

Prefer documented native APIs and CLI before GUI automation. First target: Blender discovery/version check, bounded `blender --background --python` execution, create low-poly mesh/materials, save editable `.blend`, export `.glb`, render `.png`, inspect and verify artifacts, then document a reusable `SKILL.md` with evidence. Blender installation and any new dependencies require owner approval. GUI automation is a later, separately permissioned capability. **Status: planned, not tested.**

## Obsidian vault adapter acceptance gate

**Status: planned, not implemented or tested.** Obsidian is a first-class local knowledge integration, not SAM's operational memory database. Implement after the live-chat memory/tool vertical slice and initial durable mission loop.

- **Connection:** Dashboard and main chat let owner select a local Markdown vault directory and explicitly grant scoped read/write permissions per agent. No silent discovery/indexing or writes. Test/disconnect flow shows accurate status; no Obsidian plugin required.
- **Safety:** Canonicalize paths and reject traversal, symlink escapes, protected files, secrets and unauthorized attachment access. Bound note sizes, search output and index scope. No arbitrary executable content from notes becomes instructions.
- **Markdown fidelity:** Preserve YAML frontmatter, wikilinks, attachments and folder layout without reformatting unrelated content. Create/edit/move only within approved vault scope, with atomic writes, revision preconditions, backups and audit.
- **Sync:** Incrementally index changes; detect user edits and refuse stale writes rather than overwrite them. Treat vault text as untrusted source material. SAM SQLite mission/operational memory continues working when vault is disconnected.
- **Verification:** Use a disposable vault fixture. Connect, read/search, create/edit/move, restart SAM, verify persistence; test concurrent edit conflicts, path/symlink escapes, secret exclusion, permissions and disconnect. Optional skill/learning export only with owner authorization.

## Agent Skills and Agent Reach acceptance gate

**Status: planned, not implemented or verified.** SAM's Windows workspace is `C:\\Projects\\sam`. Follow the Agent Skills `SKILL.md` convention rather than creating an incompatible SAM-only format.

- **Discover:** Bounded, symlink-safe scanning of `.agents/skills/` and `skills/`, plus verified actual installation destinations for `npx skills add https://github.com/vercel-labs/skills --skill find-skills`. Reject traversal, duplicate/ambiguous names and malformed frontmatter; show name, description, provenance and permissions. Provide `skills list` and `skills show` CLI first.
- **Use:** Load skill instructions as untrusted data and invoke actions only through SAM's scoped, auditable, permissioned tool router. Installed skill does not mean callable tool. Test prompt-injection and denial paths.
- **Create:** Generate draft `SKILL.md` from evidenced task outcomes, validate and test in disposable workspace, version and propose activation. No self-authorized privilege expansion.
- **Agent Reach:** Evaluate [Panniantong/agent-reach](https://github.com/Panniantong/agent-reach) upstream license, Windows support and external dependencies. Prefer per-tool adapters and dry-run inspection; no automatic installer, secret copying or network publication.
- **Verification:** Windows-compatible fixture tests for discovery, duplicates, symlinks, permissions, restart and skill-use execution evidence. No claims of install or integration before testing.

## Roadmap after this milestone

- Local-first Control Center: main chat, sidechats, agents/teams, missions, approvals and settings.
- Scoped filesystem actions, supervised commands, coding CLI adapters.
- Extensible capability registry: MCP, Agent Skills/SKILL.md, skills.sh, OpenAPI, custom CLI/API tools and channels.
- Episodic memory: outcomes, failures, evidence, retrieval; self-authored versioned skills promoted only after tests and owner approval.
- Durable cron/heartbeat/watchers and signed webhook-triggered wake-ups.
- Optional Tailscale Serve for private dashboard; Funnel only for isolated webhook ingress. No public exposure by default.
- Optional desktop wrapper and managed hosting later. SAM remains generic and self-hostable.

## Sprint history

| 2026-11-08 12:42 ET | Inspected main CLI/memory/README and existing scoreboard branch. Added concrete Agent Skills/Agent Reach acceptance gate and corrected malformed sprint-history row; no runtime code changed. | GitHub source inspection only; build/tests not run. | Integrate live MiniMax model with bounded, audited memory tool dispatcher on the correct model branch. |



| Date | Outcome | Verification | Next |
| 2026-11-08 11:43 ET | Inspected main, open PRs and existing scoreboard. Added Obsidian vault integration acceptance gate and corrected sprint table formatting on review branch; no runtime change. | GitHub source inspection; no local build/tests. | Wire live-chat memory tools and cross-process verification. |
| 2026-11-08 10:38 ET | Rechecked main README, latest main commit, open PRs and existing scoreboard PR #23. Added explicit mission-loop and Blender acceptance gates to the existing review branch; no runtime code changed. | GitHub source inspection only; no build/tests run. | Live-chat memory tools on canonical model branch. |
| 2026-11-08 | Inspected main README, CLI/memory source and open PRs; proposed scoreboard and README update in review branch. No runtime feature claimed. | GitHub source review only; no local build or tests. | Live-chat memory tool integration. |

**Rule:** Never confuse a PR, a local build, or a plan with shipped default-branch behavior. No forced commit quota. Record blockers and no-change cycles honestly.

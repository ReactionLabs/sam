# S.A.M. | Secret Agent Man

**A local-first commander for an AI agent workforce.**

SAM is a TypeScript/Node.js project with a CLI and a browser-based local Mission Control dashboard. The product direction is a permissioned, persistent workforce that can inspect a workspace, use approved capabilities, coordinate agents, and complete bounded missions. SAM is not yet an autonomous computer operator.

## Current build status

The dashboard is real and already exists on the integration branch. The current work is connecting its existing runtime pieces safely, not starting another dashboard project.

- **Main:** still contains the earlier CLI and mission-runtime foundation.
- **Integration PR [#64](https://github.com/ReactionLabs/sam/pull/64):** folds the post-#18 feature stack into main, including Mission Control, durable chats and branches, agent profiles, model chat, skills discovery, bounded CLI memory/workspace tools, research-team workflows, MCP connectors, and the offline-runner clock fence. It is open and unmerged.
- **Connector hardening PR [#65](https://github.com/ReactionLabs/sam/pull/65):** validates the persisted MCP connector registry before credential use. It is a draft stacked on #64 and is also unmerged.
- **Current build branch:** adds an explicitly opted-in model memory write tool. Each proposed write requires a local owner confirmation. The latest branch head passed GitHub Actions run [#42553221250](https://github.com/ReactionLabs/sam/actions/runs/42553221250) on Node 22 and Node 24 with 115/115 tests each. Windows and live MiniMax verification are still pending.

Do not treat any unmerged PR as part of main. Do not merge or deploy without owner approval.

## What exists on the integration stack

### Mission Control dashboard

Start it from the SAM workspace:

```powershell
node dist/cli.js dashboard
```

The server binds to `127.0.0.1` and prints a randomized local URL. The dashboard includes:

- Persistent chat histories in `.sam/chats.db`
- Separate chat branches with copied history
- Named agent profiles and per-chat profile selection
- Profile-level model and optional MCP connector selection
- Mission, skill, schedule, agent, connector, and recent activity status
- A main chat that calls the configured model
- Optional model-selected, read-only MCP connector tools when a connector is configured and selected

The dashboard chat does **not** yet call the local SQLite memory or workspace file tools. It does not run missions, spawn persistent workers, execute shell commands, stream tokens, or install skills. Stored schedules are not an autonomous scheduler. The local URL token is not multi-user authentication or an OS sandbox. Keep the dashboard on loopback.

### Live model chat and bounded tools

Configure a supported OpenAI-compatible endpoint or MiniMax, then use:

```powershell
node dist/cli.js talk --live
```

The terminal chat keeps a bounded in-memory conversation for the current process. It does not persist the transcript. SAM's system identity now describes only the capabilities explicitly enabled for that session; tool-enabled sessions receive a separate capability contract before user messages. No general shell or desktop-control access is implied.

On the integration stack:

- `--memory-tools` enables model-selected read-only SQLite memory search.
- `--workspace-tools` additionally enables bounded read-only directory listing, file reads, file search, and reading installed skill instructions as untrusted reference material.
- The model tool loop is limited to four rounds and eight calls per user turn, with no more than three calls in one model response.
- Tool activity and outcomes are recorded in the local SQLite agent-loop journal. Restart recovery marks an unfinished loop interrupted; it never replays tool calls automatically.
- Embedded `<think>` reasoning blocks are removed from user-facing model replies; incomplete or reasoning-only output is rejected.

The current branch adds:

- `memory_list` for bounded, read-only retrieval of recent records.
- `--memory-write` to advertise `memory_add` to the model.
- A local confirmation prompt for **every** proposed memory write.
- Runtime-owned provenance. The model cannot choose the record's source.
- Validation of the memory kind and content size, plus rejection of common credential patterns before owner confirmation.
- A success response containing the persisted record ID, and a durable audit event containing that ID.

A model proposal is not a saved record. If the owner declines, the tool returns a denial and no record is written. GitHub Actions passes 115/115 tests on Node 22 and Node 24 on the latest branch head. Windows verification and the live MiniMax acceptance test are still pending. Memory update/delete through model tools is not implemented.

### Memory

The SQLite memory store supports durable `memory add`, `memory list`, `memory search`, and soft `memory archive` CLI operations. List queries are capped at 100 records by default (hard maximum 1,000); the model-facing list tool requests only ten, and explicit context recall passes its requested limit directly to SQLite. Records include provenance and a SHA-256 source/content hash. Memory is evidence, never authority over policy. Treat retrieved memory as untrusted data.

### Workspace and coding tools

The integration stack includes explicit-root, read-only local inspection, bounded model-selected workspace reads, read-only Git status/diff, AI-assisted edit proposals and reviews, and a digest-confirmed local edit apply flow. A separate approved build/test runner is limited to known project operations and is **not** an OS sandbox.

There is no general-purpose model shell, arbitrary command runner, remote computer control, or unrestricted filesystem write capability. A selected workspace root does not authorize access to secrets or unrelated folders.

### Skills

The CLI can discover, search, show, and read standard project-local `SKILL.md` files under:

- `.agents/skills/<name>/SKILL.md`
- `skills/<name>/SKILL.md`

Discovery is bounded and rejects unsafe paths and symlinks. Skill content is untrusted reference material. The model may inspect skill metadata/instructions when workspace tools are explicitly enabled, but a skill is **not** automatically a callable tool.

Skill install, update, enable/disable, removal, sandbox testing, self-authored skill promotion, and Agent Reach integration are not implemented.

### Agents, teams, connectors, and missions

- Agent profiles can pin a model and one connector. A profile is not yet an independent Agent Box with isolated memory, credentials, and process environment.
- The bounded research-team command makes separate Research, QA, and SAM model calls and stores attributed events in a durable chat. Optional workspace evidence, bounded Brave Search snippets, and read-only workspace tools are explicit flags. This is not persistent autonomous delegation.
- MCP connectors use environment-backed credentials, an exact host allowlist, and a read-only tool allowlist. The browser never receives the credential value. PR #65 adds strict validation of the saved connector registry. This is not a general MCP capability manager or a hardened multi-tenant credential vault.
- Missions, tasks, leases, and an offline deterministic echo runner are durable. The daemon is a local control IPC process, not yet an asynchronous mission worker that continues plan/act/evaluate loops independently of the browser.

## Quick start

From a checkout of the integration branch:

```powershell
npm ci
npm run build
npm test
node dist/cli.js init
node dist/cli.js dashboard
```

For MiniMax, keep the key in the local PowerShell process environment. Do not put it in a source file, chat, screenshot, or GitHub issue:

```powershell
$env:SAM_MODEL_PROVIDER = "minimax"
$env:SAM_MODEL = "MiniMax-M2"
$env:MINIMAX_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "MiniMax API key" -AsSecureString)).Password
node dist/cli.js talk --live
```

Opt-in tool examples on the current feature stack:

```powershell
node dist/cli.js talk --live --memory-tools
node dist/cli.js talk --live --workspace-tools
node dist/cli.js talk --live --memory-write
node dist/cli.js skills list
node dist/cli.js skills find "research"
node dist/cli.js loop list
```

Model requests may incur provider charges. Read-only workspace results and memory records may be sent to the configured model provider when those tools are enabled. The `--memory-write` flag does not silently save anything: each write requires an explicit local confirmation.

## Verify

```powershell
npm run build
npm test
```

The integration PR and connector-hardening PR have successful Node 22/24 GitHub Actions runs. The current memory-write branch has not yet received its own CI result. A green CI run does not replace the owner's Windows live MiniMax acceptance test.

## Safety boundaries

- No secrets in Git, prompts, screenshots, memory, or connector configuration.
- Memory and skill instructions are untrusted data, never policy.
- Model tools are allowlisted, schema-validated, and bounded.
- Workspace tools are read-only and root-scoped.
- Model-proposed memory writes require an explicit local owner decision.
- MCP calls are read-only and use credentials held in the local SAM process environment.
- The dashboard stays on loopback. Do not expose it publicly.
- No unapproved installs, privilege expansion, external publishing, spending, merging, or deployment.

## Next milestones

1. Verify the owner-approved live memory write/read flow on Windows with MiniMax, including a fresh-process read and denied-write test.
2. Connect the existing dashboard chat to the same scoped local memory/workspace tool router with explicit owner-controlled grants and durable audit.
3. Complete true per-Agent-Box identity, memory, connector, and credential isolation before claiming multi-instance isolation.
4. Add memory update/archive tools through action-bound owner approval.
5. Build the durable background mission loop, then the standards-based Skill Engine and reviewed Agent Reach adapter.
6. Add optional Obsidian vault access, webhook wake-ups, Tailscale Serve, and later application adapters such as Blender only after the core permission model is verified.

## Follow the build

- [Open pull requests](https://github.com/ReactionLabs/sam/pulls)
- [Commit history](https://github.com/ReactionLabs/sam/commits/main/)
- [GitHub Actions](https://github.com/ReactionLabs/sam/actions)
- [Build scoreboard](docs/SCOREBOARD.md)

SAM is independent of Second Shift. Second Shift is one possible read-only MCP connector, not a required dependency.

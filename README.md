# S.A.M. | Secret Agent Man

**A local-first personal agent that lives on your own machine and works only for you.**

SAM is a running service, not a demo. One install serves its owner: it
remembers what it learns, follows standing law the owner sets, does timed
work on heartbeats, and proposes anything consequential for approval before
it acts. A scoped copy of SAM (a "mini" in the registry; to its person it is
simply their SAM) can serve one person or client with only that person's
profile, data source, law, and chats, invisible to every other mini. That is
the shape client chatbots ship in.

The code is public on purpose. The moat is the running sovereign service,
the wiring, and the clients, not the source. Nothing secret lives in this
repo: only `.env.example` is tracked, and real credentials live in the
install's own env files.

## The live turn

Every surface (dashboard chat, per-mini web door, heartbeat job, background
task) runs the same turn, `runChatTurn`. What it can do today:

- **Profiles.** Named agents, each with its own instructions, standing
  files (persona, owner brief, ops notes, assembled in prompt tiers), model
  pin, and one pinned MCP connector. Per-route model tiers (cheap polls,
  main chat, deep background) resolve under an explicit pin.
- **Memory and law.** Preferences and standing law are captured from the
  owner's own words, scoped per profile, and injected into every turn; a
  correction becomes a proposed law through the approval gate instead of
  washing past. Episodic summaries record what happened in each profile's
  chats each day. Memory search is scope-fenced: one profile never sees
  another's records.
- **SAM's own tools in chat.** Scoped memory search/list, confined
  workspace list/read (secrets, env files, keys, and binaries refused),
  skill list/read, public skill search, background handoffs, and action
  proposals. Tool budgets tier by route and exhaust gracefully: SAM answers
  from partial results instead of dying mid-turn.
- **One approval gate.** Actions (memory note, standing law, heartbeat
  job, a post into an own chat, a draft, a skill install) execute only
  after the owner approves, in the dashboard or by CLI. In-chat approval
  cards decide in place and stay in the thread's history.
- **Skills.** Installed skills are catalogued in the system prompt (names
  and descriptions only); when a task matches one, SAM reads and follows
  it unprompted and says which skill it is using. New skills install from
  the public directory behind the same approval gate.
- **Connectors.** Read-only MCP tool sets behind a default-deny policy,
  pinned per profile. A profile with a connector still carries SAM's own
  tools under one shared budget.
- **Heartbeats.** Timed jobs per profile whose output is diffed against
  the last run (normalized text plus an extracted fact signature): silence
  when nothing changed, delivery plus an activity entry when it did.
- **Background work.** A chat can hand off a long task; it runs async on
  the deep tier and posts its result back into the same chat.
- **Coding hands.** A provider-selectable engine (Codex or Claude Code,
  chosen per task and ledgered) runs gated coding tasks in a designated
  code root. Daily self-work turns SAM's own ledger-ranked defects into
  at most one fix proposal a day, landed only through the git-push gate.
- **Chat citations.** When an answer rests on an earlier conversation, a
  "Found in chat history" link under the reply opens the source chat at
  the exact message. Citations validate against that turn's actual
  search results; a fabricated source is rejected and ledgered.
- **Long chats.** Past a size trigger, older turns flush to memory first,
  then fold into a stored summary; the chat never dies at a message cap.
- **Doors.** A hosted chat page per mini with its own expiring key
  (hash stored, shown once, rotatable), pairing codes for channel auth
  (single-use, one-hour, lockout on probing), an injection screen and
  abuse caps on visitor traffic, and a visitor mode where a customer's
  words never become memory or law.
- **Drafts, never sends.** Outbound text is a stored draft the owner sends
  themselves. There is deliberately no send function. Per-contact
  permission notes can forbid drafting outright.
- **Owner console.** The dashboard shows minis, law (with revoke),
  approvals and their history, per-profile activity, model routing and
  token spend, drafts and contacts, and the background queue.

## Surfaces

- **Dashboard**: the phone-first chat UI and owner console, served on the
  install's own host (on the reference install, through a Tailscale door).
- **Web doors**: one chat page per mini, keyed and rate-limited.
- **CLI**: every capability exists as a complete scriptable operation
  first (`sam chats`, `sam actions`, `sam agents`, `sam minis`,
  `sam channels`, `sam background`, `sam backup`, `sam usage`, and more);
  surfaces ride on the CLI, never the other way round.
- **Channels**: a Telegram bridge in pairing mode (live on the
  reference install; pairing gates who can talk to it), a webhook
  trigger, and Discord posting.

## State and reliability

All state lives under the install's `.sam/` directory: SQLite stores for
chats, preferences, memory, missions, and the rest of the converged
store set (one openDatabase path for every store), with append-only
JSONL ledgers (activity, team messages) where the audit trail is the
point.
A nightly backup snapshots the whole state (SQLite via `VACUUM INTO`, so
a copy is transactionally consistent) and a scripted drill proves the
copy boots before it is trusted.

## Fences (by design, not by omission)

- No external sends, no money movement, no trading, ever, from SAM itself.
- The action executor allowlist is internal only; widening it class by
  class is an owner ruling each time.
- Connectors are read-only and default-deny.
- Visitor text is untrusted: screened at the door, never captured as
  memory, law, or fact.
- Secrets never enter the repo, the logs, or a chat.

## Quick start

You need Node 22 or newer and a model API key (MiniMax is the
provider guided setup wires). One command does the mechanical part:

```bash
git clone https://github.com/ReactionLabs/sam.git
cd sam
./scripts/install.sh
```

The script checks the toolchain, installs dependencies, builds, and
hands off to `sam setup`. Setup asks for your API key with hidden
input, verifies it with one real model call, and only then stores it
in your workspace's `sam.env` (mode 0600, never committed): when
verification fails, nothing is saved. The default workspace is
`~/sam-home`; pass `--workspace <dir>` to `install.sh` to choose
another. Every `sam` command loads that workspace's `sam.env`
automatically, and a value in your real environment always wins over
the file. (Dependencies are not in the repository: a fresh clone has
no `node_modules`, and `npm ci` creates it. Do not commit it.)

First chat, in the terminal (`chats new` prints the chat id):

```bash
node dist/cli.js --workspace ~/sam-home chats new "First chat"
node dist/cli.js --workspace ~/sam-home chats send <chat-id> "Say hello and tell me what you can do"
```

Or start the dashboard and chat there (it prints a local URL with
its access token):

```bash
node dist/cli.js --workspace ~/sam-home dashboard
```

To reconfigure later (a new key, a different workspace), run
`node dist/cli.js setup` again. `npm test` runs the full suite when
you want it; it is not part of installing.

## Verify

```bash
npm run build
npm test
```

The suite (997 tests, measured on main at the v0.2.0 landing) covers the turn, tools, gates, doors, heartbeats,
compaction, backups, and a guard that compiles the dashboard page's inline
script, so a dead page cannot pass.

## Legacy stack

An older commander stack (missions, operatives, assignment leases, a
second approvals ledger, stored-but-unexecuted schedules) still ships
behind the CLI. The live turn imports none of it. Under the UNIFICATION
program it faces a retire-or-adopt call, one piece at a time, with the
live turn as the only entry criterion; the actions gate above is the one
approval door going forward.

## Follow the build

- [Open pull requests](https://github.com/ReactionLabs/sam/pulls)
- [Commit history](https://github.com/ReactionLabs/sam/commits/main/)

> Public source can be viewed, cloned, and forked. Never commit API keys,
> tokens, or client credentials.

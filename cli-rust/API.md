# Dashboard HTTP API, as the Rust CLI uses it

This is the contract between `sam-cli` and a running SAM dashboard
(`src/dashboard.ts`), plus the fields the flagship views still cannot get.
The loopback fixture in `sam_cli::harness` speaks the same routes. It never
calls a model.

Checked against `dip/mita/sam-engine` at `569cd8e`.

## Authentication

Every dashboard route except the stable door carries the session token.
The token is 16 to 128 hex characters.

| How the client presents it | Who accepts it |
| --- | --- |
| Path: `/api/<token>/...` and `/api/status/<token>` | The Rust CLI. This is the only form `Client` sends. |
| `Authorization: Bearer <token>` or `?token=` on `GET /api/status` | The dashboard page. The fixture accepts both. A bare `GET /api/status` is 401 with an empty body. |
| `POST` body | Requires `Content-Type: application/json` and `X-SAM-Request: dashboard`. The real server and the fixture both reject anything else. |
| `GET /sam` | No token. `302` to `/dashboard/<token>`. The CLI follows this with redirects disabled and reads the token out of the `Location`. |

The real server also refuses a `Host` or `Origin` that is not loopback on
its port. The fixture only binds `127.0.0.1` and does not repeat that check.

POST bodies over 16000 bytes are rejected. Chat message `content` must be
non-empty and at most 12000 characters. Error JSON is `{ "error": "..." }`.
The client redacts its token out of any error string.

## Routes the CLI calls today

`Client` in `src/api.rs` calls these five and nothing else.

### `GET /api/status/<token>`

Tolerant read (`status_view::parse_snapshot`). Unknown keys are ignored.
A missing section becomes a "not reported" line. An `error` string fails
the call. `ok` defaults to true.

Fields the parser actually reads:

| Key | Use |
| --- | --- |
| `chats[]` | `id`, `title`, `agent_name` (empty becomes `sam`), `pinned` (bool or 0/1), and the first of `lastMessageAt`, `updated_at`, `updatedAt` |
| `actions[]` | `id`, `actor`, `kind`, `title`, `detail`, `status`, `result`, `risk` |
| `providers` or `providerHealth`, else `auth` | Provider health lines. `auth.routes[]` uses `route`, `model`, `key`, `lastProbe.bucket` |
| `activity[]` | `actor`, `kind`, `summary`. The real handler accepts `?actor=` and `?kind=` and filters before it returns the array. The CLI does not send the query. |
| `usage` | Lifetime `totalTokens`, `calls`, `byActor`, `byModel`. Not a day bucket. |
| `failures`, else `activity` kinds containing `fail` | Failure lines |
| `models[]` | `route`, `model`, `tier`, `source` |
| `auth` | `provider`, `endpoint`, `keyEnv`, `key` (`present` or `absent`, never the secret), `setupVerified`, `engine.installed`, `engine.connected` |
| `config.defaultAgent` | Shown on the auth lines |
| `channels[]` | `name`, `kind`, `profile`, `enabled`, `tokenEnv` |
| `pairing[]` | `channel`, `profile`, `owners`, `lockedUntil` |

`GET /api/status/<token>` on a live SAM also returns many keys the CLI
does not read. The ones the flagship cares about are listed under gaps.

### `GET /api/<token>/chats/<id>`

`<id>` is 36 characters from `[0-9a-f-]`. 404 `{ "error": "Chat not found" }` otherwise.

```json
{
  "messages": [
    {
      "id": "",
      "chat_id": "",
      "role": "user",
      "content": "",
      "created_at": "",
      "reaction": null,
      "partial": 0
    }
  ],
  "events": [{ "agent": "dip", "kind": "tool", "content": "" }],
  "actions": []
}
```

The CLI reads message `id`, `role`, `content`, `created_at`, `reaction`,
and event `agent`, `kind`, `content`. It does **not** read `partial`.
`partial: 1` is an assistant row the turn is still writing. Actions on
this payload use the same shape as status actions, filtered to the chat.

While `POST .../messages` is still open, polling this GET is how the CLI
sees the working state. There is no SSE and no chunked message stream.

### `POST /api/<token>/chats/<id>/messages`

```json
{ "content": "hello" }
```

Success:

```json
{
  "reply": { "role": "assistant", "content": "..." },
  "userReaction": "❤️",
  "actions": []
}
```

The CLI reads `reply.content` and `userReaction`. Empty `reply.content`
plus an `error` string is a failure.

A second POST for the same chat while the first is open is
`409 { "error": "This chat already has a response in progress" }`.

On a live turn the server, before it answers:

1. Stores the user message and sets `reaction` to 👀.
2. May write an assistant row with `partial: 1` and the text so far.
3. On success, finishes that row (`partial: 0`) and, if the eyes mark is
   still there, replaces it with ❤️. `userReaction` is that final emoji.
4. On failure, clears the eyes mark. A partial row can remain.
   Known model errors are returned as written (`Model not configured`,
   `Model request timed out`, and the rest of the list in
   `src/dashboard.ts`). Anything else becomes
   `Message failed. Check model configuration and server logs.`

The fixture does the same when a test calls `hold_next_turn`,
`push_partial`, and `release_turn`. `push_partial` is the accumulated
text, not a delta, matching `onPartial` in `src/agent-turn.ts`.

### `POST /api/<token>/actions/<id>/decide`

```json
{ "decision": "approve" }
```

`decision` is `approve` or `reject`. The response is the action object.
Any other body is `400 { "error": "Invalid action decision" }`. The
fixture records the decision and does not execute the proposal.

### `POST /api/<token>/chats`

```json
{ "title": "Terminal" }
```

`201` with the chat record. The CLI reads `id` only. Title is trimmed,
1 to 120 characters. Optional `agent` must be `sam` or a known profile.

## Routes that already exist, which the CLI does not call

These are on the real dashboard. The fixture implements the two the
profile switcher needs.

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /api/<token>/chats/<id>/profile` | `{ "agent": "trading" }` | `200 { "ok": true }`. `sam` or `null` clears `agent_name`. Unknown name is 404. |
| `POST /api/<token>/config` | `{ "defaultAgent": "trading", "showTeamEvents": true }` | `200` with the saved config. Both fields are required. Unknown agent is 400. This is the workspace default for new chats, not a CLI session. |
| `POST /api/<token>/agents` | `{ "name", "instructions", "model", "connectorId" }` | Creates a profile. **Not implemented on the fixture.** |
| `POST /api/<token>/chats/<id>/(rename\|pin\|archive\|branch)` | as the dashboard page sends | **Not implemented on the fixture.** |
| `POST /api/<token>/connectors` and `.../connectors/<id>/(test\|read\|delete)` | | Live connector probe. **Not implemented on the fixture.** |

## What a live status document already contains

`GET /api/status/<token>` is one large JSON object. Beyond the keys the
CLI reads, a current server includes `agents` (profiles), `skills`,
`connectors` (each with `credentialPresent`, never the secret), `engine`
plus `engine.connection`, `usage` (whole ledger), `auth.profiles`,
`pairing`, and a long tail (`missions`, `schedules`, `minis`, `doors`,
`observability`, and others). It does **not** include `tools`,
`usage.today`, or a top-level `channels` array.

`agents[]` is `AgentProfile`: `id`, `name`, `instructions`, `created_at`,
`model`, `connector_id`, `provider`.

`skills[]` is `{ name, description, path, source }`.

`connectors[]` is `{ id, name, url, tokenEnv, enabled, allowedTools, credentialPresent }`.

`engine` is `{ installed, binary, queued, running, done, blocked, failed, recent, connection }`.
`connection` is `{ route: "cli-reuse", connected, stale, record }`.
`record` is null unless connected, and then `{ route, binary, connectedAt, authState, authMethod }`.
No credential is stored there.

`usage` is `{ calls, promptTokens, completionTokens, totalTokens, byActor, byModel, byRoute, byTier, lastAt }`.
Every line in `.sam/usage.jsonl` is included. There is no `since` and no calendar day.

`pairing[]` is telegram channels only: `{ channel, channelId, profile, owners, liveCode, codeExpiresAt, recentFailures, lockedUntil }`.

## Endpoint gaps

The flagship needs these. "Client gap" means the bytes are already on
`GET /api/status/<token>` and `status_view` drops them. "Endpoint gap"
means a live SAM does not send the data, so a view built only against
today's server cannot show it.

### Profiles list — client gap, not an endpoint gap

`agents` and `auth.profiles` are on status. `auth.profiles[].model` is
the model that profile actually resolves to. The CLI does not read either.

There is no `GET /api/<token>/profiles`. There is no API that lists
separate SAM installs. `dip`, `trading`, and `second-shift` as profiles
inside one workspace are the `agents` rows. The same names as separate
running SAMs are separate base URLs and tokens, and nothing in this API
enumerates them.

### Profile switch — partial

Switching the open chat is `POST .../chats/<id>/profile`. Switching the
workspace default is `POST .../config`. Both exist. The CLI has no method
for either, and neither is a session that survives without being written
into the workspace.

There is no endpoint that switches which running SAM the process is
talking to. That remains a new `SAM_BASE_URL` / token and a reconnect.
The fixture cannot invent a second install; a test that needs two SAMs
spawns two `FakeDashboard`s.

### Today's tokens and calls — endpoint gap

Status `usage.calls` and `usage.totalTokens` are the whole ledger. The
CLI spend line is that lifetime total (`1200 tokens · 12 calls` in the
demo fixture), and it will not say "today" honestly. There is no `today`,
no `since`, and no date query.

The fixture adds `usage.today` (`{ calls, promptTokens, completionTokens, totalTokens }`)
only when `serve_usage_today` is set (`DashboardState::demo` turns it on,
`production` turns it off). A live server omits the key. Do not ship a
parser that requires it.

### Skills — list is a client gap; body is an endpoint gap

`skills` on status is the installed catalog (name, description, path,
source). The CLI does not project it. There is no dashboard route that
returns a skill's instructions, enables one, or disables one. Installing
a skill is an approval of kind `skill`, not a CLI GET.

### Tools — endpoint gap

No `tools` key and no `/api/<token>/tools`. The own-tool catalog is
compiled into `src/own-tools.ts`. Connector tools are only
`connectors[].allowedTools`, plus a live MCP `tools/list` that the
dashboard does not proxy except `POST .../connectors/<id>/test`.

The fixture adds `tools[]` as `{ name, source, tier, description }` when
`serve_tools` is set. Example rows: `sam_memory_search` (`source: own`,
`tier: core`) and `pipeline_summary` (`source: connector:second-shift`).
A live server omits the key. The current status view does not render it;
the harness test asserts that.

### Connections — partial, and `channels` is an endpoint gap

| Surface | On live status? | CLI today |
| --- | --- | --- |
| MCP connectors | `connectors` | Not read |
| Claude Code | `engine` and `engine.connection`, also `auth.engine.installed` / `connected` | Auth lines show installed and connected only |
| Telegram pairing | `pairing` | Config screen reads it |
| Full channel records (`kind`, `enabled`, `tokenEnv`) | **No `channels` array** | The parser would show them, and currently falls through to pairing or "channels not reported" |
| One status-bar "connection" | No. Reachability is whether status itself returned. | The footer does not show it |
| Desktop bridge pairing | **Nothing to query** | The view has to say it is not paired |

The fixture serves `channels` only when `serve_channels` is set, so the
existing config renderer can be exercised. `production()` matches the
live document and leaves the key out. `pairing` is always present.

Connector `credentialPresent` is a boolean. The fixture never puts a
secret, a key, or a token value in a body.

## Adjacent gaps the addendum also hits

- **Message search.** The chat store can full-text search. No dashboard
  route exposes it. `GET` chat returns the messages it has (the real
  store caps at 500). Ctrl+F has to search what is already loaded, or
  the server has to grow a route.
- **Image attach.** There is no image field and no path field. A data
  URL or markdown image inside `content` is what the CLI already renders
  on the way back out (`find_images`). The content cap is 12000
  characters and the body cap is 16000, so a path attach has to be
  inlined by the client and a large file will not fit. The fixture
  serves `GET /media/pixel.png` (`image/png`) so a same-origin URL in a
  reply can be hydrated.
- **Working animation.** Drive it from `partial` and the 👀 reaction
  while the POST is open. The CLI already polls; it ignores `partial`
  and only latches the emoji into the smoke proof.

## Using the fixture

```rust
let dash = sam_cli::harness::FakeDashboard::spawn();
let client = dash.client();
let status = client.status().unwrap();

dash.hold_next_turn();
// POST /messages blocks on another thread
assert!(dash.turn_is_waiting());
dash.push_partial("Still thinking");
dash.release_turn();

let mut app = sam_cli::app::App::new(dash.origin(), sam_cli::image_proto::ImageProtocol::None);
// feed Ev::Status / Ev::Chat, then:
let screen = sam_cli::harness::render_screen(&mut app, 80, 24);
sam_cli::harness::assert_screen(&screen, "expected buffer text");
```

`FakeDashboard::spawn_production()` is the live status shape.
`spawn_with` takes a `DashboardState`. Dropping the dashboard stops
the accept thread.

`render_screen` draws through `ui::render` into a ratatui `TestBackend`.
`Screen::plain` is the symbol grid with trailing blank rows removed.
`Screen::buffer` is the raw buffer for style checks.

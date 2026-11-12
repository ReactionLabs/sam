# sam-cli

A Ratatui client for a running SAM. It is a face, not a second brain: every
chat, approval, and status line comes from the dashboard HTTP API. The binary
holds no agent state of its own.

```bash
cargo build --release
# binary: target/release/sam-cli
```

Rust 1.88 or newer. The release build in this repo was made with 1.99.

## Connect

```bash
export SAM_BASE_URL=http://127.0.0.1:4317/sam
sam-cli
```

`SAM_BASE_URL` may be the origin, the stable door (`/sam`, followed to the
current `/dashboard/<token>` redirect), or the dashboard URL itself.
`SAM_TOKEN` supplies the token when the URL does not carry one.

A config file is the other option. `SAM_CONFIG`, or
`~/.config/sam/cli.json`:

```json
{ "baseUrl": "http://127.0.0.1:4317", "token": "<dashboard token>" }
```

The file must be mode `0600`. A group- or world-readable file is refused
and its contents are not loaded.

## Keys

| Key | Action |
| --- | --- |
| `1`–`4` | chat, approvals, status, config |
| `5`–`9` | skills, tools, connections, Claude Code, desktop bridge |
| `j` `k` | next / previous |
| `J` `K`, pgup, pgdn | scroll the transcript; the title says `viewing history` until `end` |
| `i`, enter | write, then send |
| `n` | new chat titled Terminal |
| `a` | attach an image by path as a data URL (12,000 character cap) |
| `[` `]`, `y`, `c` | select a message, copy it (OSC 52), copy its code block |
| ctrl-k, ctrl-f | command palette, search this chat |
| `p`, `t` | switch profile (dip, trading, second-shift), toggle Muse / Harbor |
| `y` `x` | on approvals: approve / reject |
| `?`, `q` | help, quit |

Mouse clicks the chat list, a transcript line, and the section keys. The wheel scrolls the pane under the pointer. Bracketed paste lands in the composer as text.

`usageToday` on `/api/status` feeds the status bar. The all-time `usage` ledger is never labeled today. Skills, connector tools, code commands, and the Claude Code engine object render when the payload has them. SAM's built-in tool names are not on `/api/status`. The desktop bridge says `not paired` until a `desktopBridge` object exists. Outgoing messages send `"source": "rust-cli"`. When a chat read includes `source`, a user line ends with a dim `· rust-cli` (or dashboard, ts-cli, telegram, api). A missing field, or `unknown`, stays quiet.

Profiles live in the mode-0600 config under `profiles`, or in `SAM_PROFILE` plus `SAM_PROFILE_DIP_URL`, `SAM_PROFILE_TRADING_URL`, and `SAM_PROFILE_SECOND_SHIFT_URL` (and matching `_TOKEN` variables). Switching does not rewrite the file.

Raw mode is left on panic, so a crash does not stick the terminal.

Approvals call `POST /api/<token>/actions/<id>/decide`, the same endpoint
the dashboard buttons use. Status and config read `/api/status/<token>` and
tolerate fields that are missing or extra.

## Images

A message that contains a data-URL image, a same-origin image URL, or (when
`SAM_WORKSPACE` is set) a relative image path inside that workspace is drawn
with the kitty or iTerm2 graphics protocol when the terminal supports it.
`SAM_TUI_IMAGE=kitty|iterm2|off` overrides detection. Any other terminal gets
a text placeholder: `[image: name · no graphics protocol]`.

## Smoke

```bash
npm run build
cargo build --release
cli-rust/smoke/smoke.sh
```

The script starts a loopback fake model, starts SAM against it, and drives
`sam-cli` through splash, a chat round trip, an approval, status, and config.

## Hermetic tests

`cargo test` (from this directory) runs the client against
`sam_cli::harness::FakeDashboard`, a loopback dashboard with no model and
no credentials. `render_screen` / `assert_screen` draw a view into a
ratatui `TestBackend` so a test can assert the buffer. The HTTP contract,
and the fields a live SAM does not send yet, are in `API.md`.

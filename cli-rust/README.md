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
| `1` `2` `3` `4` | chat, approvals, status, config |
| `j` `k` | next / previous |
| `i` | write in the chat composer |
| enter | send |
| `n` | new chat titled Terminal |
| `y` `x` | approve / reject the selected card |
| `?` | help |
| `q` | quit |

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

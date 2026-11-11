#!/usr/bin/env bash
# Launch sam-cli against a local SAM with a fake model and prove three things:
# chats load, one message round trip, and an approval card decided from the
# approvals view. Writes text captures of splash, chat, approvals, status,
# and config. No real API keys are used.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${SAM_CLI_BIN:-$CLI_DIR/target/release/sam-cli}"
OUT="${SAM_CLI_DUMP_DIR:-$CLI_DIR/smoke-out}"
WS="$(mktemp -d)"
MOCK_PID=""
DASH_PID=""

cleanup() {
  if [[ -n "${DASH_PID}" ]]; then kill "$DASH_PID" 2>/dev/null || true; wait "$DASH_PID" 2>/dev/null || true; fi
  if [[ -n "${MOCK_PID}" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$WS"
}
trap cleanup EXIT

if [[ ! -x "$BIN" ]]; then
  echo "sam-cli binary not found at $BIN (cargo build --release first)" >&2
  exit 1
fi

MOCK_JS="$(mktemp --suffix=.mjs)"
cat > "$MOCK_JS" <<'EOF'
import fs from "node:fs";
import http from "node:http";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const reply = "pong from mock\n\n![pixel](data:image/png;base64," + png + ")";
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const payload = {
      choices: [{ message: { role: "assistant", content: reply } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }, 1200);
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeSync(1, String(server.address().port) + "\n");
});
EOF
MOCK_LOG="$(mktemp)"
node "$MOCK_JS" > "$MOCK_LOG" &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if [[ -s "$MOCK_LOG" ]]; then break; fi
  sleep 0.1
done
MOCK_PORT="$(head -n 1 "$MOCK_LOG")"
if [[ -z "$MOCK_PORT" ]]; then
  echo "mock model did not start" >&2
  exit 1
fi

DASH_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
DASH_LOG="$(mktemp)"
env -u MINIMAX_API_KEY -u SAM_MODEL_PROVIDER \
  SAM_MODEL=mock \
  SAM_MODEL_ENDPOINT="http://127.0.0.1:${MOCK_PORT}/v1/chat/completions" \
  SAM_MODEL_API_KEY=smoke-local \
  node "$ROOT/dist/cli.js" --workspace "$WS" dashboard --port "$DASH_PORT" > "$DASH_LOG" 2>&1 &
DASH_PID=$!
TOKEN=""
for _ in $(seq 1 50); do
  if grep -q "SAM dashboard:" "$DASH_LOG"; then
    TOKEN="$(sed -n 's|.*dashboard/\([0-9a-f]\{32\}\).*|\1|p' "$DASH_LOG" | head -n 1)"
    break
  fi
  if ! kill -0 "$DASH_PID" 2>/dev/null; then
    echo "dashboard exited early" >&2
    cat "$DASH_LOG" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ -z "$TOKEN" ]]; then
  echo "dashboard did not print a token" >&2
  cat "$DASH_LOG" >&2
  exit 1
fi

# Seed one chat and one gated note. The note stays pending until sam-cli approves it.
curl -sf -X POST "http://127.0.0.1:${DASH_PORT}/api/${TOKEN}/chats" \
  -H 'content-type: application/json' \
  -H 'x-sam-request: dashboard' \
  -d '{"title":"Smoke"}' > /dev/null
node "$ROOT/dist/cli.js" --workspace "$WS" actions propose sam note "Remember the smoke" "Smoke test note" > /dev/null

rm -rf "$OUT"
mkdir -p "$OUT"
SCRIPT="$OUT/script.txt"
cat > "$SCRIPT" <<'EOF'
wait connected
dump splash
key enter
wait chats
dump chat-list
key i
type ping
key enter
wait reaction:eyes
wait reply:pong from mock
wait reaction:heart
dump chat
key 2
wait pending
dump approvals-pending
key y
wait approved
dump approvals
key 3
wait status
dump status
key 4
wait config
dump config
quit
EOF

# No SAM_TOKEN: the base URL is the /sam door, so the CLI must follow the redirect.
env -u SAM_TOKEN -u SAM_CONFIG \
  SAM_BASE_URL="http://127.0.0.1:${DASH_PORT}/sam" \
  SAM_TUI_IMAGE=off \
  "$BIN" --script "$SCRIPT" --dump-dir "$OUT"

python3 - "$OUT" <<'PY'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
proof = json.loads((out / "proof.json").read_text())
need = {
    "splash": "Self-directed AI Workforce",
    "chat-list": "Smoke",
    "chat": "pong from mock",
    "approvals": "Remember the smoke",
    "status": "Provider health",
    "config": "SAM_MODEL_API_KEY",
}
for name, needle in need.items():
    text = (out / f"{name}.txt").read_text(errors="replace")
    if needle not in text:
        raise SystemExit(f"{name}.txt does not contain {needle!r}\n" + text)
splash = (out / "splash.txt").read_text(errors="replace")
if "█" not in splash:
    raise SystemExit("splash is missing the block-letter wordmark")
chat = (out / "chat.txt").read_text(errors="replace")
if "no graphics protocol" not in chat:
    raise SystemExit("chat capture did not show the image placeholder\n" + chat)
if "❤" not in chat:
    raise SystemExit("chat capture did not show the heart reaction\n" + chat)
if proof.get("chats_loaded", 0) < 1 or not proof.get("chat_open"):
    raise SystemExit(f"chats did not load: {proof}")
if "pong from mock" not in (proof.get("reply") or ""):
    raise SystemExit(f"reply was not recorded: {proof}")
if not proof.get("saw_working_reaction") or not proof.get("saw_heart_reaction"):
    raise SystemExit(f"reactions were not both seen: {proof}")
if proof.get("approval_status") != "done":
    raise SystemExit(f"approval was not done: {proof}")
if proof.get("image_protocol") != "none":
    raise SystemExit(f"expected the placeholder protocol, got {proof.get('image_protocol')}")
print("smoke ok")
print(json.dumps({k: proof[k] for k in (
    "chats_loaded", "chat_open", "reply", "saw_working_reaction",
    "saw_heart_reaction", "approval_status", "image_protocol", "image_label", "status_ok"
)}, indent=2))
PY

# The approval must have executed through the real gate, not only in the UI.
STATUS="$(curl -sf "http://127.0.0.1:${DASH_PORT}/api/status/${TOKEN}")"
python3 -c 'import json,sys; body=json.loads(sys.argv[1]); acts=[a for a in body.get("actions",[]) if a.get("title")=="Remember the smoke"]; assert acts and acts[0]["status"]=="done", acts; assert "Memory note saved" in (acts[0].get("result") or ""), acts[0]' "$STATUS"

rm -f "$MOCK_JS" "$MOCK_LOG" "$DASH_LOG"
echo "captures in $OUT"

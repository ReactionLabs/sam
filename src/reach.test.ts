import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listReachChannels, resetReachCache, runReach } from "./reach.js";

// A stub agent-reach binary: answers `channels` with a two-channel
// declaration, one search with items, one declared error, and echoes
// nothing else. SAM_AGENT_REACH_BIN points the seam at it.
function stubBin(root: string): string {
  const path = join(root, "agent-reach-stub");
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "channels" ]; then
  echo '{"channels":[{"id":"web","actions":["search","read"]},{"id":"v2ex","actions":["hot","read"]}]}'
  exit 0
fi
if [ "$1" = "web" ] && [ "$2" = "search" ]; then
  echo '{"ok":true,"items":[{"title":"Big story","url":"https://example.com/a","author":"Wire","published_at":"2026-11-10","text":"Something happened."},{"title":"Second","url":"https://example.com/b","text":"More."}]}'
  exit 0
fi
if [ "$1" = "web" ] && [ "$2" = "read" ]; then
  echo '{"ok":false,"error":{"code":"NEED_LOGIN","message":"login required","hint":"the user logs in themselves"}}'
  exit 0
fi
if [ "$1" = "v2ex" ] && [ "$2" = "hot" ]; then
  echo '{"ok":true,"items":[{"title":"Hot topic","url":"https://v2ex.example/t/1","text":"Discussed."}]}'
  exit 0
fi
echo '{"ok":false,"error":{"code":"BAD_INPUT","message":"unhandled"}}'
`);
  chmodSync(path, 0o755);
  return path;
}

test("reach: declared channels list, a search returns trimmed items, a channel error comes back as data", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-reach-"));
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root) };
    resetReachCache();
    const channels = await listReachChannels(env);
    assert.deepEqual(channels.map((c) => c.id), ["web", "v2ex"]);
    const found = await runReach({ channel: "web", action: "search", query: "breaking news", limit: 5 }, env);
    assert.equal(found.ok, true);
    assert.equal(found.items?.length, 2);
    assert.equal(found.items?.[0].title, "Big story");
    const denied = await runReach({ channel: "web", action: "read", query: "https://example.com/x" }, env);
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "NEED_LOGIN");
    assert.match(denied.error?.hint ?? "", /logs in themselves/);
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

test("reach: undeclared channels and actions are refused before any call; zero-arg hot actions need no query", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-reach2-"));
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root) };
    resetReachCache();
    const badChannel = await runReach({ channel: "myspace", action: "search", query: "x" }, env);
    assert.equal(badChannel.ok, false);
    assert.equal(badChannel.error?.code, "BAD_INPUT");
    const badAction = await runReach({ channel: "web", action: "post", query: "x" }, env);
    assert.equal(badAction.ok, false);
    assert.match(badAction.error?.message ?? "", /does not declare/);
    const noQuery = await runReach({ channel: "web", action: "search" }, env);
    assert.equal(noQuery.error?.code, "BAD_INPUT");
    const hot = await runReach({ channel: "v2ex", action: "hot" }, env);
    assert.equal(hot.ok, true);
    assert.equal(hot.items?.[0].title, "Hot topic");
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

test("reach: a missing binary reports NOT_INSTALLED instead of throwing", async () => {
  const env = { ...process.env, SAM_AGENT_REACH_BIN: "/nonexistent/agent-reach" };
  resetReachCache();
  const result = await runReach({ channel: "web", action: "search", query: "x" }, env);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /not installed/);
  resetReachCache();
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels, channelKindBlocker, channelKinds } from "./channels.js";

// The channel-kind gate: the kind is a registry name
// (channelKinds in channels.ts: telegram, webhook,
// discord) that every channel creation names into
// addChannel, the ONE seam every kind rides (the CLI
// channels add / add-discord / add-webhook doors and
// the config wizard each name one). addChannel refused
// an unknown kind with the bare "Invalid channel kind" -
// the bad value never echoed, none of the kinds named,
// and no fold correction offered, so a folded name
// dead-ended. channelKindBlocker in channels.ts is now
// the ONE source carrying the refusal text, thrown
// before any other validation or store write. Stored
// channel kinds are unchanged: read back as stored,
// never re-validated.

test("channel kind gate: every exact kind reads no blocker", () => {
  for (const kind of channelKinds) assert.equal(channelKindBlocker(kind), null, kind);
  assert.equal(channelKinds.length, 3);
});

test("channel kind gate: an unknown kind echoes the value and names the kinds, no correction", () => {
  assert.equal(
    channelKindBlocker("slack"),
    "Invalid channel kind \"slack\". Kinds: telegram, webhook, discord",
  );
});

test("channel kind gate: a folded name is refused with the correction", () => {
  assert.match(channelKindBlocker("Telegram")!, /Did you mean "telegram"\?$/);
  assert.match(channelKindBlocker("Web-Hook")!, /Did you mean "webhook"\?$/);
  assert.match(channelKindBlocker("disc_ord")!, /Did you mean "discord"\?$/);
});

test("channel kind gate: a non-string or empty value refuses naming the kinds, no correction", () => {
  assert.match(channelKindBlocker(42)!, /^Invalid channel kind "42"\. Kinds:/);
  assert.doesNotMatch(channelKindBlocker(42)!, /Did you mean/);
  assert.match(channelKindBlocker("")!, /^Invalid channel kind ""\. Kinds:/);
  assert.doesNotMatch(channelKindBlocker("")!, /Did you mean/);
});

test("channel kind gate: the addChannel seam refuses a folded kind before creating anything, and an exact kind adds", () => {
  const root = mkdtempSync(join(tmpdir(), "channel-kind-gate-"));
  try {
    assert.throws(() => addChannel(root, "Telegram" as never, "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN"), /Did you mean "telegram"\?$/);
    assert.throws(() => addChannel(root, "slack" as never, "Dip Slack", "trading", "SAM_CHANNEL_SLACK_MAIN"), /^Error: Invalid channel kind "slack"\. Kinds:/);
    assert.deepEqual(channels(root), []);
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    assert.equal(channel.kind, "telegram");
    assert.equal(channels(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

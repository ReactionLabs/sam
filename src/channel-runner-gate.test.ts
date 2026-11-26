import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channelRunnerBlocker, runnerChannel, updateChannel } from "./channels.js";

// The channel-runner gate: the telegram bridge, the
// discord poster, and the webhook server each resolved
// their channel through their own inline find filtered
// by kind + enabled and refused a miss with a generic
// line naming no registry and offering no fold
// correction, unable to distinguish an unknown name from
// a disabled channel or a channel of another kind.
// channelRunnerBlocker in channels.ts is now the ONE
// source carrying the refusal text for a kind-filtered
// runner pick, and runnerChannel throws it before any
// bridge, post, or server starts. channels() and the
// store stay permissive by design, so neither is gated
// here.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-channel-runner-gate-"));
  addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_DIP");
  addChannel(root, "discord", "owner-alerts", "sam", "SAM_CHANNEL_ALERTS");
  return root;
}

test("channel runner gate: an enabled channel of the kind reads no blocker, named or defaulted", () => {
  const root = fresh();
  try {
    assert.equal(channelRunnerBlocker(root, "telegram", "Dip Telegram"), null);
    assert.equal(channelRunnerBlocker(root, "telegram"), null);
    assert.equal(runnerChannel(root, "telegram", "Dip Telegram").name, "Dip Telegram");
    assert.equal(runnerChannel(root, "telegram").name, "Dip Telegram");
    assert.equal(runnerChannel(root, "discord", "owner-alerts").kind, "discord");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel runner gate: an unknown name names the channels of that kind only", () => {
  const root = fresh();
  try {
    const blocker = channelRunnerBlocker(root, "telegram", "nope");
    assert.match(blocker!, /^No enabled telegram channel: "nope"\. Telegram channels: Dip Telegram \(.+, enabled\)$/);
    assert.throws(() => runnerChannel(root, "telegram", "nope"), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.match(channelRunnerBlocker(root, "webhook", "nope")!, /Webhook channels: none registered$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel runner gate: no name and no enabled channel of the kind refuses naming the registry", () => {
  const root = fresh();
  try {
    assert.equal(channelRunnerBlocker(root, "webhook"), "No enabled webhook channel configured. Webhook channels: none registered");
    assert.throws(() => runnerChannel(root, "webhook"), /No enabled webhook channel configured/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel runner gate: a folded name is refused with the correction", () => {
  const root = fresh();
  try {
    assert.match(channelRunnerBlocker(root, "telegram", "dip telegram")!, /Did you mean "Dip Telegram" \(.+, enabled\)\?$/);
    assert.match(channelRunnerBlocker(root, "discord", "OWNER_ALERTS")!, /Did you mean "owner-alerts"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel runner gate: a disabled channel is named as disabled, not as missing", () => {
  const root = fresh();
  try {
    const dip = runnerChannel(root, "telegram", "Dip Telegram");
    updateChannel(root, dip.id, { enabled: false });
    const blocker = channelRunnerBlocker(root, "telegram", "Dip Telegram");
    assert.match(blocker!, /Dip Telegram \(.+, disabled\)/);
    assert.match(blocker!, /Did you mean "Dip Telegram" \(.+, disabled\)\?$/);
    assert.throws(() => runnerChannel(root, "telegram"), (e: unknown) => e instanceof Error && e.message === channelRunnerBlocker(root, "telegram"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

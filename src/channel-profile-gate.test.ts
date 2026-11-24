import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addChannel, channels, channelProfileBlocker } from "./channels.js";

// The profile gate for channel creation doors: every other
// profile-naming creation door validates the profile
// registry (channels bind, events bind, agents add-fallback,
// skills allow, heartbeats add / schedule), but the channel
// creation doors - channels add / add-discord / add-webhook
// and the config wizard's channels section - passed the raw
// profile into addChannel, which checks only the name's
// shape, minting a channel bound to nobody: its messages
// resolve to the channel's own profile by default and run
// unscoped. channelProfileBlocker is now the ONE source
// carrying the refusal text: the CLI doors throw it before
// creating anything and the wizard refuses with it before
// addChannel. The store itself stays permissive by design
// (a profile removed after a channel names it leaves the
// channel resolving to its stored default), so addChannel
// is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-channel-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("channel profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(channelProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(channelProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      channelProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in channel detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      channelProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in channel detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      channelProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in channel detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel profile gate: the CLI door's check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = channelProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI doors throw this text before calling addChannel;
    // pin that the check alone leaves the registry empty.
    assert.equal(channels(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel profile gate: a registered profile passes the check and the channel is created", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(channelProfileBlocker(root, "second-shift"), null);
    const channel = addChannel(root, "telegram", "Second Shift TG", "second-shift", "SAM_CHANNEL_TG_MAIN");
    assert.equal(channel.profile, "second-shift");
    assert.equal(channels(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel profile gate: the store stays permissive - a channel may name a profile removed later", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    assert.equal(channel.profile, "trading");
    assert.equal(channels(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

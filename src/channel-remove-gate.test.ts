import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channelNameBlocker, channels, removeChannel } from "./channels.js";
import { findChannel } from "./pairing.js";

// The channel-name gate for the remove door: every sibling
// channel door (pair / redeem / bind / resolve) takes a
// name-or-id through findChannel, which throws
// channelNameBlocker - the ONE source naming the registry
// with a fold correction - but `sam channels remove <id>`
// rode removeChannel alone and took an id ONLY: it
// accepted no name at all, and an unknown id silently
// returned {removed:false}, naming nothing, so at the
// door that DELETES a channel the owner could not tell a
// typo from a genuinely absent channel (the vault-remove
// shape). The CLI remove door now takes <idOrName>,
// resolves it through findChannel (throwing
// channelNameBlocker before anything is removed) and
// removes by the resolved id; removeChannel keeps its
// boolean contract (false on a miss) for internal
// callers - the store seam stays permissive by design.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-channel-remove-gate-"));
  addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_DIP");
  addChannel(root, "webhook", "owner-alerts", "sam", "SAM_CHANNEL_ALERTS");
  return root;
}

test("channel remove gate: an exact name reads no blocker and removes by the resolved id", () => {
  const root = fresh();
  try {
    assert.equal(channelNameBlocker(root, "Dip Telegram"), null);
    const resolved = findChannel(root, "Dip Telegram");
    assert.equal(removeChannel(root, resolved.id), true);
    assert.deepEqual(channels(root).map(c => c.name), ["owner-alerts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: an exact id reads no blocker and removes", () => {
  const root = fresh();
  try {
    const target = findChannel(root, "owner-alerts");
    assert.equal(channelNameBlocker(root, target.id), null);
    assert.equal(removeChannel(root, findChannel(root, target.id).id), true);
    assert.deepEqual(channels(root).map(c => c.name), ["Dip Telegram"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const dip = findChannel(root, "Dip Telegram");
    const blocker = channelNameBlocker(root, "dip telegram")!;
    assert.equal(
      blocker,
      "Channel not found: \"dip telegram\". Channels: Dip Telegram (" + dip.id + "), owner-alerts (" + findChannel(root, "owner-alerts").id + "). Did you mean \"Dip Telegram\" (" + dip.id + ")?",
    );
    assert.throws(() => findChannel(root, "dip telegram"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // channel is still registered afterwards.
    assert.deepEqual(channels(root).map(c => c.name), ["Dip Telegram", "owner-alerts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: a separator-folded name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = channelNameBlocker(root, "Owner_Alerts")!;
    assert.match(blocker, /Did you mean "owner-alerts" \(.+\)\?$/);
    assert.deepEqual(channels(root).map(c => c.name), ["Dip Telegram", "owner-alerts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: an unknown name or id names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = channelNameBlocker(root, "ghost-channel")!;
    assert.match(blocker, /^Channel not found: "ghost-channel"\. Channels: Dip Telegram \(.+\), owner-alerts \(.+\)$/);
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.throws(() => findChannel(root, "ghost-channel"), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.equal(channels(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: an empty registry refuses naming none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-channel-remove-gate-"));
  try {
    assert.equal(channelNameBlocker(root, "Dip Telegram"), "Channel not found: \"Dip Telegram\". Channels: none registered");
    assert.throws(() => findChannel(root, "Dip Telegram"), /none registered/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: an ambiguous fold offers no correction", () => {
  const root = fresh();
  try {
    addChannel(root, "discord", "dip-telegram", "sam", "SAM_CHANNEL_DIP2");
    const blocker = channelNameBlocker(root, "Dip_Telegram")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(channels(root).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel remove gate: the store seam stays permissive (false on a miss, nothing written)", () => {
  const root = fresh();
  try {
    assert.equal(removeChannel(root, "no-such-id"), false);
    assert.equal(channels(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

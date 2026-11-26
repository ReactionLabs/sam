import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channelNameBlocker } from "./channels.js";
import { findChannel, issuePairingCode } from "./pairing.js";

// The channel-name gate for the channel doors: every
// other naming door reads its registry through a ONE
// source in its owning module before acting - but the
// channel name was refused by findChannel with the bare
// "Channel not found: X" (no registry, no fold
// correction), and every door riding it (channels pair /
// redeem / bind / resolve, issuePairingCode) inherited
// the dead end. channelNameBlocker in channels.ts is now
// the ONE source carrying the refusal text: findChannel
// throws it. By-id internal lookups (setBinding,
// redeemPairingCode) and the store stay permissive by
// design, so neither is gated here.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-channel-name-gate-"));
  addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_DIP");
  addChannel(root, "webhook", "owner-alerts", "sam", "SAM_CHANNEL_ALERTS");
  return root;
}

test("channel name gate: every registered channel reads no blocker, by name or by id", () => {
  const root = fresh();
  try {
    assert.equal(channelNameBlocker(root, "Dip Telegram"), null);
    assert.equal(channelNameBlocker(root, "owner-alerts"), null);
    const found = findChannel(root, "Dip Telegram");
    assert.equal(channelNameBlocker(root, found.id), null);
    assert.equal(findChannel(root, found.id).name, "Dip Telegram");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel name gate: an unknown name names the registry", () => {
  const root = fresh();
  try {
    const blocker = channelNameBlocker(root, "nope");
    assert.match(blocker!, /^Channel not found: "nope"\. Channels: Dip Telegram \(.+\)\, owner-alerts \(.+\)$/);
    assert.throws(() => findChannel(root, "nope"), (e: unknown) => e instanceof Error && e.message === blocker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel name gate: an empty registry reads none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-channel-name-gate-"));
  try {
    assert.equal(channelNameBlocker(root, "nope"), "Channel not found: \"nope\". Channels: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel name gate: a folded name is refused with the correction", () => {
  const root = fresh();
  try {
    const dip = findChannel(root, "Dip Telegram");
    assert.equal(
      channelNameBlocker(root, "dip telegram"),
      "Channel not found: \"dip telegram\". Channels: Dip Telegram (" + dip.id + "), owner-alerts (" + findChannel(root, "owner-alerts").id + "). Did you mean \"Dip Telegram\" (" + dip.id + ")?",
    );
    assert.match(channelNameBlocker(root, "OWNER_ALERTS")!, /Did you mean "owner-alerts"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel name gate: the pairing door throws the ONE source before issuing anything", () => {
  const root = fresh();
  try {
    assert.throws(() => issuePairingCode(root, "dip telegram"), (e: unknown) => e instanceof Error && e.message === channelNameBlocker(root, "dip telegram"));
    const issued = issuePairingCode(root, "Dip Telegram");
    assert.equal(issued.channel, "Dip Telegram");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

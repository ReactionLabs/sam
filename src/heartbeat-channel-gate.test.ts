import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import { addHeartbeatJob, heartbeatChannelBlocker, heartbeatJobs } from "./heartbeat.js";

// The channel gate for heartbeat job creation doors:
// validateHeartbeatDetail refused a channelId outside the
// registry, and the brief / self-work installers validated
// their channels at their doors - but the two CLI doors
// (heartbeats add / schedule --channel) passed the raw id
// into the store, minting a job whose every delivery queues
// in the outbox and fails at deliverToChannel ("Delivery
// channel not found") across ticks. heartbeatChannelBlocker
// is now the ONE source carrying the gate's exact refusal
// text: the gate rides it and both CLI doors throw it before
// creating anything. The store itself stays permissive by
// design (a channel removed after a job names it must queue
// and fail in the outbox, never silently - the delivery-door
// tests pin that), so addHeartbeatJob is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-hb-channel-gate-")); }

function detail(channelId: string): string {
  return JSON.stringify({ name: "morning check", minutes: 60, profile: "sam", prompt: "do the check", channelId });
}

test("heartbeat channel gate: no channel and a registered channel read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(heartbeatChannelBlocker(root, null), null);
    assert.equal(heartbeatChannelBlocker(root, undefined), null);
    assert.equal(heartbeatChannelBlocker(root, ""), null);
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
    assert.equal(heartbeatChannelBlocker(root, channel.id), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel gate: an unknown channel names the registry, or none registered", () => {
  const root = fresh();
  try {
    assert.equal(
      heartbeatChannelBlocker(root, "chan-gone"),
      "Unknown channel \"chan-gone\" in heartbeat detail. Valid channels: none registered",
    );
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
    assert.equal(
      heartbeatChannelBlocker(root, "chan-gone"),
      "Unknown channel \"chan-gone\" in heartbeat detail. Valid channels: Dip Telegram (" + channel.id + ")",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel gate: a proposal naming a bogus channel refuses in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    const blocker = heartbeatChannelBlocker(root, "chan-gone");
    assert.ok(blocker);
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail("chan-gone") }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel gate: a proposal naming a registered channel pends cleanly", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail(channel.id) });
    assert.equal(a.status, "pending");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel gate: the store stays permissive - a job may name a channel removed later", () => {
  const root = fresh();
  try {
    // The delivery-door seam: creation doors check the
    // registry, the store does not - a job whose channel is
    // removed after creation queues and fails in the outbox
    // (pinned by the delivery-door tests), so the direct
    // store door must keep accepting the id.
    const job = addHeartbeatJob(root, "morning check", 60, "sam", "do the check", "chan-1");
    assert.equal(job.channelId, "chan-1");
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

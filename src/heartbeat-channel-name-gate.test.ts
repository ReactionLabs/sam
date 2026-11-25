import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import { addHeartbeatJob, heartbeatChannelBlocker, heartbeatChannelId, heartbeatJobs } from "./heartbeat.js";

// The heartbeat channel NAME gate: every other door that
// names a channel accepts it by name or id and resolves
// to the id (the brief and self-work installers, the
// channel bind / pair doors, and the connector pin doors
// at 17:04 for the same two-shape field) - but the
// heartbeat doors accepted only the channel ID, so a
// channel NAME, the value an operator naturally types
// and a unique value in the registry, was refused as
// "Unknown channel" by a refusal that itself listed
// that channel by name (id). heartbeatChannelId in
// heartbeat.ts now resolves a registered name or id to
// the id, and heartbeatChannelBlocker - the ONE source -
// accepts both shapes, its refusal gaining the fold
// correction when exactly one registered name matches.
// Both CLI doors resolve through the source before
// creating anything, and proposeAction resolves a named
// channelId to the id in the stored card detail, so
// execution delivers exactly as an id-named proposal
// does. addHeartbeatJob / addScheduledJob stay
// permissive by design (a channel removed after a job
// names it keeps its stored id and its deliveries queue
// and fail in the outbox), so they are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-hb-channel-name-gate-")); }

function detail(channelId: string): string {
  return JSON.stringify({ name: "morning check", minutes: 60, profile: "sam", prompt: "do the check", channelId });
}

test("heartbeat channel name gate: no channel, a registered id, and a registered name read no blocker and resolve", () => {
  const root = fresh();
  try {
    assert.equal(heartbeatChannelBlocker(root, null), null);
    assert.equal(heartbeatChannelBlocker(root, undefined), null);
    assert.equal(heartbeatChannelBlocker(root, ""), null);
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
    assert.equal(heartbeatChannelBlocker(root, channel.id), null);
    assert.equal(heartbeatChannelBlocker(root, "Dip Telegram"), null);
    assert.equal(heartbeatChannelId(root, channel.id), channel.id);
    assert.equal(heartbeatChannelId(root, "Dip Telegram"), channel.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel name gate: an unknown channel names the registry and the fold correction", () => {
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
    assert.equal(
      heartbeatChannelBlocker(root, "dip telegram"),
      "Unknown channel \"dip telegram\" in heartbeat detail. Valid channels: Dip Telegram (" + channel.id + "). Did you mean \"Dip Telegram\" (" + channel.id + ")?",
    );
    assert.equal(heartbeatChannelId(root, "chan-gone"), null);
    assert.equal(heartbeatChannelId(root, "dip telegram"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel name gate: a proposal naming a bogus channel refuses in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
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

test("heartbeat channel name gate: a proposal naming a channel by name pends with the resolved id in its stored detail", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", []);
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail("Dip Telegram") });
    assert.equal(a.status, "pending");
    const stored = JSON.parse(a.detail) as { channelId?: string };
    assert.equal(stored.channelId, channel.id);
    assert.equal(listActions(root).length, 1);
    // An id-named proposal stores the id unchanged.
    const b = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check two", detail: JSON.stringify({ name: "morning check two", minutes: 60, profile: "sam", prompt: "do the check", channelId: channel.id }) });
    assert.equal((JSON.parse(b.detail) as { channelId?: string }).channelId, channel.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat channel name gate: the store stays permissive - a job may name a channel removed later", () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "morning check", 60, "sam", "do the check", "chan-1");
    assert.equal(job.channelId, "chan-1");
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

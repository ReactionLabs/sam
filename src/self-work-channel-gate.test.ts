import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSelfWork, selfWorkStatus } from "./self-work.js";
import { addChannel } from "./channels.js";
import { heartbeatChannelBlocker, heartbeatJobs } from "./heartbeat.js";

// The self-work install channel gate: installSelfWork creates
// the standing wall-clock script job (sam-self-work) through
// addScheduledJob - it IS a heartbeat creation door - but it
// resolved the delivery channel through its own inline find
// and refused a miss with its own text ("Unknown channel
// 'X'. Channels: <names only>"), no ids and no fold
// correction, while every sibling heartbeat creation door
// (the ONE gate's heartbeat validation, both CLI heartbeat
// doors, the brief install door) throws
// heartbeatChannelBlocker from heartbeat.ts, the ONE source,
// before creating anything. installSelfWork now throws that
// same source before creating anything (the already-
// installed check still fires first, as its pinned test
// orders it) and resolves a passing name to its id through
// heartbeatChannelId, exactly as the CLI heartbeat doors do.
// addScheduledJob and the job store stay permissive by
// design, so they are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-self-work-channel-gate-")); }

test("self-work channel gate: an unknown channel refuses in the ONE source's words, naming the registry with ids, and installs nothing", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Owner Alerts", "sam", "SAM_CHANNEL_TG_MAIN", []);
    assert.throws(
      () => installSelfWork(root, { channelId: "nope" }),
      new Error("Unknown channel \"nope\" in heartbeat detail. Valid channels: Owner Alerts (" + channel.id + ")"),
    );
    assert.equal(selfWorkStatus(root).installed, false);
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work channel gate: a folded channel name refuses with the correction and installs nothing", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "owner-alerts", "sam", "SAM_CHANNEL_TG_MAIN", []);
    assert.throws(
      () => installSelfWork(root, { channelId: "Owner Alerts" }),
      new Error("Unknown channel \"Owner Alerts\" in heartbeat detail. Valid channels: owner-alerts (" + channel.id + "). Did you mean \"owner-alerts\" (" + channel.id + ")?"),
    );
    assert.equal(selfWorkStatus(root).installed, false);
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work channel gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    addChannel(root, "telegram", "owner-alerts", "sam", "SAM_CHANNEL_TG_MAIN", []);
    addChannel(root, "telegram", "Owner Alerts", "sam", "SAM_CHANNEL_TG_ALT", []);
    const blocker = heartbeatChannelBlocker(root, "OWNER ALERTS");
    assert.ok(blocker !== null && !blocker.includes("Did you mean"), "two folded matches, no correction offered");
    assert.throws(() => installSelfWork(root, { channelId: "OWNER ALERTS" }), new Error(blocker));
    assert.equal(selfWorkStatus(root).installed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work channel gate: a registered channel by name and by id installs with the id stored", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Owner Alerts", "sam", "SAM_CHANNEL_TG_MAIN", []);
    const byName = installSelfWork(root, { channelId: "Owner Alerts" });
    assert.equal(byName.channelId, channel.id, "the name resolved to the id through the ONE source");
    assert.equal(selfWorkStatus(root).installed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const root2 = fresh();
  try {
    const channel = addChannel(root2, "telegram", "Owner Alerts", "sam", "SAM_CHANNEL_TG_MAIN", []);
    const byId = installSelfWork(root2, { channelId: channel.id });
    assert.equal(byId.channelId, channel.id);
  } finally { rmSync(root2, { recursive: true, force: true }); }
});

test("self-work channel gate: the already-installed refusal still fires before channel validation", () => {
  const root = fresh();
  try {
    installSelfWork(root, {});
    assert.throws(() => installSelfWork(root, { channelId: "nope" }), /already installed/);
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

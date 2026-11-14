import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  addChannel, channelFailureSummary, channels, getChannel, isChannelLedgered,
} from "./channels.js";
import { classifyDefect } from "./self-work.js";

// Channel store failure visibility (gap found 2026-11-14,
// hourly run 13:04): channels() is the one read door for
// the channel registry - the Telegram bridge, pairing,
// bindings, heartbeat delivery, status, and the CLI all
// ride it - and every touch was unguarded: a dead store
// threw raw into whichever catch wrapped the call, none
// naming the store. Each read touch now ledgers ONE
// channel-failed line (phase read for channels(), phase
// lookup for getChannel()) and rethrows exactly, tagged;
// every caller's handling is unchanged.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-channels-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "channel-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "channels.db"), { recursive: true });
}

test("channel-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(channelFailureSummary("read", "unable to open\n  database   file"), "Channel read failed: unable to open database file");
  assert.equal(channelFailureSummary("lookup", "disk gone"), "Channel lookup failed: disk gone");
  assert.equal(channelFailureSummary("read", "x".repeat(500)).length, 200);
  assert.equal(channelFailureSummary("lookup", "x".repeat(500)).length, 200);
  for (const phase of ["read", "lookup"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "channel-failed", summary: channelFailureSummary(phase, "boom") }),
      { key: "channel-failed:" + phase, label: "channel store failures (" + phase + " step)" },
    );
  }
});

test("channel-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    assert.throws(() => channels(root), (e: unknown) => isChannelLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Channel read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "channel-failed:read", label: "channel store failures (read step)" });

    assert.throws(() => getChannel(root, "chan-1"), (e: unknown) => isChannelLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line, never two for one touch");
    assert.equal(lines[1].actor, "sam");
    assert.ok(lines[1].summary.startsWith("Channel lookup failed: "), lines[1].summary);
    assert.deepEqual(classifyDefect(lines[1]), { key: "channel-failed:lookup", label: "channel store failures (lookup step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel-failed: an absent store reads no channels, finds nothing, and creates nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(channels(root), []);
    assert.equal(getChannel(root, "chan-1"), null);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "channels.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel-failed: a healthy registry reads back with zero failure lines and no record leaks", () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TELEGRAM_MAIN", [42]);
    assert.equal(channels(root).length, 1);
    assert.equal(getChannel(root, channel.id)?.name, "Dip Telegram");
    assert.equal(getChannel(root, "no-such-id"), null);
    assert.equal(failedLines(root).length, 0);
    assert.ok(!JSON.stringify(failedLines(root)).includes("Dip Telegram"), "no channel record ever enters a failure line");
    assert.ok(!JSON.stringify(failedLines(root)).includes("SAM_CHANNEL_TELEGRAM_MAIN"), "no credential env name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

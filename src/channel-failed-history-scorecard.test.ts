import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelFailedHistoryScorecardText, channelFailureSummary, parseChannelFailedSummary } from "./channels.js";
import { recordActivity } from "./activity.js";
import { captureGuardFailureSummary } from "./capture-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The channel failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the channel
// registry's read doors ledger every failure as a
// channel-failed line through the ONE writer
// (channelFailureSummary, fixed shapes: "Channel read failed:
// <reason>" / "Channel lookup failed: <reason>", phases read /
// lookup, ridden by recordChannelFailure from channels() and
// getChannel(), actor sam) - and while self-work labels single
// lines and the bridge folds count the bridge's own kinds, no
// surface folds this kind, so which phase of the registry every
// outside surface rides failed was invisible in aggregate.
// Every failure line is by construction a registry touch that
// did not complete, so the verdict is attention when any
// failure was ever recorded or any line is unparseable, else
// clear. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no reason, and no verbatim summary - the
// summaries carry reasons, and the fold consumes and never
// prints them, and no channel record ever surfaces. The
// scorecard path is a pure read - it creates nothing, updates
// nothing, and reads no channel record; every state here is
// built through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-channel-failed-history-"));
}

const BARE = "Channel failed history: clear, 0 failed, 0 read, 0 lookup, 0 total";

test("channel failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = channelFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = channelFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held channel scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("channel failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = channelFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "channel-failed", channelFailureSummary("read", "unable to open sekrit database"));
    recordActivity(dir, "sam", "channel-failed", channelFailureSummary("lookup", "disk full"));
    recordActivity(dir, "sam", "channel-failed", channelFailureSummary("lookup", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = channelFailedHistoryScorecardText(dir);
    assert.equal(text, "Channel failed history: attention, 3 failed, 1 read, 2 lookup, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("channel failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = channelFailureSummary("lookup", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseChannelFailedSummary(capped), { phase: "lookup" });
    recordActivity(dir, "sam", "channel-failed", capped);
    recordActivity(dir, "sam", "channel-failed", channelFailureSummary("read", "boom"));
    const text = channelFailedHistoryScorecardText(dir);
    assert.equal(text, "Channel failed history: attention, 2 failed, 1 read, 1 lookup, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("channel failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "channel-failed", channelFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "channel-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "channel-failed", captureGuardFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "channel-failed", "Channel read failed:   ");
    recordActivity(dir, "sam", "channel-failed", "Channel delete failed: boom");
    const text = channelFailedHistoryScorecardText(dir);
    assert.equal(text, "Channel failed history: attention, 1 failed, 1 read, 0 lookup, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("channel failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(channelFailureSummary("read", "database is locked"), "Channel read failed: database is locked");
  assert.equal(channelFailureSummary("lookup", "disk gone"), "Channel lookup failed: disk gone");
  assert.deepEqual(parseChannelFailedSummary(channelFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseChannelFailedSummary(channelFailureSummary("lookup", "boom")), { phase: "lookup" });
  assert.equal(parseChannelFailedSummary(""), null);
  assert.equal(parseChannelFailedSummary("Channel read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseChannelFailedSummary("Channel read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseChannelFailedSummary("Channel delete failed: boom"), null, "a phase the registry never writes does not parse");
  assert.equal(parseChannelFailedSummary(captureGuardFailureSummary("read", "boom")), null, "a capture-guard-failed line never parses as a channel-failed line");
  assert.deepEqual(parseChannelFailedSummary("Channel lookup failed: boom: with colon"), { phase: "lookup" }, "a reason carrying a colon still parses from the fixed head");
});

test("channel failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-channel-store-failed-history"), "sam-channel-store-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-channel-store-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "store-failed-history"], "the argv rides channels store-failed-history");
});

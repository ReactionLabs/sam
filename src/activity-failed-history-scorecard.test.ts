import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFailedHistoryScorecardText, activityFailureSummary, parseActivityFailedSummary, recordActivity } from "./activity.js";
import { sourceCitationFailureSummary } from "./source-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The activity failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the activity
// ledger's own read seam ledgers every dead read as an
// activity-failed line through the ONE writer
// activityFailureSummary, ridden by the one seam
// recordActivityFailure (a failed filesystem touch on
// readActivity attempts ONE line and rethrows exactly,
// fail-closed, because this ledger is the record every
// failure kind lands in) - but the class was never folded,
// so how often the ledger itself failed to read was
// invisible in aggregate: a blind instrument reports
// perfect health. Every failure line is by construction a
// ledger read that did not complete, so the verdict is
// attention when any failure was ever recorded or any line
// is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, and
// no verbatim reason - the summaries carry reasons, which
// can name paths and surfaces, and the fold consumes and
// never prints them. The scorecard path is a pure read - it
// creates nothing, sends nothing, and retries nothing;
// every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-activity-failed-history-"));
}

const BARE = "Activity failed history: clear, 0 failed, 0 total";

test("activity failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = activityFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = activityFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held activity scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity failed history scorecard: the writer's failures fold to counts, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = activityFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "activity-failed", activityFailureSummary("EISDIR: illegal operation on a directory, open sekrit-path"));
    recordActivity(dir, "sam", "activity-failed", activityFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "activity-failed", activityFailureSummary("ENOSPC: no space left on device"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = activityFailedHistoryScorecardText(dir);
    assert.equal(text, "Activity failed history: attention, 3 failed, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = activityFailureSummary("x".repeat(500));
    assert.equal(capped.length, 300, "the writer caps its line at 300");
    assert.equal(capped, "Activity read failed: " + "x".repeat(278), "the cap keeps the fixed head");
    recordActivity(dir, "sam", "activity-failed", capped);
    assert.deepEqual(parseActivityFailedSummary(capped), { matched: true });
    const text = activityFailedHistoryScorecardText(dir);
    assert.equal(text, "Activity failed history: attention, 1 failed, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "activity-failed", activityFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "activity-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "activity-failed", sourceCitationFailureSummary("attach", new Error("boom sekrit")));
    recordActivity(dir, "sam", "activity-failed", "Activity read failed:   ");
    const text = activityFailedHistoryScorecardText(dir);
    assert.equal(text, "Activity failed history: attention, 1 failed, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    activityFailureSummary("EPERM: operation not permitted"),
    "Activity read failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseActivityFailedSummary(activityFailureSummary("boom")), { matched: true });
  assert.equal(parseActivityFailedSummary(""), null);
  assert.equal(parseActivityFailedSummary("Activity read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseActivityFailedSummary("Activity read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseActivityFailedSummary("Activity write failed: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseActivityFailedSummary(sourceCitationFailureSummary("attach", new Error("boom"))), null, "a source-citation-failed line never parses as an activity-failed line");
  assert.deepEqual(parseActivityFailedSummary("Activity read failed: boom: with colon"), { matched: true }, "a reason carrying a colon still parses from the fixed head");
});

test("activity failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-activity-failed-history"), "sam-activity-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-activity-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "activity-failed-history"], "the argv rides observe activity-failed-history");
});

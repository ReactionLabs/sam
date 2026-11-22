import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { consolidateFailedHistoryScorecardText, parseConsolidateFailedSummary, consolidationFailureSummary, heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The consolidate failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a consolidation
// sub-step that throws ledgers as a consolidate-failed line
// through the ONE writer consolidationFailureSummary, and
// self-work ranks the class as a defect keyed by step - but
// the class was never folded, so how often a sub-step died
// was invisible in aggregate. Every failure line is by
// construction a sub-step that did not complete, so the
// verdict is attention when any failure was ever recorded
// or any line is unparseable, else clear. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, no step name, and no verbatim reason - the
// summaries carry step names and reasons, which the fold
// consumes and never prints; the corrections count is a
// number in the shape, summed as affected messages. The
// scorecard path is a pure read - it creates nothing,
// sends nothing, retries nothing, and runs no
// consolidation; every state here is built through the
// ledger's own public door (recordActivity) with the
// seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-consolidate-failed-history-"));
}

const BARE = "Consolidate failed history: clear, 0 failed, 0 distinct steps, 0 affected messages, 0 total";

test("consolidate failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = consolidateFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = consolidateFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held consolidate scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consolidate failed history scorecard: the writer's failures fold to counts, and no step name or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = consolidateFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "consolidate-failed", consolidationFailureSummary("corrections", 2, "file is not a database, sekrit path"));
    recordActivity(dir, "sam", "consolidate-failed", consolidationFailureSummary("corrections", 3, "file is not a database"));
    recordActivity(dir, "sam", "consolidate-failed", consolidationFailureSummary("curator", 1, "unable to open database file"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = consolidateFailedHistoryScorecardText(dir);
    assert.equal(text, "Consolidate failed history: attention, 3 failed, 2 distinct steps, 5 affected messages, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("corrections"), false, "no step name surfaces");
    assert.equal(text.includes("curator"), false, "no step name surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consolidate failed history scorecard: the writer's own 200-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = consolidationFailureSummary("corrections", 2, "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "consolidate-failed", capped);
    assert.deepEqual(parseConsolidateFailedSummary(capped), { step: "corrections", messages: 2 });
    const text = consolidateFailedHistoryScorecardText(dir);
    assert.equal(text, "Consolidate failed history: attention, 1 failed, 1 distinct steps, 2 affected messages, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consolidate failed history scorecard: an unmatched shape, a bad plural, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "consolidate-failed", consolidationFailureSummary("curator", 1, "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "consolidate-failed", "Some wholly novel consolidate shape naming sekrit_evidence");
    recordActivity(dir, "sam", "consolidate-failed", "Consolidation correction routing failed for 1 messages: boom sekrit");
    recordActivity(dir, "sam", "consolidate-failed", "Consolidation skill curator failed:   ");
    const text = consolidateFailedHistoryScorecardText(dir);
    assert.equal(text, "Consolidate failed history: attention, 1 failed, 1 distinct steps, 0 affected messages, 4 total, 3 unparseable");
    assert.equal(text.includes("novel consolidate"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("curator"), false, "no step name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("consolidate failed parse: the writer's shapes parse exactly, and only the fixed shapes parse", () => {
  assert.deepEqual(parseConsolidateFailedSummary(consolidationFailureSummary("curator", 1, "boom")), { step: "curator", messages: 0 });
  assert.deepEqual(parseConsolidateFailedSummary(consolidationFailureSummary("corrections", 1, "boom")), { step: "corrections", messages: 1 });
  assert.deepEqual(parseConsolidateFailedSummary(consolidationFailureSummary("corrections", 4, "boom")), { step: "corrections", messages: 4 });
  assert.equal(parseConsolidateFailedSummary(""), null);
  assert.equal(parseConsolidateFailedSummary("Consolidation skill curator failed:"), null, "a line with no reason does not parse");
  assert.equal(parseConsolidateFailedSummary("Consolidation correction routing failed for 0 messages: boom"), null, "a zero count does not parse");
  assert.equal(parseConsolidateFailedSummary("Consolidation correction routing failed for 2 message: boom"), null, "a plural that disagrees with its count does not parse");
  assert.equal(parseConsolidateFailedSummary("Heartbeat tick stage 'jobs' failed: boom"), null, "a tick-failed line never parses as a consolidate line");
  assert.equal(parseConsolidateFailedSummary("Heartbeat log append failed for consolidate: boom"), null, "a heartbeat-log-failed line never parses as a consolidate line");
});

test("consolidate failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-consolidate-failed-history"), "sam-consolidate-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-consolidate-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "consolidate-failed-history"], "the argv rides heartbeats consolidate-failed-history");
});

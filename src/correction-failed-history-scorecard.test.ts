import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCorrectionFailedSummary, correctionFailedHistoryScorecardText, correctionFailureSummary } from "./corrections.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The correction failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the live turn's
// correction routing ledgers every failed routing as a
// correction-failed line through the ONE writer
// correctionFailureSummary (one fixed shape: "Correction
// propose failed for <actor>: <reason>", the one fixed phase
// propose), ridden by recordCorrectionFailure from the ONE
// seam tryRouteCorrection - but the class was never folded,
// so how often an owner's correction died at the routing (the
// turn continued without following it and without
// acknowledging a proposal) was invisible in aggregate. Every
// failure line is by construction a correction routing that
// did not complete, so the verdict is attention when any
// failure was ever recorded or any line is unparseable, else
// clear. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and no verbatim reason - the
// summaries carry actors and reasons, and the fold consumes
// and never prints them, and neither the owner's message text
// nor the correction statement ever surfaces (neither enters
// the writer's line either). The scorecard path is a pure
// read - it creates nothing, sends nothing, and routes
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-correction-failed-history-"));
}

const BARE = "Correction failed history: clear, 0 failed, 0 distinct actors, 0 total";

test("correction failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = correctionFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = correctionFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held correction scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction failed history scorecard: the writer's failures fold to counts with distinct actors as a number only, and no actor or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = correctionFailedHistoryScorecardText(dir);
    recordActivity(dir, "dip", "correction-failed", correctionFailureSummary("dip", "database is locked sekrit"));
    recordActivity(dir, "dip", "correction-failed", correctionFailureSummary("dip", "disk full"));
    recordActivity(dir, "trading", "correction-failed", correctionFailureSummary("trading", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "correction-failed", correctionFailureSummary("sam", "EACCES: permission denied"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = correctionFailedHistoryScorecardText(dir);
    assert.equal(text, "Correction failed history: attention, 4 failed, 3 distinct actors, 4 total");
    assert.equal(text.includes("dip"), false, "no actor surfaces");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
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

test("correction failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = correctionFailureSummary("dip", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseCorrectionFailedSummary(capped), { actor: "dip" });
    recordActivity(dir, "dip", "correction-failed", capped);
    const text = correctionFailedHistoryScorecardText(dir);
    assert.equal(text, "Correction failed history: attention, 1 failed, 1 distinct actors, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "correction-failed", correctionFailureSummary("dip", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "correction-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "correction-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "correction-failed", "Correction propose failed for dip:   ");
    recordActivity(dir, "sam", "correction-failed", "Correction delete failed for dip: boom");
    const text = correctionFailedHistoryScorecardText(dir);
    assert.equal(text, "Correction failed history: attention, 1 failed, 1 distinct actors, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(correctionFailureSummary("dip", "database is locked"), "Correction propose failed for dip: database is locked");
  assert.equal(correctionFailureSummary("sam", "database is locked"), "Correction propose failed for sam: database is locked");
  assert.deepEqual(parseCorrectionFailedSummary(correctionFailureSummary("dip", "boom")), { actor: "dip" });
  assert.deepEqual(parseCorrectionFailedSummary(correctionFailureSummary("second-shift", "boom")), { actor: "second-shift" });
  assert.equal(parseCorrectionFailedSummary(""), null);
  assert.equal(parseCorrectionFailedSummary("Correction propose failed for dip:"), null, "a line with no reason does not parse");
  assert.equal(parseCorrectionFailedSummary("Correction propose failed for dip: "), null, "a line with a blank reason does not parse");
  assert.equal(parseCorrectionFailedSummary("Correction delete failed for dip: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseCorrectionFailedSummary("Correction propose failed for dip smith: boom"), null, "a multi-token actor does not parse");
  assert.equal(parseCorrectionFailedSummary("Correction propose failed for : boom"), null, "a line with no actor does not parse");
  assert.equal(parseCorrectionFailedSummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as a correction-failed line");
  assert.deepEqual(parseCorrectionFailedSummary("Correction propose failed for dip: boom: with colon"), { actor: "dip" }, "a reason carrying a colon still parses from the fixed head");
});

test("correction failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-correction-failed-history"), "sam-correction-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-correction-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["corrections", "failed-history"], "the argv rides corrections failed-history");
});

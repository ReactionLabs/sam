import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGuardFailedHistoryScorecardText, captureGuardFailureSummary, parseCaptureGuardFailedSummary } from "./capture-guard.js";
import { recordActivity } from "./activity.js";
import { artifactFailureSummary } from "./artifacts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The capture guard failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the capture guard
// store's touches ledger every failure as a capture-guard-failed
// line through the ONE writer (captureGuardFailureSummary, fixed
// shape: "Capture guard store <phase> failed: <reason>", phases
// read / write, ridden by recordCaptureGuardFailure from the
// store's touches, actor sam) - and while the suppression
// scorecard folds the guard's other two kinds, it never touches
// this kind, so which phase of the store that holds the owner's
// do-not-store instructions failed was invisible in aggregate.
// Every failure line is by construction a guard touch that did
// not complete its store work, so the verdict is attention when
// any failure was ever recorded or any line is unparseable, else
// clear. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no reason, and no verbatim summary - the
// summaries carry reasons, and the fold consumes and never
// prints them, and no suppression needle ever surfaces (a needle
// is an owner secret word and never enters the writer's line
// either). The scorecard path is a pure read - it creates
// nothing, suppresses nothing, and reads no suppression record;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-capture-guard-failed-history-"));
}

const BARE = "Capture guard failed history: clear, 0 failed, 0 read, 0 write, 0 total";

test("capture guard failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = captureGuardFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = captureGuardFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held capture guard scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture guard failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = captureGuardFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "capture-guard-failed", captureGuardFailureSummary("read", "unable to open sekrit database"));
    recordActivity(dir, "sam", "capture-guard-failed", captureGuardFailureSummary("write", "disk full"));
    recordActivity(dir, "sam", "capture-guard-failed", captureGuardFailureSummary("write", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = captureGuardFailedHistoryScorecardText(dir);
    assert.equal(text, "Capture guard failed history: attention, 3 failed, 1 read, 2 write, 3 total");
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

test("capture guard failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = captureGuardFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseCaptureGuardFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "capture-guard-failed", capped);
    recordActivity(dir, "sam", "capture-guard-failed", captureGuardFailureSummary("read", "boom"));
    const text = captureGuardFailedHistoryScorecardText(dir);
    assert.equal(text, "Capture guard failed history: attention, 2 failed, 1 read, 1 write, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture guard failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "capture-guard-failed", captureGuardFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "capture-guard-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "capture-guard-failed", artifactFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "capture-guard-failed", "Capture guard store read failed:   ");
    recordActivity(dir, "sam", "capture-guard-failed", "Capture guard store delete failed: boom");
    const text = captureGuardFailedHistoryScorecardText(dir);
    assert.equal(text, "Capture guard failed history: attention, 1 failed, 1 read, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture guard failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(captureGuardFailureSummary("read", "database is locked"), "Capture guard store read failed: database is locked");
  assert.equal(captureGuardFailureSummary("write", "disk gone"), "Capture guard store write failed: disk gone");
  assert.deepEqual(parseCaptureGuardFailedSummary(captureGuardFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseCaptureGuardFailedSummary(captureGuardFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseCaptureGuardFailedSummary(""), null);
  assert.equal(parseCaptureGuardFailedSummary("Capture guard store read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseCaptureGuardFailedSummary("Capture guard store read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseCaptureGuardFailedSummary("Capture guard store delete failed: boom"), null, "a phase the store never writes does not parse");
  assert.equal(parseCaptureGuardFailedSummary(artifactFailureSummary("read", "boom")), null, "an artifact-failed line never parses as a capture-guard-failed line");
  assert.deepEqual(parseCaptureGuardFailedSummary("Capture guard store read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("capture guard failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-capture-guard-failed-history"), "sam-capture-guard-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-capture-guard-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "capture-guard-failed-history"], "the argv rides observe capture-guard-failed-history");
});

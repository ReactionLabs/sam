import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { tickFailedHistoryScorecardText, tickFailedLedgerSummary, parseTickFailedSummary, heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The tick failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a heartbeat tick
// stage that throws ledgers as a tick-failed line through
// the ONE writer tickFailedLedgerSummary, and self-work
// ranks the class as a defect keyed by stage - but the
// class was never folded, so how often a tick lost a stage
// was invisible in aggregate. Every failure line is by
// construction a stage that did not complete, so the
// verdict is attention when any failure was ever recorded
// or any line is unparseable, else clear. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, no stage name, and no verbatim reason - the
// summaries carry stage names, which the fold consumes
// into a distinct count and never prints. The scorecard
// path is a pure read - it creates nothing, sends nothing,
// retries nothing, and runs no tick; every state here is
// built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tick-failed-history-"));
}

const BARE = "Tick failed history: clear, 0 failed, 0 distinct stages, 0 total";

test("tick failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = tickFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = tickFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held tick scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tick failed history scorecard: the writer's failures fold to counts, and no stage name or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = tickFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "tick-failed", tickFailedLedgerSummary("consolidate", "file is not a database, sekrit path"));
    recordActivity(dir, "sam", "tick-failed", tickFailedLedgerSummary("jobs", "file is not a database"));
    recordActivity(dir, "sam", "tick-failed", tickFailedLedgerSummary("jobs", "file is not a database"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = tickFailedHistoryScorecardText(dir);
    assert.equal(text, "Tick failed history: attention, 3 failed, 2 distinct stages, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("consolidate"), false, "no stage name surfaces");
    assert.equal(text.includes("jobs"), false, "no stage name surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tick failed history scorecard: the writer's own 200-char cap still folds from the stage head", () => {
  const dir = scratch();
  try {
    const capped = tickFailedLedgerSummary("consolidate", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "tick-failed", capped);
    assert.deepEqual(parseTickFailedSummary(capped), { stage: "consolidate" });
    const text = tickFailedHistoryScorecardText(dir);
    assert.equal(text, "Tick failed history: attention, 1 failed, 1 distinct stages, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tick failed history scorecard: an unmatched shape, an unknown stage, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "tick-failed", tickFailedLedgerSummary("loops", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "tick-failed", "Some wholly novel tick shape naming sekrit_evidence");
    recordActivity(dir, "sam", "tick-failed", "Heartbeat tick stage 'wizardry' failed: boom sekrit");
    recordActivity(dir, "sam", "tick-failed", "Heartbeat tick stage 'jobs' failed:   ");
    const text = tickFailedHistoryScorecardText(dir);
    assert.equal(text, "Tick failed history: attention, 1 failed, 1 distinct stages, 4 total, 3 unparseable");
    assert.equal(text.includes("novel tick"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("wizardry"), false, "an unknown stage is never printed");
    assert.equal(text.includes("loops"), false, "no stage name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tick failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    tickFailedLedgerSummary("consolidate", "file is not a database"),
    "Heartbeat tick stage 'consolidate' failed: file is not a database",
  );
  for (const stage of ["consolidate", "deliveries", "jobs", "background", "coding", "engine", "parallel", "loops"]) {
    assert.deepEqual(parseTickFailedSummary(tickFailedLedgerSummary(stage, "boom")), { stage });
  }
  assert.equal(parseTickFailedSummary(""), null);
  assert.equal(parseTickFailedSummary("Heartbeat tick stage 'jobs' failed:"), null, "a line with no reason does not parse");
  assert.equal(parseTickFailedSummary("Heartbeat tick stage 'jobs' failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseTickFailedSummary("Heartbeat tick stage 'wizardry' failed: boom"), null, "a stage the guard never runs does not parse");
  assert.equal(parseTickFailedSummary("Heartbeat log append failed for tick-failed: boom"), null, "a heartbeat-log-failed line never parses as a tick line");
  assert.equal(parseTickFailedSummary("Consolidation skill curator failed: boom"), null, "a consolidate-failed line never parses as a tick line");
});

test("tick failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-tick-failed-history"), "sam-tick-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-tick-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "tick-failed-history"], "the argv rides heartbeats tick-failed-history");
});

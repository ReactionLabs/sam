import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { backgroundDiedLedgerSummary, backgroundDoneLedgerSummary, backgroundFailedSummary, backgroundHistoryScorecardText, backgroundQueuedLedgerSummary, backgroundStartedLedgerSummary, parseBackgroundDoneSummary, parseBackgroundFailedSummary, parseBackgroundQueuedSummary, parseBackgroundStartedSummary } from "./background.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The background history daily-measurement wiring (2026-11-21,
// the measured-proof series): every background lifecycle event
// has ledgered as a background-queued / background-started /
// background-done / background-failed line since the legs
// landed - until now as inline concatenation at the seams,
// with no ONE writer and no fold, so how many tasks were ever
// handed off, started, finished, or failed was invisible in
// aggregate (listBackgroundTasks reads only the current
// store). A failure means a handed-off task never landed its
// result, so the verdict is attention only when any failure
// was ever recorded or a line is unparseable. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp, no
// actor, no title, no failure reason - the summaries carry
// task titles and failure reasons, which are the owner's
// words, and the fold consumes and never prints them. The
// scorecard path is a pure read - it creates nothing, queues
// nothing, and drains nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-background-history-"));
}

test("background history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = backgroundHistoryScorecardText(dir);
    assert.equal(text, "Background history: clear, 0 queued, 0 started, 0 done, 0 failed, 0 distinct titles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = backgroundHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held background scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("background history scorecard: the history folds to counts and distinct titles, and no title surfaces", () => {
  const dir = scratch();
  try {
    const clean = backgroundHistoryScorecardText(dir);
    recordActivity(dir, "trading", "background-queued", backgroundQueuedLedgerSummary("Sekrit Task Title"));
    recordActivity(dir, "trading", "background-started", backgroundStartedLedgerSummary("Sekrit Task Title"));
    recordActivity(dir, "trading", "background-done", backgroundDoneLedgerSummary("Sekrit Task Title"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = backgroundHistoryScorecardText(dir);
    assert.equal(text, "Background history: clear, 1 queued, 1 started, 1 done, 0 failed, 1 distinct titles, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no task title surfaces");
    assert.notEqual(text, clean, "the first recorded background task changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("background history scorecard: a failure is attention, counted in both shapes, with no title or reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "trading", "background-queued", backgroundQueuedLedgerSummary("Sekrit Task Title"));
    recordActivity(dir, "trading", "background-failed", backgroundFailedSummary("Sekrit Task Title", new Error("sekrit_reason_xyz")));
    recordActivity(dir, "researcher", "background-failed", backgroundDiedLedgerSummary("Other Sekrit Title"));
    const text = backgroundHistoryScorecardText(dir);
    assert.equal(text, "Background history: attention, 1 queued, 0 started, 0 done, 2 failed, 2 distinct titles, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no task title surfaces");
    assert.equal(text.includes("sekrit_reason_xyz"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("background history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "trading", "background-queued", backgroundQueuedLedgerSummary("Ordinary Task"));
    recordActivity(dir, "trading", "background-failed", "Some wholly novel background shape naming sekrit_evidence");
    const text = backgroundHistoryScorecardText(dir);
    assert.equal(text, "Background history: attention, 1 queued, 0 started, 0 done, 0 failed, 1 distinct titles, 2 total, 1 unparseable");
    assert.equal(text.includes("novel background"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("background parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(backgroundQueuedLedgerSummary("Research the thing"), "Handed off background task: Research the thing");
  assert.equal(backgroundStartedLedgerSummary("Research the thing"), "Background task started: Research the thing");
  assert.equal(backgroundDoneLedgerSummary("Research the thing"), "Background task finished in its chat: Research the thing");
  assert.equal(backgroundDiedLedgerSummary("Research the thing"), "Background task died mid-run: Research the thing");
  assert.equal(backgroundFailedSummary("Research the thing", new Error("boom")), "Background task failed: Research the thing - boom");
  assert.deepEqual(parseBackgroundQueuedSummary(backgroundQueuedLedgerSummary("Research the thing")), { title: "Research the thing" });
  assert.deepEqual(parseBackgroundStartedSummary(backgroundStartedLedgerSummary("Research the thing")), { title: "Research the thing" });
  assert.deepEqual(parseBackgroundDoneSummary(backgroundDoneLedgerSummary("Research the thing")), { title: "Research the thing" });
  assert.deepEqual(parseBackgroundFailedSummary(backgroundDiedLedgerSummary("Research the thing")), { title: "Research the thing" });
  assert.deepEqual(parseBackgroundFailedSummary(backgroundFailedSummary("Research the thing", new Error("boom"))), { title: "Research the thing" });
  assert.equal(parseBackgroundQueuedSummary(""), null);
  assert.equal(parseBackgroundQueuedSummary("Handed off background task: "), null, "an empty title does not parse");
  assert.equal(parseBackgroundQueuedSummary("Handed off background task:"), null, "a truncated line does not parse");
  assert.equal(parseBackgroundStartedSummary("Background task started:"), null, "a truncated line does not parse");
  assert.equal(parseBackgroundDoneSummary("Background task finished: Research the thing"), null, "a wrong shape does not parse");
  assert.equal(parseBackgroundFailedSummary("Background task failed: Research the thing"), null, "a drain failure with no reason does not parse");
  assert.equal(parseBackgroundFailedSummary("Background task died mid-run:"), null, "a truncated died line does not parse");
});

test("background history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-background-history"), "sam-background-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-background-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["background", "history"], "the argv rides background history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { engineBlockedLedgerSummary, engineDiedLedgerSummary, engineDoneLedgerSummary, engineFailedLedgerSummary, engineHistoryScorecardText, engineQueuedLedgerSummary, engineReviewLedgerSummary, engineStartedLedgerSummary, parseEngineBlockedSummary, parseEngineDoneSummary, parseEngineFailedSummary, parseEngineQueuedSummary, parseEngineReviewSummary, parseEngineStartedSummary } from "./engine.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The engine history daily-measurement wiring (2026-11-21,
// the measured-proof series): every managed engine run has
// ledgered as an engine-queued / engine-started /
// engine-done / engine-blocked / engine-failed /
// engine-review line since the C6 runtime landed - until
// now as inline concatenation at the seams, with no ONE
// writer and no fold, so how many runs were ever queued,
// started, verified done, blocked, failed, or reviewed was
// invisible in aggregate (engineStatus reads only the
// current store). A blocked or failed run means a run did
// not land verified, reviewed, and committed, so the
// verdict is attention only when any blocked or failed was
// ever recorded or a line is unparseable. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, no title, no provider label, no reason, no
// review verdict - the summaries carry task titles,
// provider labels, and closing reasons, which are the
// owner's words, and the fold consumes and never prints
// them. The scorecard path is a pure read - it creates
// nothing, queues nothing, and drains nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-engine-history-"));
}

test("engine history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = engineHistoryScorecardText(dir);
    assert.equal(text, "Engine history: clear, 0 queued, 0 started, 0 done, 0 blocked, 0 failed, 0 reviews, 0 distinct titles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = engineHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held engine scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("engine history scorecard: the history folds to counts and distinct titles, and no title or provider surfaces", () => {
  const dir = scratch();
  try {
    const clean = engineHistoryScorecardText(dir);
    recordActivity(dir, "sam", "engine-queued", engineQueuedLedgerSummary("Sekrit Provider", "Sekrit Task Title"));
    recordActivity(dir, "sam", "engine-started", engineStartedLedgerSummary("Sekrit Task Title"));
    recordActivity(dir, "sam", "engine-review", engineReviewLedgerSummary("PASS", "Sekrit Task Title"));
    recordActivity(dir, "sam", "engine-done", engineDoneLedgerSummary("Sekrit Task Title", 3));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = engineHistoryScorecardText(dir);
    assert.equal(text, "Engine history: clear, 1 queued, 1 started, 1 done, 0 blocked, 0 failed, 1 reviews, 1 distinct titles, 4 total");
    assert.equal(text.includes("Sekrit"), false, "no task title or provider label surfaces");
    assert.notEqual(text, clean, "the first recorded engine run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("engine history scorecard: a blocked or failed run is attention, counted in both failed shapes, with no title or reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "engine-queued", engineQueuedLedgerSummary("Claude Code", "Sekrit Task Title"));
    recordActivity(dir, "sam", "engine-blocked", engineBlockedLedgerSummary("Sekrit Task Title", "sekrit_block_reason"));
    recordActivity(dir, "sam", "engine-failed", engineFailedLedgerSummary("Sekrit Task Title", "sekrit_fail_reason"));
    recordActivity(dir, "sam", "engine-failed", engineDiedLedgerSummary("Other Sekrit Title"));
    const text = engineHistoryScorecardText(dir);
    assert.equal(text, "Engine history: attention, 1 queued, 0 started, 0 done, 1 blocked, 2 failed, 0 reviews, 2 distinct titles, 4 total");
    assert.equal(text.includes("Sekrit"), false, "no task title surfaces");
    assert.equal(text.includes("sekrit_block_reason"), false, "no blocked reason surfaces");
    assert.equal(text.includes("sekrit_fail_reason"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("engine history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "engine-queued", engineQueuedLedgerSummary("Codex", "Ordinary Task"));
    recordActivity(dir, "sam", "engine-failed", "Some wholly novel engine shape naming sekrit_evidence");
    const text = engineHistoryScorecardText(dir);
    assert.equal(text, "Engine history: attention, 1 queued, 0 started, 0 done, 0 blocked, 0 failed, 0 reviews, 1 distinct titles, 2 total, 1 unparseable");
    assert.equal(text.includes("novel engine"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("engine parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(engineQueuedLedgerSummary("Claude Code", "Fix the thing"), "Queued engine run (Claude Code): Fix the thing");
  assert.equal(engineStartedLedgerSummary("Fix the thing"), "Engine run started: Fix the thing");
  assert.equal(engineDoneLedgerSummary("Fix the thing", 3), "Engine run done and verified: Fix the thing (3 file(s))");
  assert.equal(engineBlockedLedgerSummary("Fix the thing", "boom"), "Engine run blocked: Fix the thing - boom");
  assert.equal(engineFailedLedgerSummary("Fix the thing", "boom"), "Engine run failed: Fix the thing - boom");
  assert.equal(engineDiedLedgerSummary("Fix the thing"), "Engine run died mid-run: Fix the thing");
  assert.equal(engineReviewLedgerSummary("PASS", "Fix the thing"), "Self-review PASS for engine run: Fix the thing");
  assert.equal(engineBlockedLedgerSummary("Fix the thing", "x".repeat(200)), "Engine run blocked: Fix the thing - " + "x".repeat(120), "the blocked writer owns the 120-char reason cap");
  assert.equal(engineFailedLedgerSummary("Fix the thing", "x".repeat(200)), "Engine run failed: Fix the thing - " + "x".repeat(120), "the failed writer owns the 120-char reason cap");
  assert.deepEqual(parseEngineQueuedSummary(engineQueuedLedgerSummary("Claude Code", "Fix the thing")), { provider: "Claude Code", title: "Fix the thing" });
  assert.deepEqual(parseEngineStartedSummary(engineStartedLedgerSummary("Fix the thing")), { title: "Fix the thing" });
  assert.deepEqual(parseEngineDoneSummary(engineDoneLedgerSummary("Fix the thing", 3)), { title: "Fix the thing", files: 3 });
  assert.deepEqual(parseEngineBlockedSummary(engineBlockedLedgerSummary("Fix the thing", "boom")), { title: "Fix the thing" });
  assert.deepEqual(parseEngineFailedSummary(engineFailedLedgerSummary("Fix the thing", "boom")), { title: "Fix the thing" });
  assert.deepEqual(parseEngineFailedSummary(engineDiedLedgerSummary("Fix the thing")), { title: "Fix the thing" });
  assert.deepEqual(parseEngineReviewSummary(engineReviewLedgerSummary("PASS", "Fix the thing")), { verdict: "PASS", title: "Fix the thing" });
  assert.equal(parseEngineQueuedSummary(""), null);
  assert.equal(parseEngineQueuedSummary("Queued engine run (Claude Code): "), null, "an empty title does not parse");
  assert.equal(parseEngineQueuedSummary("Queued engine run: Fix the thing"), null, "a queued line with no provider does not parse");
  assert.equal(parseEngineStartedSummary("Engine run started:"), null, "a truncated line does not parse");
  assert.equal(parseEngineDoneSummary("Engine run done: Fix the thing"), null, "a wrong shape does not parse");
  assert.equal(parseEngineDoneSummary("Engine run done and verified: Fix the thing (three file(s))"), null, "a non-numeric file count does not parse");
  assert.equal(parseEngineBlockedSummary("Engine run blocked: Fix the thing"), null, "a blocked line with no reason does not parse");
  assert.equal(parseEngineFailedSummary("Engine run failed: Fix the thing"), null, "a failed line with no reason does not parse");
  assert.equal(parseEngineFailedSummary("Engine run died mid-run:"), null, "a truncated died line does not parse");
  assert.equal(parseEngineReviewSummary("Self-review for engine run: Fix the thing"), null, "a review line with no verdict does not parse");
});

test("engine history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-engine-history"), "sam-engine-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-engine-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["engine", "history"], "the argv rides engine history");
});

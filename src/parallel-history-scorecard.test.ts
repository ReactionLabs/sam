import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parallelBlockedLedgerSummary, parallelDiedLedgerSummary, parallelDoneLedgerSummary, parallelFailedLedgerSummary, parallelHistoryScorecardText, parallelMergeLedgerSummary, parallelQueuedLedgerSummary, parallelReviewLedgerSummary, parallelSliceLedgerSummary, parallelStartedLedgerSummary, parallelSurveyLedgerSummary, parallelVerifyLedgerSummary, parseParallelBlockedSummary, parseParallelDoneSummary, parseParallelFailedSummary, parseParallelMergeSummary, parseParallelQueuedSummary, parseParallelReviewSummary, parseParallelSliceSummary, parseParallelStartedSummary, parseParallelSurveySummary, parseParallelVerifySummary, type RepoSurvey } from "./parallel-coding.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The parallel history daily-measurement wiring (2026-11-21,
// the measured-proof series): every parallel job has ledgered
// across ten classes (parallel-queued / parallel-started /
// parallel-done / parallel-blocked / parallel-failed /
// parallel-survey / parallel-slice / parallel-merge /
// parallel-verify / parallel-review) since Program E landed
// - until now as inline concatenation at the seams, with no
// ONE writer and no fold, so how many jobs were ever queued,
// started, verified done, blocked, failed, surveyed, sliced,
// conflicted, verified, or reviewed was invisible in
// aggregate (parallelSummary reads only the current store).
// A blocked or failed job means a job did not land merged,
// verified, and reviewed, so the verdict is attention only
// when any blocked or failed was ever recorded or a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no title, no provider
// label, no slice name, no branch, no survey fact, no
// reason, no review verdict - the summaries carry job
// titles, slice names, and closing reasons, which are the
// owner's words, and the fold consumes and never prints
// them. The distinct-title count is taken from the queued
// lines only, the one line each job writes exactly once, so
// a slice error or review blocker riding another line's
// title can never inflate it. The scorecard path is a pure
// read - it creates nothing, queues nothing, and drains
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-parallel-history-"));
}

const SURVEY: RepoSurvey = {
  baseSha: "abcdef0123456789",
  branch: "main",
  fileCount: 42,
  files: [],
  filesTruncated: false,
  byExtension: { ts: 40, md: 2 },
  keyFiles: ["package.json"],
  scripts: { build: "tsc", test: "node --test" },
};

test("parallel history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = parallelHistoryScorecardText(dir);
    assert.equal(text, "Parallel history: clear, 0 queued, 0 started, 0 done, 0 blocked, 0 failed, 0 surveys, 0 slices, 0 slices done, 0 slices failed, 0 slices conflicted, 0 merges, 0 verifies, 0 reviews, 0 distinct titles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = parallelHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held parallel scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parallel history scorecard: the history folds to counts and distinct titles, and no title, slice, or survey fact surfaces", () => {
  const dir = scratch();
  try {
    const clean = parallelHistoryScorecardText(dir);
    recordActivity(dir, "sam", "parallel-queued", parallelQueuedLedgerSummary(2, 4, "claude-code", "Sekrit Job Title"));
    recordActivity(dir, "sam", "parallel-started", parallelStartedLedgerSummary("Sekrit Job Title", 2, 4));
    recordActivity(dir, "sam", "parallel-survey", parallelSurveyLedgerSummary(SURVEY));
    recordActivity(dir, "sam", "parallel-slice", parallelSliceLedgerSummary("sekrit-slice", "done", "Sekrit Job Title", null));
    recordActivity(dir, "sam", "parallel-review", parallelReviewLedgerSummary("PASS", "Sekrit Job Title", ""));
    recordActivity(dir, "sam", "parallel-done", parallelDoneLedgerSummary("Sekrit Job Title", 3, 2, 1500));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = parallelHistoryScorecardText(dir);
    assert.equal(text, "Parallel history: clear, 1 queued, 1 started, 1 done, 0 blocked, 0 failed, 1 surveys, 1 slices, 1 slices done, 0 slices failed, 0 slices conflicted, 0 merges, 0 verifies, 1 reviews, 1 distinct titles, 6 total");
    assert.equal(text.includes("Sekrit"), false, "no job title surfaces");
    assert.equal(text.includes("sekrit-slice"), false, "no slice name surfaces");
    assert.equal(text.includes("abcdef012345"), false, "no survey base surfaces");
    assert.notEqual(text, clean, "the first recorded parallel job changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parallel history scorecard: a blocked or failed job is attention, counted in both failed shapes, with no title or reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "parallel-queued", parallelQueuedLedgerSummary(2, 4, "claude-code", "Sekrit Job Title"));
    recordActivity(dir, "sam", "parallel-blocked", parallelBlockedLedgerSummary("Sekrit Job Title", "sekrit_block_reason"));
    recordActivity(dir, "sam", "parallel-failed", parallelFailedLedgerSummary("Sekrit Job Title", "sekrit_fail_reason"));
    recordActivity(dir, "sam", "parallel-failed", parallelDiedLedgerSummary("Other Sekrit Title"));
    recordActivity(dir, "sam", "parallel-slice", parallelSliceLedgerSummary("sekrit-slice", "failed", "Sekrit Job Title", "sekrit_slice_error"));
    recordActivity(dir, "sam", "parallel-merge", parallelMergeLedgerSummary("sekrit-slice", "sam/par-sekrit00", ["sekrit-file.ts"]));
    const text = parallelHistoryScorecardText(dir);
    assert.equal(text, "Parallel history: attention, 1 queued, 0 started, 0 done, 1 blocked, 2 failed, 0 surveys, 1 slices, 0 slices done, 1 slices failed, 0 slices conflicted, 1 merges, 0 verifies, 0 reviews, 1 distinct titles, 6 total");
    assert.equal(text.includes("Sekrit"), false, "no job title surfaces");
    assert.equal(text.includes("sekrit_block_reason"), false, "no blocked reason surfaces");
    assert.equal(text.includes("sekrit_fail_reason"), false, "no failure reason surfaces");
    assert.equal(text.includes("sekrit-file"), false, "no conflicted file surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parallel history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "parallel-queued", parallelQueuedLedgerSummary(1, 4, "codex", "Ordinary Job"));
    recordActivity(dir, "sam", "parallel-failed", "Some wholly novel parallel shape naming sekrit_evidence");
    const text = parallelHistoryScorecardText(dir);
    assert.equal(text, "Parallel history: attention, 1 queued, 0 started, 0 done, 0 blocked, 0 failed, 0 surveys, 0 slices, 0 slices done, 0 slices failed, 0 slices conflicted, 0 merges, 0 verifies, 0 reviews, 1 distinct titles, 2 total, 1 unparseable");
    assert.equal(text.includes("novel parallel"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parallel parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(parallelQueuedLedgerSummary(2, 4, "claude-code", "Fix the thing"), "Queued parallel job (2 slices, concurrency 4, engine claude-code): Fix the thing");
  assert.equal(parallelStartedLedgerSummary("Fix the thing", 2, 4), "Parallel job started: Fix the thing (2 slices, concurrency 4)");
  assert.equal(parallelDoneLedgerSummary("Fix the thing", 3, 2, 1500), "Parallel job done: Fix the thing (3 files, 2 slices, 1.5s)");
  assert.equal(parallelBlockedLedgerSummary("Fix the thing", "boom"), "Parallel job blocked: Fix the thing - boom");
  assert.equal(parallelFailedLedgerSummary("Fix the thing", "boom"), "Parallel job failed: Fix the thing - boom");
  assert.equal(parallelDiedLedgerSummary("Fix the thing"), "Parallel job died mid-run: Fix the thing");
  assert.equal(parallelSurveyLedgerSummary(SURVEY), "Repo survey at abcdef012345 (branch main): 42 files (ts x40, md x2); key files: package.json; scripts: build, test.");
  assert.equal(parallelSliceLedgerSummary("alpha", "done", "Fix the thing", null), "Slice alpha done for parallel job: Fix the thing");
  assert.equal(parallelSliceLedgerSummary("alpha", "failed", "Fix the thing", "boom"), "Slice alpha failed for parallel job: Fix the thing - boom");
  assert.equal(parallelMergeLedgerSummary("alpha", "sam/par-abc12345", ["a.ts", "b.ts"]), "Slice alpha conflicted merging into sam/par-abc12345 (a.ts, b.ts)");
  assert.equal(parallelMergeLedgerSummary("alpha", "sam/par-abc12345", []), "Slice alpha conflicted merging into sam/par-abc12345");
  assert.equal(parallelVerifyLedgerSummary(1, "Fix the thing", true, false), "Coordinator fix iteration 1 for parallel job: Fix the thing - build pass, test FAIL");
  assert.equal(parallelVerifyLedgerSummary(2, "Fix the thing", null, null), "Coordinator fix iteration 2 for parallel job: Fix the thing - build n/a, test n/a");
  assert.equal(parallelReviewLedgerSummary("PASS", "Fix the thing", ""), "Self-review PASS for parallel job: Fix the thing");
  assert.equal(parallelReviewLedgerSummary("BLOCK", "Fix the thing", "bad thing"), "Self-review BLOCK for parallel job: Fix the thing - bad thing");
  assert.equal(parallelBlockedLedgerSummary("Fix the thing", "x".repeat(200)), "Parallel job blocked: Fix the thing - " + "x".repeat(140), "the blocked writer owns the 140-char result cap");
  assert.equal(parallelFailedLedgerSummary("Fix the thing", "x".repeat(200)), "Parallel job failed: Fix the thing - " + "x".repeat(140), "the failed writer owns the 140-char result cap");
  assert.equal(parallelSliceLedgerSummary("alpha", "failed", "Fix the thing", "x".repeat(200)), "Slice alpha failed for parallel job: Fix the thing - " + "x".repeat(140), "the slice writer owns the 140-char error cap");
  assert.equal(parallelReviewLedgerSummary("BLOCK", "Fix the thing", "x".repeat(200)), "Self-review BLOCK for parallel job: Fix the thing - " + "x".repeat(160), "the review writer owns the 160-char blocker cap");
  assert.deepEqual(parseParallelQueuedSummary(parallelQueuedLedgerSummary(2, 4, "claude-code", "Fix the thing")), { slices: 2, concurrency: 4, provider: "claude-code", title: "Fix the thing" });
  assert.deepEqual(parseParallelStartedSummary(parallelStartedLedgerSummary("Fix the thing", 2, 4)), { title: "Fix the thing" });
  assert.deepEqual(parseParallelDoneSummary(parallelDoneLedgerSummary("Fix the thing", 3, 2, 1500)), { title: "Fix the thing", files: 3 });
  assert.deepEqual(parseParallelBlockedSummary(parallelBlockedLedgerSummary("Fix the thing", "boom")), { title: "Fix the thing" });
  assert.deepEqual(parseParallelFailedSummary(parallelFailedLedgerSummary("Fix the thing", "boom")), { title: "Fix the thing" });
  assert.deepEqual(parseParallelFailedSummary(parallelDiedLedgerSummary("Fix the thing")), { title: "Fix the thing" });
  assert.deepEqual(parseParallelSurveySummary(parallelSurveyLedgerSummary(SURVEY)), { base: "abcdef012345", files: 42 });
  assert.deepEqual(parseParallelSliceSummary(parallelSliceLedgerSummary("alpha", "done", "Fix the thing", null)), { name: "alpha", status: "done", title: "Fix the thing" });
  assert.deepEqual(parseParallelMergeSummary(parallelMergeLedgerSummary("alpha", "sam/par-abc12345", ["a.ts"])), { name: "alpha", branch: "sam/par-abc12345" });
  assert.deepEqual(parseParallelVerifySummary(parallelVerifyLedgerSummary(1, "Fix the thing", true, false)), { n: 1, title: "Fix the thing" });
  assert.deepEqual(parseParallelReviewSummary(parallelReviewLedgerSummary("PASS", "Fix the thing", "")), { verdict: "PASS", title: "Fix the thing" });
  assert.equal(parseParallelQueuedSummary(""), null);
  assert.equal(parseParallelQueuedSummary("Queued parallel job: Fix the thing"), null, "a queued line with no counts does not parse");
  assert.equal(parseParallelStartedSummary("Parallel job started:"), null, "a truncated line does not parse");
  assert.equal(parseParallelDoneSummary("Parallel job done: Fix the thing"), null, "a wrong shape does not parse");
  assert.equal(parseParallelDoneSummary("Parallel job done: Fix the thing (three files, 2 slices, 1.5s)"), null, "a non-numeric file count does not parse");
  assert.equal(parseParallelBlockedSummary("Parallel job blocked: Fix the thing"), null, "a blocked line with no reason does not parse");
  assert.equal(parseParallelFailedSummary("Parallel job failed: Fix the thing"), null, "a failed line with no reason does not parse");
  assert.equal(parseParallelFailedSummary("Parallel job died mid-run:"), null, "a truncated died line does not parse");
  assert.equal(parseParallelSurveySummary("Repo survey at xyz: 42 files"), null, "a survey line with no base does not parse");
  assert.equal(parseParallelSliceSummary("Slice alpha done"), null, "a truncated slice line does not parse");
  assert.equal(parseParallelMergeSummary("Slice alpha merged into main"), null, "a wrong merge shape does not parse");
  assert.equal(parseParallelVerifySummary("Coordinator fix iteration 1 for parallel job: Fix the thing - build green, test FAIL"), null, "a verify line with a non-fixed verdict does not parse");
  assert.equal(parseParallelReviewSummary("Self-review for parallel job: Fix the thing"), null, "a review line with no verdict does not parse");
});

test("parallel history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-parallel-history"), "sam-parallel-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-parallel-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["parallel", "history"], "the argv rides parallel history");
});

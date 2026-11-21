import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { codingBlockedLedgerSummary, codingDiedLedgerSummary, codingDoneNoChangesLedgerSummary, codingDoneVerifiedLedgerSummary, codingFailedSummary, codingQueuedLedgerSummary, codingReviewLedgerSummary, codingScorecardText, codingStartedLedgerSummary, parseCodingSummary } from "./coding.js";
import { codingBranchLedgerSummary } from "./git-work.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The coding-task daily-measurement wiring (2026-11-19, the
// measured-proof series): the C3 coding loop ledgers its
// whole lifecycle across seven activity kinds - queued,
// started, branched, done, blocked, failed, reviewed - carrying the
// task's title (the head of its spec) on every line and, on
// the failed and review lines, free text (the failure
// reason, the reviewer's blocker findings), but no daily
// surface ever counted the lifecycle, so coding going silent
// or a rising blocked share was invisible in aggregate. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it carries counts only: no stamp, no
// actor, no title, no reason, and no finding - a task's
// title is its spec's head, and neither it, a failure's
// detail, nor a reviewer's findings belong in a trending
// surface; an unmatched shape counts under its kind and
// contributes nothing else, never printed. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and queues or drains nothing; every state here is
// built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-coding-scorecard-"));
}

test("coding scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = codingScorecardText(dir);
    assert.match(text, /^Coding tasks: clear$/m);
    assert.match(text, /^Queued: 0$/m);
    assert.match(text, /^Started: 0$/m);
    assert.match(text, /^Branched: 0$/m);
    assert.match(text, /^Done: 0$/m);
    assert.match(text, /^Blocked: 0$/m);
    assert.match(text, /^Failed: 0$/m);
    assert.match(text, /^Reviewed: 0$/m);
    assert.match(text, /^Done verified: 0$/m);
    assert.match(text, /^Done no changes: 0$/m);
    assert.match(text, /^Distinct tasks: 0$/m);
    assert.match(text, /^Distinct branches: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = codingScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held coding scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding scorecard: the lifecycle folds to counts and buckets, a block flips the verdict, and no title, reason, or finding leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "coding-queued", codingQueuedLedgerSummary("sekrit task alpha"));
    recordActivity(dir, "sam", "coding-queued", codingQueuedLedgerSummary("sekrit task beta"));
    recordActivity(dir, "sam", "coding-started", codingStartedLedgerSummary("sekrit task alpha"));
    recordActivity(dir, "sam", "coding-branch", codingBranchLedgerSummary("sam/sekrit-branch-alpha", "0123456789ab"));
    recordActivity(dir, "sam", "coding-branch", codingBranchLedgerSummary("sam/sekrit-branch-alpha", "0123456789ab"));
    recordActivity(dir, "sam", "coding-review", codingReviewLedgerSummary("PASS", "sekrit task alpha", ""));
    recordActivity(dir, "sam", "coding-done", codingDoneVerifiedLedgerSummary("sekrit task alpha", 3, 2));
    recordActivity(dir, "sam", "coding-done", codingDoneNoChangesLedgerSummary("sekrit task beta"));
    const clean = codingScorecardText(dir);
    assert.match(clean, /^Coding tasks: clear$/m);
    assert.match(clean, /^Queued: 2$/m);
    assert.match(clean, /^Started: 1$/m);
    assert.match(clean, /^Branched: 2$/m);
    assert.match(clean, /^Distinct branches: 1$/m);
    assert.match(clean, /^Done: 2$/m);
    assert.match(clean, /^Blocked: 0$/m);
    assert.match(clean, /^Failed: 0$/m);
    assert.match(clean, /^Reviewed: 1$/m);
    assert.match(clean, /^Done verified: 1$/m);
    assert.match(clean, /^Done no changes: 1$/m);
    assert.match(clean, /^Verified files: 3$/m);
    assert.match(clean, /^Verified iterations: 2$/m);
    assert.match(clean, /^Reviews pass: 1$/m);
    assert.match(clean, /^Distinct tasks: 2$/m);
    recordActivity(dir, "sam", "coding-blocked", codingBlockedLedgerSummary("git discipline", "sekrit task beta"));
    recordActivity(dir, "sam", "coding-blocked", codingBlockedLedgerSummary("unverified", "sekrit task beta"));
    recordActivity(dir, "sam", "coding-review", codingReviewLedgerSummary("BLOCK", "sekrit task beta", "sekrit blocker finding"));
    recordActivity(dir, "sam", "coding-queued", "Some wholly novel queue shape mentioning sekrit");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = codingScorecardText(dir);
    assert.match(text, /^Coding tasks: attention$/m);
    assert.match(text, /^Queued: 3$/m);
    assert.match(text, /^Blocked: 2$/m);
    assert.match(text, /^Blocked git: 1$/m);
    assert.match(text, /^Blocked state: 1$/m);
    assert.match(text, /^Reviews block: 1$/m);
    assert.match(text, /^Distinct tasks: 2$/m);
    assert.equal(text.includes("sekrit"), false, "no title, reason, finding, branch, or head surfaces");
    assert.equal(text.includes("0123456789ab"), false, "no head surfaces");
    assert.equal(text.includes("novel queue"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding parse: the seams' own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseCodingSummary("coding-queued", codingQueuedLedgerSummary("Fix the thing")), { stage: "queued", title: "Fix the thing" });
  assert.deepEqual(parseCodingSummary("coding-started", codingStartedLedgerSummary("Fix the thing")), { stage: "started", title: "Fix the thing" });
  assert.deepEqual(parseCodingSummary("coding-branch", codingBranchLedgerSummary("sam/fix-the-thing", "0123456789ab")), { stage: "branch", branch: "sam/fix-the-thing" });
  assert.equal(parseCodingSummary("coding-branch", "Coding branch sam/fix ready at nothex!!"), null, "a non-hex head never parses");
  assert.equal(parseCodingSummary("coding-branch", "Coding branch sam/fix ready at abc123"), null, "a too-short head never parses");
  assert.deepEqual(parseCodingSummary("coding-done", codingDoneVerifiedLedgerSummary("Fix the thing", 3, 2)), { stage: "done", title: "Fix the thing", outcome: "verified", files: 3, iterations: 2 });
  assert.deepEqual(parseCodingSummary("coding-done", codingDoneNoChangesLedgerSummary("Fix the thing")), { stage: "done", title: "Fix the thing", outcome: "no-changes", files: 0, iterations: 0 });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("git discipline", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "git" });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("git discipline", "Self-work fix (SELF-WORK loop): the top defect")), { stage: "blocked", title: "Self-work fix (SELF-WORK loop): the top defect", bucket: "git" }, "a title carrying its own parentheses never widens the reason group");
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("review BLOCK", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "review-block" });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("self-review unavailable", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "review-unavailable" });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("uncommitted writes", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "uncommitted" });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("unverified", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "state" });
  assert.deepEqual(parseCodingSummary("coding-blocked", codingBlockedLedgerSummary("some new reason", "Fix the thing")), { stage: "blocked", title: "Fix the thing", bucket: "other" });
  assert.deepEqual(parseCodingSummary("coding-failed", codingFailedSummary("Fix the thing", new Error("boom"))), { stage: "failed", title: "Fix the thing" });
  assert.deepEqual(parseCodingSummary("coding-failed", codingDiedLedgerSummary("Fix the thing")), { stage: "failed", title: "Fix the thing" });
  assert.deepEqual(parseCodingSummary("coding-review", codingReviewLedgerSummary("PASS", "Fix the thing", "")), { stage: "review", title: "Fix the thing", verdict: "pass" });
  assert.deepEqual(parseCodingSummary("coding-review", codingReviewLedgerSummary("BLOCK", "Fix the thing", "a finding")), { stage: "review", title: "Fix the thing - a finding", verdict: "block" });
  assert.equal(codingQueuedLedgerSummary("Fix the thing"), "Queued coding task: Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingStartedLedgerSummary("Fix the thing"), "Coding task started: Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingBranchLedgerSummary("sam/fix-the-thing", "0123456789ab"), "Coding branch sam/fix-the-thing ready at 0123456789ab", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingDiedLedgerSummary("Fix the thing"), "Coding task died mid-run: Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingDoneVerifiedLedgerSummary("Fix the thing", 3, 2), "Coding task done and verified: Fix the thing (3 file(s), 2 iteration(s))", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingDoneNoChangesLedgerSummary("Fix the thing"), "Coding task closed with no changes: Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingBlockedLedgerSummary("git discipline", "Fix the thing"), "Coding task blocked (git discipline): Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingReviewLedgerSummary("PASS", "Fix the thing", ""), "Self-review PASS for coding task: Fix the thing", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(codingReviewLedgerSummary("BLOCK", "Fix the thing", "a finding"), "Self-review BLOCK for coding task: Fix the thing - a finding", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseCodingSummary("coding-queued", ""), null);
  assert.equal(parseCodingSummary("coding-done", "Some wholly novel shape"), null);
  assert.equal(parseCodingSummary("coding-queued", codingStartedLedgerSummary("Fix the thing")), null, "a started line never parses as a queue line");
  assert.equal(parseCodingSummary("turn", codingQueuedLedgerSummary("Fix the thing")), null, "an unknown kind never parses");
});

test("coding scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-coding"), "sam-coding is allowlisted");
  const argv = scriptArgv("/some/root", "sam-coding");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["coding", "scorecard"], "the argv rides coding scorecard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { codingScorecardText, parseCodingSummary } from "./coding.js";
import { codingBranchLedgerSummary, codingCommitLedgerSummary } from "./git-work.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The coding-commit measurement (2026-11-22, the
// measured-proof series): the coding scorecard folded seven
// of the lifecycle's eight kinds - queued, started,
// branched, done, blocked, failed, reviewed - while the
// commit stage was written inline at the commitTaskPaths
// seam with no writer, no parser, and no fold. A task that
// branched but never committed was therefore
// indistinguishable in the trend from one that committed
// every iteration, and how many C4 commits ever landed was
// invisible in aggregate; the task records hold each live
// task's commit list, but a closed task's commits survive
// as a count nowhere except these ledger lines. The
// existing scorecard now folds all eight stages - no second
// scorecard, because the daily sam-coding script job
// already rides this one text. The verdict is unchanged:
// attention when any task failed, any task blocked, or any
// line is unparseable, else clear - a commit is the loop
// working as designed (counted, not alarmed). The text
// carries counts only: no stamp, no actor, no title, no
// path, no branch, and no head. The scorecard path is a
// pure read - it creates nothing, spends no model call, and
// queues, drains, and commits nothing; every state here is
// built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-coding-commit-scorecard-"));
}

test("coding commit: a bare install reads clear with zero committed, stable, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = codingScorecardText(dir);
    assert.match(text, /^Coding tasks: clear$/m);
    assert.match(text, /^Committed: 0$/m);
    assert.match(text, /^Committed files: 0$/m);
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

test("coding commit: the writer is byte-identical to the historical inline shape", () => {
  assert.equal(
    codingCommitLedgerSummary(["src/a.ts", "src/b.ts"], "sam/fix-thing-abcd1234", "0123456789ab", 2),
    "Committed src/a.ts, src/b.ts on sam/fix-thing-abcd1234 (0123456789ab, iteration 2)",
  );
  assert.equal(
    codingCommitLedgerSummary(["one.ts"], "sam/x-00000000", "fedcba987654", 1),
    "Committed one.ts on sam/x-00000000 (fedcba987654, iteration 1)",
  );
});

test("coding commit: the parser learns the fixed shape exactly and cross-kind lines never parse", () => {
  assert.deepEqual(
    parseCodingSummary("coding-commit", codingCommitLedgerSummary(["src/a.ts", "src/b.ts"], "sam/fix-thing-abcd1234", "0123456789ab", 2)),
    { stage: "commit", branch: "sam/fix-thing-abcd1234", files: 2, iteration: 2 },
  );
  assert.equal(parseCodingSummary("coding-commit", "Committed src/a.ts on sam/x-00000000 (0123456789ab)"), null, "no iteration, no parse");
  assert.equal(parseCodingSummary("coding-commit", "Committed src/a.ts on sam/x-00000000 (0123456789abcdef, iteration 1)"), null, "a head longer than 12 does not parse");
  assert.equal(parseCodingSummary("coding-commit", "Committed src/a.ts on sam/x-00000000 (zzzzzzzzzzzz, iteration 1)"), null, "a non-hex head does not parse");
  assert.equal(parseCodingSummary("coding-commit", "Committed on sam/x-00000000 (0123456789ab, iteration 1)"), null, "no path list, no parse");
  assert.equal(parseCodingSummary("coding-branch", codingCommitLedgerSummary(["a.ts"], "sam/x-00000000", "0123456789ab", 1)), null, "a commit line never parses as a branch line");
  assert.equal(parseCodingSummary("coding-commit", codingBranchLedgerSummary("sam/x-00000000", "0123456789ab")), null, "a branch line never parses as a commit line");
});

test("coding commit: commits fold to their count, sum their files, join the distinct-branch count, and stay clear", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "coding-branch", codingBranchLedgerSummary("sam/fix-thing-abcd1234", "0123456789ab"));
    recordActivity(dir, "sam", "coding-commit", codingCommitLedgerSummary(["src/a.ts", "src/b.ts"], "sam/fix-thing-abcd1234", "0123456789ab", 1));
    recordActivity(dir, "sam", "coding-commit", codingCommitLedgerSummary(["src/c.ts"], "sam/fix-thing-abcd1234", "1123456789ab", 2));
    recordActivity(dir, "sam", "coding-commit", codingCommitLedgerSummary(["d.ts", "e.ts", "f.ts"], "sam/other-99999999", "2123456789ab", 1));
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = codingScorecardText(dir);
    assert.match(text, /^Coding tasks: clear$/m, "commits alone never flip the verdict");
    assert.match(text, /^Branched: 1$/m);
    assert.match(text, /^Committed: 3$/m);
    assert.match(text, /^Committed files: 6$/m);
    assert.match(text, /^Distinct branches: 2$/m, "the branch-only branch and the commit-only branch each count once");
    assert.equal(text.includes("sam/fix-thing"), false, "no branch surfaces");
    assert.equal(text.includes("src/a.ts"), false, "no path surfaces");
    assert.equal(text.includes("0123456789ab"), false, "no head surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding commit: an unparseable commit line counts under its kind and flips the verdict to attention", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "coding-commit", "Committed some files somehow");
    const text = codingScorecardText(dir);
    assert.match(text, /^Coding tasks: attention$/m);
    assert.match(text, /^Committed: 1$/m, "the line still counts under its kind");
    assert.match(text, /^Committed files: 0$/m, "an unmatched shape contributes nothing else");
    assert.match(text, /^Distinct branches: 0$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding commit: the sam-coding script job rides the extended scorecard text", () => {
  assert.ok(scriptCommandNames().includes("sam-coding"));
  const argv = scriptArgv("/some/root", "sam-coding");
  assert.ok(argv.some(a => a === "coding") && argv.some(a => a === "scorecard"), "the allowlist entry rides the coding scorecard CLI");
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "coding-commit", codingCommitLedgerSummary(["a.ts"], "sam/x-00000000", "0123456789ab", 1));
    assert.match(codingScorecardText(dir), /^Committed: 1$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecallFailedSummary, recallFailedHistoryScorecardText, recallFailureSummary } from "./recall.js";
import { recordActivity } from "./activity.js";
import { skillUseFailureSummary } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The recall failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the recall assembly
// ledgers every failed seam as a recall-failed line through the
// ONE writer recallFailureSummary (naming the phase and the
// actor), ridden by recordRecallFailure from every seam
// (assemble / list / loops / search / semantic) - but the class
// was never folded, so how often SAM answered with no memory at
// all was invisible in aggregate. Every failure line is by
// construction a recall seam that did not complete, so the
// verdict is attention when any failure was ever recorded or
// any line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no phase name, no
// actor, and no verbatim reason - the summaries carry phases,
// actors, and reasons, and the fold consumes and never prints
// them. The scorecard path is a pure read - it creates nothing,
// sends nothing, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-recall-failed-history-"));
}

const BARE = "Recall failed history: clear, 0 failed, 0 distinct phases, 0 distinct actors, 0 total";

test("recall failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = recallFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = recallFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held recall scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recall failed history scorecard: the writer's failures fold to counts with distinct phases and actors as numbers only, and no actor or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = recallFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("sam", "search", "fts5: corrupt index sekrit"));
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("sam", "search", "disk full"));
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("dip", "list", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("trading", "loops", "EACCES: permission denied"));
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("sam", "assemble", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = recallFailedHistoryScorecardText(dir);
    assert.equal(text, "Recall failed history: attention, 5 failed, 4 distinct phases, 3 distinct actors, 5 total");
    assert.equal(text.includes("search"), false, "no phase name surfaces");
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

test("recall failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = recallFailureSummary("sam", "search", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseRecallFailedSummary(capped), { phase: "search", actor: "sam" });
    recordActivity(dir, "sam", "recall-failed", capped);
    const text = recallFailedHistoryScorecardText(dir);
    assert.equal(text, "Recall failed history: attention, 1 failed, 1 distinct phases, 1 distinct actors, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recall failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and a bad-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "recall-failed", recallFailureSummary("sam", "search", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "recall-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "recall-failed", skillUseFailureSummary("agent-reach", null, "boom sekrit"));
    recordActivity(dir, "sam", "recall-failed", "Recall search failed for sam:   ");
    recordActivity(dir, "sam", "recall-failed", "Recall frobnicate failed for sam: boom");
    const text = recallFailedHistoryScorecardText(dir);
    assert.equal(text, "Recall failed history: attention, 1 failed, 1 distinct phases, 1 distinct actors, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recall failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    recallFailureSummary("sam", "search", "fts5: corrupt index fell over"),
    "Recall search failed for sam: fts5: corrupt index fell over",
  );
  assert.deepEqual(parseRecallFailedSummary(recallFailureSummary("sam", "search", "boom")), { phase: "search", actor: "sam" });
  assert.deepEqual(parseRecallFailedSummary(recallFailureSummary("dip", "assemble", "boom")), { phase: "assemble", actor: "dip" });
  assert.deepEqual(parseRecallFailedSummary(recallFailureSummary("trading", "semantic", "boom")), { phase: "semantic", actor: "trading" });
  assert.equal(parseRecallFailedSummary(""), null);
  assert.equal(parseRecallFailedSummary("Recall search failed for sam:"), null, "a line with no reason does not parse");
  assert.equal(parseRecallFailedSummary("Recall search failed for sam: "), null, "a line with a blank reason does not parse");
  assert.equal(parseRecallFailedSummary("Recall write failed for sam: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseRecallFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), null, "a skill-use-failed line never parses as a recall-failed line");
  assert.deepEqual(parseRecallFailedSummary("Recall search failed for sam: boom: with colon"), { phase: "search", actor: "sam" }, "a reason carrying a colon still parses from the fixed head");
});

test("recall failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-recall-failed-history"), "sam-recall-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-recall-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "recall-failed-history"], "the argv rides observe recall-failed-history");
});

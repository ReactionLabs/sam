import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { loopClosedLedgerSummary, loopFailedSummary, loopOpenLedgerSummary, loopResolvedLedgerSummary, loopRevisitHistoryScorecardText, loopUpdatedLedgerSummary, parseLoopClosedSummary, parseLoopFailedSummary, parseLoopOpenSummary, parseLoopResolvedSummary, parseLoopUpdatedSummary } from "./loop-revisit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The loop history daily-measurement wiring (2026-11-21, the
// measured-proof series): every act of the SECOND ANSWERS
// lifecycle has ledgered as a loop-open / loop-updated /
// loop-resolved / loop-closed / loop-failed line since the
// revisit engine landed - the open, closed, resolved, and
// updated lines as inline concatenation with no ONE writer
// and no fold, so how many loops were ever opened, how their
// revisits ended, and across how many profiles was invisible
// in aggregate (listLoops reads only the current store). A
// failed re-check is the family's signal - the revisit
// reschedules and stays open by design, so the failure is
// visible only in the ledger - so the verdict is attention
// only when any loop-failed was ever recorded or a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no question, no answer,
// no reason - the summaries carry the owner's own questions
// and SAM's answers, which the fold consumes and never
// prints. The scorecard path is a pure read - it creates
// nothing, opens nothing, revisits nothing, and closes
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loop-history-"));
}

test("loop history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = loopRevisitHistoryScorecardText(dir);
    assert.equal(text, "Loop history: clear, 0 opened, 0 updated, 0 posted, 0 resolved, 0 closed, 0 chat-gone, 0 visitor, 0 failed, 0 distinct profiles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = loopRevisitHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held loop scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop history scorecard: the history folds to counts and distinct profiles, and no question or answer surfaces", () => {
  const dir = scratch();
  try {
    const clean = loopRevisitHistoryScorecardText(dir);
    recordActivity(dir, "sekrit-profile", "loop-open", loopOpenLedgerSummary("sekrit question alpha"));
    recordActivity(dir, "other-profile", "loop-open", loopOpenLedgerSummary("sekrit question beta"));
    recordActivity(dir, "sekrit-profile", "loop-updated", loopUpdatedLedgerSummary(true, "sekrit question alpha", "sekrit new answer"));
    recordActivity(dir, "sekrit-profile", "loop-updated", loopUpdatedLedgerSummary(false, "sekrit question alpha", "sekrit newer answer"));
    recordActivity(dir, "other-profile", "loop-resolved", loopResolvedLedgerSummary("sekrit question beta", "sekrit final answer"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = loopRevisitHistoryScorecardText(dir);
    assert.equal(text, "Loop history: clear, 2 opened, 2 updated, 1 posted, 1 resolved, 0 closed, 0 chat-gone, 0 visitor, 0 failed, 2 distinct profiles, 5 total");
    assert.equal(text.includes("sekrit question"), false, "no question surfaces");
    assert.equal(text.includes("sekrit new answer"), false, "no answer surfaces");
    assert.equal(text.includes("sekrit-profile"), false, "no profile name surfaces");
    assert.notEqual(text, clean, "the first recorded loop changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop history scorecard: the engine's two closes count with their split, and no question surfaces", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-closed", loopClosedLedgerSummary("chat-gone", "sekrit orphaned question"));
    recordActivity(dir, "trading", "loop-closed", loopClosedLedgerSummary("visitor", "sekrit visitor question"));
    const text = loopRevisitHistoryScorecardText(dir);
    assert.equal(text, "Loop history: clear, 0 opened, 0 updated, 0 posted, 0 resolved, 2 closed, 1 chat-gone, 1 visitor, 0 failed, 2 distinct profiles, 2 total");
    assert.equal(text.includes("sekrit"), false, "no question surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop history scorecard: a failed re-check is attention, with no reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-failed", loopFailedSummary("sekrit question", new Error("sekrit boom")));
    const text = loopRevisitHistoryScorecardText(dir);
    assert.equal(text, "Loop history: attention, 0 opened, 0 updated, 0 posted, 0 resolved, 0 closed, 0 chat-gone, 0 visitor, 1 failed, 1 distinct profiles, 1 total");
    assert.equal(text.includes("sekrit boom"), false, "no failure reason surfaces");
    assert.equal(text.includes("sekrit question"), false, "no question surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "loop-open", loopOpenLedgerSummary("dip question"));
    recordActivity(dir, "trading", "loop-updated", "Some wholly novel loop shape naming sekrit_evidence");
    recordActivity(dir, "owner", "loop-resolved", "Open loop resolved: sekrit question with no separator");
    const text = loopRevisitHistoryScorecardText(dir);
    assert.equal(text, "Loop history: attention, 1 opened, 0 updated, 0 posted, 0 resolved, 0 closed, 0 chat-gone, 0 visitor, 0 failed, 1 distinct profiles, 3 total, 2 unparseable");
    assert.equal(text.includes("novel loop"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(loopOpenLedgerSummary("What is the status?"), "Opened loop: What is the status?");
  assert.equal(loopClosedLedgerSummary("chat-gone", "Q?"), "Open loop closed (its chat no longer exists): Q?");
  assert.equal(loopClosedLedgerSummary("visitor", "Q?"), "Open loop closed (visitor chat): Q?");
  assert.equal(loopResolvedLedgerSummary("Q?", "Final answer"), "Open loop resolved: Q? - Final answer");
  assert.equal(loopUpdatedLedgerSummary(true, "Q?", "New answer"), "Open loop updated in its chat: Q? - New answer");
  assert.equal(loopUpdatedLedgerSummary(false, "Q?", "New answer"), "Open loop updated: Q? - New answer");
  assert.equal(loopFailedSummary("Q?", new Error("boom")), "Open loop re-check failed, will look again later: Q? - boom");
  assert.deepEqual(parseLoopOpenSummary(loopOpenLedgerSummary("What is the status?")), {});
  assert.deepEqual(parseLoopClosedSummary(loopClosedLedgerSummary("chat-gone", "Q?")), { reason: "chat-gone" });
  assert.deepEqual(parseLoopClosedSummary(loopClosedLedgerSummary("visitor", "Q?")), { reason: "visitor" });
  assert.deepEqual(parseLoopResolvedSummary(loopResolvedLedgerSummary("Q?", "Final answer")), {});
  assert.deepEqual(parseLoopUpdatedSummary(loopUpdatedLedgerSummary(true, "Q?", "New answer")), { posted: true });
  assert.deepEqual(parseLoopUpdatedSummary(loopUpdatedLedgerSummary(false, "Q?", "New answer")), { posted: false });
  assert.deepEqual(parseLoopFailedSummary(loopFailedSummary("Q?", new Error("boom"))), {});
  assert.equal(parseLoopOpenSummary(""), null);
  assert.equal(parseLoopOpenSummary("Opened loop: "), null, "an open line with no question does not parse");
  assert.equal(parseLoopClosedSummary("Open loop closed (owner request): Q?"), null, "a close reason the writer never uses does not parse");
  assert.equal(parseLoopResolvedSummary("Open loop resolved: Q?"), null, "a resolved line with no answer separator does not parse");
  assert.equal(parseLoopUpdatedSummary("Open loop updated: Q? - "), null, "an updated line with no answer does not parse");
  assert.equal(parseLoopFailedSummary("Open loop re-check failed: Q? - boom"), null, "a truncated failure line does not parse");
});

test("loop history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-loop-history"), "sam-loop-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-loop-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["loops", "history"], "the argv rides loops history");
});

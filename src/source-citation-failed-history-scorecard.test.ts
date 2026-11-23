import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSourceCitationFailedSummary, sourceCitationFailedHistoryScorecardText, sourceCitationFailureSummary } from "./source-citations.js";
import { chatCitationFailureSummary } from "./chat-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The source citation failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the citation
// plumbing ledgers every failure as a source-citation-failed
// line through the ONE writer sourceCitationFailureSummary,
// ridden by the one seam recordSourceFailure (the annotate
// path in annotateToolResult and the attach path in
// attachReplySources) - but the class was never folded, so
// how often a citation failed to annotate or attach was
// invisible in aggregate (the existing source-citation
// scorecards fold only successful attaches and rejections).
// Every failure line is by construction a citation plumbing
// step that did not complete, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no phase
// name, and no verbatim reason - the summaries carry phases
// and reasons, which the fold consumes and never prints. The
// scorecard path is a pure read - it creates nothing, sends
// nothing, retries nothing, and attaches no citation; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-source-citation-failed-history-"));
}

const BARE = "Source citation failed history: clear, 0 failed, 0 distinct phases, 0 total";

test("source citation failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = sourceCitationFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = sourceCitationFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held source citation scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source citation failed history scorecard: the writer's failures fold to counts across both phases, and no phase or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = sourceCitationFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "source-citation-failed", sourceCitationFailureSummary("annotate", new Error("EISDIR: illegal operation on a directory, open sekrit-path")));
    recordActivity(dir, "sam", "source-citation-failed", sourceCitationFailureSummary("attach", new Error("EPERM: operation not permitted")));
    recordActivity(dir, "sam", "source-citation-failed", sourceCitationFailureSummary("attach", new Error("ENOSPC: no space left on device")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = sourceCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Source citation failed history: attention, 3 failed, 2 distinct phases, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason head surfaces");
    assert.equal(text.includes("annotate"), false, "no phase name surfaces");
    assert.equal(text.includes("attach"), false, "no phase name surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source citation failed history scorecard: the writer's own reason cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = sourceCitationFailureSummary("attach", new Error("x".repeat(500)));
    assert.equal(capped, "Source citation attach failed: " + "x".repeat(160), "the writer caps its reason at 160");
    recordActivity(dir, "sam", "source-citation-failed", capped);
    assert.deepEqual(parseSourceCitationFailedSummary(capped), { phase: "attach" });
    const text = sourceCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Source citation failed history: attention, 1 failed, 1 distinct phases, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source citation failed history scorecard: an unmatched shape, a sibling kind's shape, an unknown phase, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "source-citation-failed", sourceCitationFailureSummary("attach", new Error("EPERM: operation not permitted")));
    recordActivity(dir, "sam", "source-citation-failed", "Some wholly novel citation shape naming sekrit_source");
    recordActivity(dir, "sam", "source-citation-failed", chatCitationFailureSummary("attach", new Error("boom sekrit")));
    recordActivity(dir, "sam", "source-citation-failed", "Source citation read failed: boom sekrit");
    recordActivity(dir, "sam", "source-citation-failed", "Source citation attach failed:   ");
    const text = sourceCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Source citation failed history: attention, 1 failed, 1 distinct phases, 5 total, 4 unparseable");
    assert.equal(text.includes("novel citation"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("read"), false, "an unknown phase is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source citation failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    sourceCitationFailureSummary("attach", new Error("EPERM: operation not permitted")),
    "Source citation attach failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseSourceCitationFailedSummary(sourceCitationFailureSummary("annotate", new Error("boom"))), { phase: "annotate" });
  assert.deepEqual(parseSourceCitationFailedSummary(sourceCitationFailureSummary("attach", new Error("boom"))), { phase: "attach" });
  assert.equal(parseSourceCitationFailedSummary(""), null);
  assert.equal(parseSourceCitationFailedSummary("Source citation attach failed:"), null, "a line with no reason does not parse");
  assert.equal(parseSourceCitationFailedSummary("Source citation attach failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseSourceCitationFailedSummary("Source citation read failed: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseSourceCitationFailedSummary(chatCitationFailureSummary("attach", new Error("boom"))), null, "a chat-citation-failed line never parses as a source-citation-failed line");
  assert.deepEqual(parseSourceCitationFailedSummary("Source citation attach failed: boom: with colon"), { phase: "attach" }, "a reason carrying a colon still parses from the fixed head");
});

test("source citation failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-source-citation-failed-history"), "sam-source-citation-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-source-citation-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "source-citation-failed-history"], "the argv rides observe source-citation-failed-history");
});

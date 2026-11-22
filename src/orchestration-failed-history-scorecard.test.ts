import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { orchestrationFailedHistoryScorecardText, orchestrationFailureSummary, parseOrchestrationFailedSummary } from "./orchestration.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The orchestration failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the orchestration
// store records a read or write that throws as an
// orchestration-failed line through the ONE writer
// orchestrationFailureSummary - but the class was never
// folded, so how often the store's own ledger died was
// invisible in aggregate (the existing orchestration
// scorecard folds only lifecycle records). Every failure line
// is by construction a store operation that did not complete,
// so the verdict is attention when any failure was ever
// recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no phase name, and no verbatim reason -
// the summaries carry phases and reasons, which the fold
// consumes and never prints. The scorecard path is a pure
// read - it creates nothing, sends nothing, retries
// nothing, and opens no store; every state here is built
// through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-orchestration-failed-history-"));
}

const BARE = "Orchestration failed history: clear, 0 failed, 0 distinct phases, 0 total";

test("orchestration failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = orchestrationFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = orchestrationFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held orchestration scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration failed history scorecard: the writer's failures fold to counts, and no phase or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = orchestrationFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "orchestration-failed", orchestrationFailureSummary("write", "EACCES: permission denied, sekrit path"));
    recordActivity(dir, "sam", "orchestration-failed", orchestrationFailureSummary("write", "SQLITE_BUSY: database is locked"));
    recordActivity(dir, "sam", "orchestration-failed", orchestrationFailureSummary("read", "file is not a database"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = orchestrationFailedHistoryScorecardText(dir);
    assert.equal(text, "Orchestration failed history: attention, 3 failed, 2 distinct phases, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("write"), false, "no phase name surfaces");
    assert.equal(text.includes("read"), false, "no phase name surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration failed history scorecard: the writer's own 160-char reason cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = orchestrationFailureSummary("read", "x".repeat(500));
    assert.equal(capped, "Orchestration store read failed: " + "x".repeat(160), "the writer caps its reason at 160");
    recordActivity(dir, "sam", "orchestration-failed", capped);
    assert.deepEqual(parseOrchestrationFailedSummary(capped), { phase: "read" });
    const text = orchestrationFailedHistoryScorecardText(dir);
    assert.equal(text, "Orchestration failed history: attention, 1 failed, 1 distinct phases, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration failed history scorecard: an unmatched shape, an unknown phase, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "orchestration-failed", orchestrationFailureSummary("read", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "orchestration-failed", "Some wholly novel orchestration shape naming sekrit_evidence");
    recordActivity(dir, "sam", "orchestration-failed", "Orchestration store append failed: boom sekrit");
    recordActivity(dir, "sam", "orchestration-failed", "Orchestration store read failed:   ");
    const text = orchestrationFailedHistoryScorecardText(dir);
    assert.equal(text, "Orchestration failed history: attention, 1 failed, 1 distinct phases, 4 total, 3 unparseable");
    assert.equal(text.includes("novel orchestration"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("append"), false, "an unknown phase is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    orchestrationFailureSummary("read", "file is not a database"),
    "Orchestration store read failed: file is not a database",
  );
  assert.deepEqual(parseOrchestrationFailedSummary(orchestrationFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseOrchestrationFailedSummary(orchestrationFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseOrchestrationFailedSummary(""), null);
  assert.equal(parseOrchestrationFailedSummary("Orchestration store read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseOrchestrationFailedSummary("Orchestration store read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseOrchestrationFailedSummary("Orchestration store append failed: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseOrchestrationFailedSummary("Context meter read failed: boom"), null, "a context-failed line never parses as an orchestration line");
  assert.deepEqual(parseOrchestrationFailedSummary("Orchestration store read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("orchestration failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-orchestration-failed-history"), "sam-orchestration-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-orchestration-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["orchestrate", "failed-history"], "the argv rides orchestrate failed-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { contextFailedHistoryScorecardText, parseContextFailedSummary, contextMeterFailureSummary } from "./context-meter.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The context failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a context meter
// records write or read that throws ledgers as a
// context-failed line through the ONE writer
// contextMeterFailureSummary, and self-work ranks the class
// as a defect keyed by phase - but the class was never
// folded, so how often the meter's own ledger died was
// invisible in aggregate. Every failure line is by
// construction a records operation that did not complete,
// so the verdict is attention when any failure was ever
// recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no phase name, and no verbatim reason -
// the summaries carry phases and reasons, which the fold
// consumes and never prints. The scorecard path is a pure
// read - it creates nothing, sends nothing, retries
// nothing, and records no context; every state here is built
// through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-context-failed-history-"));
}

const BARE = "Context failed history: clear, 0 failed, 0 distinct phases, 0 total";

test("context failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = contextFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = contextFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held context scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context failed history scorecard: the writer's failures fold to counts, and no phase or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = contextFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "context-failed", contextMeterFailureSummary("write", "EACCES: permission denied, sekrit path"));
    recordActivity(dir, "sam", "context-failed", contextMeterFailureSummary("write", "ENOSPC: no space left on device"));
    recordActivity(dir, "sam", "context-failed", contextMeterFailureSummary("read", "file is not valid JSON"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = contextFailedHistoryScorecardText(dir);
    assert.equal(text, "Context failed history: attention, 3 failed, 2 distinct phases, 3 total");
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

test("context failed history scorecard: the writer's own 200-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = contextMeterFailureSummary("read", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "context-failed", capped);
    assert.deepEqual(parseContextFailedSummary(capped), { phase: "read" });
    const text = contextFailedHistoryScorecardText(dir);
    assert.equal(text, "Context failed history: attention, 1 failed, 1 distinct phases, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context failed history scorecard: an unmatched shape, an unknown phase, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "context-failed", contextMeterFailureSummary("read", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "context-failed", "Some wholly novel context shape naming sekrit_evidence");
    recordActivity(dir, "sam", "context-failed", "Context meter append failed: boom sekrit");
    recordActivity(dir, "sam", "context-failed", "Context meter read failed:   ");
    const text = contextFailedHistoryScorecardText(dir);
    assert.equal(text, "Context failed history: attention, 1 failed, 1 distinct phases, 4 total, 3 unparseable");
    assert.equal(text.includes("novel context"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("append"), false, "an unknown phase is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    contextMeterFailureSummary("read", "file is not a database"),
    "Context meter read failed: file is not a database",
  );
  assert.deepEqual(parseContextFailedSummary(contextMeterFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseContextFailedSummary(contextMeterFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseContextFailedSummary(""), null);
  assert.equal(parseContextFailedSummary("Context meter read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseContextFailedSummary("Context meter read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseContextFailedSummary("Context meter append failed: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseContextFailedSummary("Answer judge read failed: boom"), null, "an answer-judge-failed line never parses as a context line");
  assert.deepEqual(parseContextFailedSummary("Context meter read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("context failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-context-failed-history"), "sam-context-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-context-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["usage", "context-failed-history"], "the argv rides usage context-failed-history");
});

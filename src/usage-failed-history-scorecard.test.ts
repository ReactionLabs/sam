import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageFailedSummary, usageFailedHistoryScorecardText, usageFailureSummary, usageReadFailureSummary } from "./usage.js";
import { recordActivity } from "./activity.js";
import { sessionCapsFailureSummary } from "./session-caps.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The usage failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the usage ledger
// ledgers every failed touch as a usage-failed line through
// the TWO writers usageFailureSummary (a failed record, naming
// the model) and usageReadFailureSummary (a failed ledger
// read, no model), ridden by recordUsageFailure /
// recordUsageReadFailure - but the class was never folded, so
// how often the spend ledger's own touches died was invisible
// in aggregate. Every failure line is by construction a usage
// touch that did not complete, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no operation
// name, no model name, and no verbatim reason - the summaries
// carry models and reasons, and the fold consumes and never
// prints them. The scorecard path is a pure read - it creates
// nothing, sends nothing, and retries nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-usage-failed-history-"));
}

const BARE = "Usage failed history: clear, 0 failed, 0 distinct operations, 0 distinct models, 0 total";

test("usage failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = usageFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = usageFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held usage scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage failed history scorecard: the writers' failures fold to counts with distinct operations and models as numbers only, and no model or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = usageFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "usage-failed", usageFailureSummary("MiniMax-M2.5", "unable to open database file sekrit"));
    recordActivity(dir, "sam", "usage-failed", usageFailureSummary("MiniMax-M2.5", "disk full"));
    recordActivity(dir, "sam", "usage-failed", usageFailureSummary("mock", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "usage-failed", usageReadFailureSummary("database is locked"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = usageFailedHistoryScorecardText(dir);
    assert.equal(text, "Usage failed history: attention, 4 failed, 2 distinct operations, 2 distinct models, 4 total");
    assert.equal(text.includes("MiniMax"), false, "no model name surfaces");
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

test("usage failed history scorecard: the writers' own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = usageFailureSummary("MiniMax-M2.5", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseUsageFailedSummary(capped), { what: "record", model: "MiniMax-M2.5" });
    recordActivity(dir, "sam", "usage-failed", capped);
    const text = usageFailedHistoryScorecardText(dir);
    assert.equal(text, "Usage failed history: attention, 1 failed, 1 distinct operations, 1 distinct models, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "usage-failed", usageReadFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "usage-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "usage-failed", sessionCapsFailureSummary("ledger read", "", "boom sekrit"));
    recordActivity(dir, "sam", "usage-failed", "Usage ledger read failed:   ");
    const text = usageFailedHistoryScorecardText(dir);
    assert.equal(text, "Usage failed history: attention, 1 failed, 1 distinct operations, 0 distinct models, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage failed parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    usageFailureSummary("MiniMax-M2.5", "EPERM: operation not permitted"),
    "Usage record failed for model MiniMax-M2.5: EPERM: operation not permitted",
  );
  assert.equal(
    usageReadFailureSummary("EPERM: operation not permitted"),
    "Usage ledger read failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseUsageFailedSummary(usageFailureSummary("mock", "boom")), { what: "record", model: "mock" });
  assert.deepEqual(parseUsageFailedSummary(usageReadFailureSummary("boom")), { what: "ledger read", model: null });
  assert.equal(parseUsageFailedSummary(""), null);
  assert.equal(parseUsageFailedSummary("Usage ledger read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseUsageFailedSummary("Usage ledger read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseUsageFailedSummary("Usage record failed for model : boom"), null, "a record with no model does not parse");
  assert.equal(parseUsageFailedSummary("Usage record failed for model mock:"), null, "a record with no reason does not parse");
  assert.equal(parseUsageFailedSummary("Usage write failed: boom"), null, "a shape the seams never write does not parse");
  assert.equal(parseUsageFailedSummary(sessionCapsFailureSummary("ledger read", "", "boom")), null, "a session-caps-failed line never parses as a usage-failed line");
  assert.deepEqual(parseUsageFailedSummary("Usage ledger read failed: boom: with colon"), { what: "ledger read", model: null }, "a reason carrying a colon still parses from the fixed head");
});

test("usage failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-usage-failed-history"), "sam-usage-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-usage-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "usage-failed-history"], "the argv rides observe usage-failed-history");
});

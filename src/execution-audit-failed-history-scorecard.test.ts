import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionAuditFailureSummary, executionAuditFailedHistoryScorecardText, parseExecutionAuditFailedSummary } from "./approved-test-runner.js";
import { recordActivity } from "./activity.js";
import { skillUseFailureSummary } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The execution audit failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the approved
// runner ledgers every failed audit touch as an
// execution-audit-failed line through the ONE writer
// executionAuditFailureSummary (naming the phase and the
// event label), ridden by recordExecutionAuditFailure from
// both seams (the append catch and the read catch) - but the
// class was never folded, so how often the runner's own
// audit ledger died, and whether a requested / started /
// finished event ever failed to land, was invisible in
// aggregate. Every failure line is by construction an audit
// touch that did not complete, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no phase name, no
// event name, no run prefix, and no verbatim reason - the
// summaries carry phases, events, run prefixes, and reasons,
// and the fold consumes and never prints them. The scorecard
// path is a pure read - it creates nothing, sends nothing,
// and retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-execution-audit-failed-history-"));
}

const BARE = "Execution audit failed history: clear, 0 failed, 0 append, 0 read, 0 distinct events, 0 total";

test("execution audit failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = executionAuditFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = executionAuditFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held execution audit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("execution audit failed history scorecard: the writer's failures fold to counts with distinct events as a number only, and no event, run prefix, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = executionAuditFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "execution-audit-failed", executionAuditFailureSummary("append", "started test (run 12345678)", "ENOENT: no such file sekrit"));
    recordActivity(dir, "sam", "execution-audit-failed", executionAuditFailureSummary("append", "started test (run 87654321)", "disk full"));
    recordActivity(dir, "sam", "execution-audit-failed", executionAuditFailureSummary("append", "finished build (run abcdef12)", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "execution-audit-failed", executionAuditFailureSummary("read", "ledger", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = executionAuditFailedHistoryScorecardText(dir);
    assert.equal(text, "Execution audit failed history: attention, 4 failed, 3 append, 1 read, 3 distinct events, 4 total");
    assert.equal(text.includes("started"), false, "no event name surfaces");
    assert.equal(text.includes("12345678"), false, "no run prefix surfaces");
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

test("execution audit failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = executionAuditFailureSummary("append", "started test (run 12345678)", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseExecutionAuditFailedSummary(capped), { phase: "append", event: "started test" });
    recordActivity(dir, "sam", "execution-audit-failed", capped);
    const text = executionAuditFailedHistoryScorecardText(dir);
    assert.equal(text, "Execution audit failed history: attention, 1 failed, 1 append, 0 read, 1 distinct events, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("execution audit failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and a mismatched phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "execution-audit-failed", executionAuditFailureSummary("append", "started test (run 12345678)", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "execution-audit-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "execution-audit-failed", skillUseFailureSummary("agent-reach", null, "boom sekrit"));
    recordActivity(dir, "sam", "execution-audit-failed", "Execution audit append failed for started test (run 12345678):   ");
    recordActivity(dir, "sam", "execution-audit-failed", "Execution audit read failed for started test (run 12345678): boom");
    const text = executionAuditFailedHistoryScorecardText(dir);
    assert.equal(text, "Execution audit failed history: attention, 1 failed, 1 append, 0 read, 1 distinct events, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("execution audit failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    executionAuditFailureSummary("append", "started test (run 12345678)", "EPERM: operation not permitted"),
    "Execution audit append failed for started test (run 12345678): EPERM: operation not permitted",
  );
  assert.deepEqual(parseExecutionAuditFailedSummary(executionAuditFailureSummary("append", "started test (run 12345678)", "boom")), { phase: "append", event: "started test" });
  assert.deepEqual(parseExecutionAuditFailedSummary(executionAuditFailureSummary("read", "ledger", "boom")), { phase: "read", event: "ledger" });
  assert.equal(parseExecutionAuditFailedSummary(""), null);
  assert.equal(parseExecutionAuditFailedSummary("Execution audit append failed for started test (run 12345678):"), null, "a line with no reason does not parse");
  assert.equal(parseExecutionAuditFailedSummary("Execution audit append failed for started test (run 12345678): "), null, "a line with a blank reason does not parse");
  assert.equal(parseExecutionAuditFailedSummary("Execution audit write failed for ledger: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseExecutionAuditFailedSummary("Execution audit append failed for ledger: boom"), null, "an append line naming the read label does not parse");
  assert.equal(parseExecutionAuditFailedSummary("Execution audit read failed for started test (run 12345678): boom"), null, "a read line naming an append event does not parse");
  assert.equal(parseExecutionAuditFailedSummary("Execution audit append failed for paused test (run 12345678): boom"), null, "an event the seam never writes does not parse");
  assert.equal(parseExecutionAuditFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), null, "a skill-use-failed line never parses as an execution-audit-failed line");
  assert.deepEqual(parseExecutionAuditFailedSummary("Execution audit append failed for finished build (run abcdef12): boom: with colon"), { phase: "append", event: "finished build" }, "a reason carrying a colon still parses from the fixed head");
});

test("execution audit failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-execution-audit-failed-history"), "sam-execution-audit-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-execution-audit-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["run", "audit-failed-history"], "the argv rides run audit-failed-history");
});

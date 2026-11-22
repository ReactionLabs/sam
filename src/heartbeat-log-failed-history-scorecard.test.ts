import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { heartbeatLogFailedHistoryScorecardText, heartbeatLogFailureSummary, parseHeartbeatLogFailedSummary, heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The heartbeat log failed history daily-measurement
// wiring (2026-11-22, the measured-proof series): a failed
// touch of the heartbeat log ledgers as a
// heartbeat-log-failed line through the ONE writer
// heartbeatLogFailureSummary, and self-work ranks the
// class as a defect - but the class was never folded, so
// how often the log that status and the daily brief fold
// as truth failed to land or to read back was invisible in
// aggregate. Every failure line is by construction a log
// touch that did not land, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no entry
// type, no job name, and no verbatim reason - the
// summaries carry entry types and job names, which the
// fold consumes into a distinct count and never prints.
// The scorecard path is a pure read - it creates nothing,
// sends nothing, retries nothing, and runs no tick; every
// state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-heartbeat-log-failed-history-"));
}

const BARE = "Heartbeat log failed history: clear, 0 append, 0 read, 0 distinct entry types, 0 total";

test("heartbeat log failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = heartbeatLogFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = heartbeatLogFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held heartbeat log scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat log failed history scorecard: the writer's failures fold to counts per phase, and no entry type, job name, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = heartbeatLogFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "heartbeat-log-failed", heartbeatLogFailureSummary("read", "ledger", null, "EISDIR: illegal operation on a directory, sekrit path"));
    recordActivity(dir, "sam", "heartbeat-log-failed", heartbeatLogFailureSummary("append", "job", "stack watch", "ENOENT: no such file"));
    recordActivity(dir, "sam", "heartbeat-log-failed", heartbeatLogFailureSummary("append", "job-failed", "stack watch", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "heartbeat-log-failed", heartbeatLogFailureSummary("append", "job-failed", "stack watch", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = heartbeatLogFailedHistoryScorecardText(dir);
    assert.equal(text, "Heartbeat log failed history: attention, 3 append, 1 read, 3 distinct entry types, 4 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("ENOENT"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("stack watch"), false, "no job name surfaces");
    assert.equal(text.includes("job-failed"), false, "no entry type surfaces");
    assert.equal(text.includes("ledger"), false, "no entry type surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat log failed history scorecard: the writer's own 300-char cap still folds from the entry head, and a name that pushes the separator past the cap folds as unparseable", () => {
  const dir = scratch();
  try {
    const capped = heartbeatLogFailureSummary("append", "job", "stack watch", "x".repeat(500));
    assert.equal(capped.length, 300, "the writer caps its line at 300");
    recordActivity(dir, "sam", "heartbeat-log-failed", capped);
    assert.deepEqual(parseHeartbeatLogFailedSummary(capped), { phase: "append", entryType: "job" });
    const buried = heartbeatLogFailureSummary("append", "job", "n".repeat(400), "boom");
    assert.equal(buried.length, 300, "the writer caps its line at 300");
    assert.equal(parseHeartbeatLogFailedSummary(buried), null, "a name that buries the reason separator past the cap never parses as a guessed count");
    recordActivity(dir, "sam", "heartbeat-log-failed", buried);
    const text = heartbeatLogFailedHistoryScorecardText(dir);
    assert.equal(text, "Heartbeat log failed history: attention, 1 append, 0 read, 1 distinct entry types, 2 total, 1 unparseable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat log failed history scorecard: an unmatched shape, an unknown entry type, a misplaced job name, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "heartbeat-log-failed", heartbeatLogFailureSummary("read", "ledger", null, "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "heartbeat-log-failed", "Some wholly novel heartbeat log shape naming sekrit_evidence");
    recordActivity(dir, "sam", "heartbeat-log-failed", "Heartbeat log append failed for some-other-store: boom sekrit");
    recordActivity(dir, "sam", "heartbeat-log-failed", "Heartbeat log append failed for consolidate job 'stack watch': boom");
    recordActivity(dir, "sam", "heartbeat-log-failed", "Heartbeat log append failed for job: boom");
    recordActivity(dir, "sam", "heartbeat-log-failed", "Heartbeat log read failed for ledger:   ");
    const text = heartbeatLogFailedHistoryScorecardText(dir);
    assert.equal(text, "Heartbeat log failed history: attention, 0 append, 1 read, 1 distinct entry types, 6 total, 5 unparseable");
    assert.equal(text.includes("novel heartbeat"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("some-other-store"), false, "an unknown entry type is never printed");
    assert.equal(text.includes("stack watch"), false, "no job name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat log failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    heartbeatLogFailureSummary("read", "ledger", null, "EISDIR: illegal operation on a directory"),
    "Heartbeat log read failed for ledger: EISDIR: illegal operation on a directory",
  );
  assert.equal(
    heartbeatLogFailureSummary("append", "job", "stack watch", "boom"),
    "Heartbeat log append failed for job job 'stack watch': boom",
  );
  assert.equal(
    heartbeatLogFailureSummary("append", "consolidate", null, "boom"),
    "Heartbeat log append failed for consolidate: boom",
  );
  assert.deepEqual(parseHeartbeatLogFailedSummary(heartbeatLogFailureSummary("append", "job", "stack watch", "boom")), { phase: "append", entryType: "job" });
  assert.deepEqual(parseHeartbeatLogFailedSummary(heartbeatLogFailureSummary("append", "delivery-suppressed", "stack watch", "boom")), { phase: "append", entryType: "delivery-suppressed" });
  assert.deepEqual(parseHeartbeatLogFailedSummary(heartbeatLogFailureSummary("append", "tick-failed", null, "boom")), { phase: "append", entryType: "tick-failed" });
  assert.deepEqual(parseHeartbeatLogFailedSummary(heartbeatLogFailureSummary("append", "entry", null, "boom")), { phase: "append", entryType: "entry" });
  assert.deepEqual(parseHeartbeatLogFailedSummary(heartbeatLogFailureSummary("read", "ledger", null, "boom")), { phase: "read", entryType: "ledger" });
  assert.equal(parseHeartbeatLogFailedSummary(""), null);
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log read failed for ledger:"), null, "a line with no reason does not parse");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log read failed for ledger: "), null, "a line with a blank reason does not parse");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log read failed for job 'stack watch': boom"), null, "the read phase names only the ledger entry");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log append failed for ledger: boom"), null, "the ledger entry never parses as an append");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log append failed for job: boom"), null, "a named entry type with no job name does not parse");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat log append failed for loops job 'stack watch': boom"), null, "an unnamed entry type carrying a job name does not parse");
  assert.equal(parseHeartbeatLogFailedSummary("Delivery outbox append failed for ledger: boom"), null, "an outbox-failed line never parses as a heartbeat log line");
  assert.equal(parseHeartbeatLogFailedSummary("Heartbeat tick stage 'consolidate' failed: boom"), null, "a tick-failed line never parses as a heartbeat log line");
});

test("heartbeat log failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-heartbeat-log-failed-history"), "sam-heartbeat-log-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-heartbeat-log-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "log-failed-history"], "the argv rides heartbeats log-failed-history");
});

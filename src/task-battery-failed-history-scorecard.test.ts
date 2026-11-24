import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskBatteryFailedSummary, taskBatteryFailedHistoryScorecardText, taskBatteryFailureSummary } from "./task-battery.js";
import { recordActivity } from "./activity.js";
import { doorFailureSummary } from "./mini-door.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The task battery failed history daily-measurement wiring
// (2026-11-24, the measured-proof series): every failed task
// battery store touch ledgers a task-battery-failed line
// through the ONE writer (taskBatteryFailureSummary, fixed
// shape "Task battery store <phase> failed: <reason>", phases
// read / write) - and while self-work labels single lines and
// the task battery history scorecard folds the success kind,
// no surface folds this kind, so a dead battery store (a
// failed write loses a run's scorecard at the final insert,
// in the store that exists to prove whether Sam got better at
// real jobs) was invisible in aggregate. Every failure line is
// by construction a store touch that did not complete, so the
// verdict is attention when any failure was ever recorded or
// any line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no reason, and no
// verbatim summary - the summaries carry the reason, and the
// fold consumes and never prints it. The scorecard path is a
// pure read - it creates nothing, runs no battery case, and
// opens no store; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-task-battery-failed-history-"));
}

const BARE = "Task battery failed history: clear, 0 failed, 0 read, 0 write, 0 total";

test("task battery failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = taskBatteryFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = taskBatteryFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held task battery scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery failed history scorecard: the writer's failures fold to counts with the read / write split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = taskBatteryFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("read", "SQLITE_CANTOPEN: unable to open /sekrit/task-battery.db"));
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("write", "boom"));
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("write", "boom again"));
    recordActivity(dir, "sam", "task-battery", "Task battery v1 recorded: 5/5 passed, live not-requested, 0 finding(s)");
    const text = taskBatteryFailedHistoryScorecardText(dir);
    assert.equal(text, "Task battery failed history: attention, 3 failed, 1 read, 2 write, 3 total");
    assert.equal(text.includes("sekrit"), false, "no path surfaces");
    assert.equal(text.includes("SQLITE_CANTOPEN"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("read", "boom"));
    recordActivity(dir, "sam", "task-battery-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "task-battery-failed", doorFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "task-battery-failed", "Task battery store read failed:   ");
    recordActivity(dir, "sam", "task-battery-failed", "Task battery store open failed: boom");
    const text = taskBatteryFailedHistoryScorecardText(dir);
    assert.equal(text, "Task battery failed history: attention, 1 failed, 1 read, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    taskBatteryFailureSummary("read", "SQLITE_CANTOPEN: unable to open database file"),
    "Task battery store read failed: SQLITE_CANTOPEN: unable to open database file",
  );
  assert.deepEqual(parseTaskBatteryFailedSummary(taskBatteryFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseTaskBatteryFailedSummary(taskBatteryFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseTaskBatteryFailedSummary(""), null);
  assert.equal(parseTaskBatteryFailedSummary("Task battery store read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseTaskBatteryFailedSummary("Task battery store read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseTaskBatteryFailedSummary("Task battery store open failed: boom"), null, "a phase the writer never writes does not parse");
  assert.equal(parseTaskBatteryFailedSummary(doorFailureSummary("read", "boom")), null, "a door-failed line never parses as a task-battery-failed line");
  assert.deepEqual(parseTaskBatteryFailedSummary("Task battery store write failed: boom: with colon"), { phase: "write" }, "a reason carrying a colon still parses from the fixed head");
});

test("task battery failed history scorecard: repeat failures in one phase raise the failed count only, and a held state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("write", "boom"));
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("write", "boom again"));
    recordActivity(dir, "sam", "task-battery-failed", taskBatteryFailureSummary("write", "boom a third time"));
    const text = taskBatteryFailedHistoryScorecardText(dir);
    assert.equal(text, "Task battery failed history: attention, 3 failed, 0 read, 3 write, 3 total");
    assert.equal(taskBatteryFailedHistoryScorecardText(dir), text, "a held state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-task-battery-failed-history"), "sam-task-battery-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-task-battery-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["battery", "failed-history"], "the argv rides battery failed-history");
});

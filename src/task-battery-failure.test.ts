import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  TASK_BATTERY_VERSION, isTaskBatteryLedgered, listTaskBatteryRuns,
  readTaskBattery, recordTaskBattery, taskBatteryFailureSummary,
  type TaskBatteryRun,
} from "./task-battery.js";
import { classifyDefect } from "./self-work.js";

// Task battery store failure visibility (gap found
// 2026-11-15, hourly run 08:04): the task battery arrived
// with the Grok Sprint 4 merge train after the store census
// closed, and its store (.sam/task-battery.db) was the one
// new store that train brought in unguarded - openStore plus
// recordTaskBattery / listTaskBatteryRuns / readTaskBattery
// all touched the file raw. Each touch now ledgers ONE
// task-battery-failed line (open + insert at phase write,
// list/read at phase read) and rethrows exactly, tagged;
// reads still fail closed (never folded as no runs, which
// would silently empty the battery's whole score history
// dressed as a version that never ran).
const EVIDENCE = "zorblax quindle evidence words";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-battery-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "task-battery-failed" });
}

function fixtureRun(): TaskBatteryRun {
  return {
    version: TASK_BATTERY_VERSION,
    at: "2026-11-15T13:00:00.000Z",
    execution: "harness",
    liveRun: "not-requested",
    overall: { passed: 4, total: 5 },
    cases: [{
      id: "research-citations", label: "Research with citations",
      passed: true, evidence: EVIDENCE, durationMs: 12, execution: "harness",
    }],
    note: "fixture",
  };
}

test("task-battery-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(taskBatteryFailureSummary("read", "unable to open\n  database   file"), "Task battery store read failed: unable to open database file");
  assert.equal(taskBatteryFailureSummary("write", "disk gone"), "Task battery store write failed: disk gone");
  assert.equal(taskBatteryFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "task-battery-failed", summary: taskBatteryFailureSummary(phase, "boom") }),
      { key: "task-battery-failed:" + phase, label: "task battery store failures (" + phase + " step)" },
    );
  }
});

test("task-battery-failed: a dead store at record ledgers exactly one write line, tagged, and rethrows", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "task-battery.db"), { recursive: true });
    assert.throws(() => recordTaskBattery(root, fixtureRun()), (e: unknown) => isTaskBatteryLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Task battery store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "task-battery-failed:write", label: "task battery store failures (write step)" });
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no scorecard evidence ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-battery-failed: a dead read ledgers one read line per touch, with no second line from readTaskBattery", () => {
  const root = scratch();
  try {
    // A directory planted at the store path: the read's own open
    // dies at the read touch (a renamed-away table would heal -
    // openStore recreates the schema on every open by design).
    mkdirSync(join(root, ".sam", "task-battery.db"), { recursive: true });

    assert.throws(() => listTaskBatteryRuns(root), (e: unknown) => isTaskBatteryLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Task battery store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "task-battery-failed:read", label: "task battery store failures (read step)" });

    assert.throws(() => readTaskBattery(root), (e: unknown) => isTaskBatteryLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line per failed touch, and read adds no second line over list");
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no scorecard evidence ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-battery-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    recordTaskBattery(root, fixtureRun());
    const raw = openDatabase(join(root, ".sam", "task-battery.db"));
    try { raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON task_battery BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;"); } finally { raw.close(); }
    assert.throws(() => recordTaskBattery(root, fixtureRun()), (e: unknown) => isTaskBatteryLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Task battery store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no scorecard evidence ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-battery-failed: an absent store reads as no runs, creates nothing, and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(listTaskBatteryRuns(root), []);
    assert.equal(readTaskBattery(root), null);
    assert.equal(existsSync(join(root, ".sam", "task-battery.db")), false, "a pure read creates no store");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-battery-failed: a healthy store exercises every surface with zero failure lines", () => {
  const root = scratch();
  try {
    recordTaskBattery(root, fixtureRun());
    recordTaskBattery(root, { ...fixtureRun(), at: "2026-11-15T14:00:00.000Z", overall: { passed: 5, total: 5 } });
    assert.equal(listTaskBatteryRuns(root).length, 2);
    assert.equal(listTaskBatteryRuns(root, TASK_BATTERY_VERSION).length, 2);
    assert.equal(readTaskBattery(root)?.overall.passed, 5);
    assert.equal(readTaskBattery(root, "s0.0"), null, "an unknown version reads as never run");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

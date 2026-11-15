import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { MissionStore } from "./storage.js";
import { TaskScheduler, taskStoreFailureSummary, isTaskStoreLedgered } from "./tasks.js";
import { OfflineMissionRunner } from "./offline-runner.js";
import { classifyDefect } from "./self-work.js";

// Task store failure visibility (gap found 2026-11-15,
// hourly run 03:04): the TaskScheduler riding missions.db
// touched its handle raw - the constructor's schema exec
// plus add / list / claim / heartbeat / complete threw
// into whichever catch wrapped the call with the seam
// unnamed. Each touch now ledgers ONE task-store-failed
// line (constructor open at phase write, list at phase
// read, mutations at phase write) and rethrows exactly,
// tagged, when the scheduler carries an install root;
// every caller's handling is unchanged and reads still
// fail closed (never folded as no tasks, which would
// silently drop the mission's whole plan dressed as an
// empty list). A handle-only construction has no install
// ledger and rethrows bare.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tasks-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "task-store-failed" });
}

function dbPath(root: string): string {
  return join(root, ".sam", "missions.db");
}

/** A rooted scheduler over a fresh missions.db, with its
 *  MissionStore beside it (the production CLI shape). */
function fixture(root: string): { missions: MissionStore; tasks: TaskScheduler; close: () => void } {
  const missions = new MissionStore(dbPath(root));
  const db = openDatabase(dbPath(root));
  db.pragma("foreign_keys = ON");
  const tasks = new TaskScheduler(db, root);
  return { missions, tasks, close: () => { db.close(); missions.close(); } };
}

function runningMission(missions: MissionStore, objective: string): string {
  const m = missions.create(objective);
  missions.transition(m.code, "PLANNING");
  missions.transition(m.code, "READY");
  missions.transition(m.code, "RUNNING");
  return m.id;
}

test("task-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(taskStoreFailureSummary("read", "unable to open\n  database   file"), "Task store read failed: unable to open database file");
  assert.equal(taskStoreFailureSummary("write", "disk gone"), "Task store write failed: disk gone");
  assert.equal(taskStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "task-store-failed", summary: taskStoreFailureSummary(phase, "boom") }),
      { key: "task-store-failed:" + phase, label: "task store failures (" + phase + " step)" },
    );
  }
});

test("task-store-failed: a dead store at construction ledgers exactly one write line, tagged, and rethrows; handle-only rethrows bare", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const seed = openDatabase(dbPath(root));
    seed.close();
    const db = openDatabase(dbPath(root), { readonly: true });
    try {
      assert.throws(() => new TaskScheduler(db, root), (e: unknown) => isTaskStoreLedgered(e));
      const lines = failedLines(root);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].actor, "sam");
      assert.ok(lines[0].summary.startsWith("Task store write failed: "), lines[0].summary);
      assert.deepEqual(classifyDefect(lines[0]), { key: "task-store-failed:write", label: "task store failures (write step)" });
      // The same dead handle with no install root has no
      // ledger to write to: it rethrows bare, untagged,
      // and no second line lands.
      assert.throws(() => new TaskScheduler(db), (e: unknown) => !isTaskStoreLedgered(e));
      assert.equal(failedLines(root).length, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-store-failed: a dead read on a live handle ledgers one read line per touch, and a dead claim one write line", () => {
  const root = scratch();
  try {
    const { missions, tasks, close } = fixture(root);
    const missionId = runningMission(missions, "Read failure mission");
    tasks.add(missionId, "A Plan That Must Not Leak");
    const raw = openDatabase(dbPath(root));
    try { raw.exec("ALTER TABLE tasks RENAME TO tasks_gone"); } finally { raw.close(); }

    assert.throws(() => tasks.list(missionId), (e: unknown) => isTaskStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Task store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "task-store-failed:read", label: "task store failures (read step)" });

    assert.throws(() => tasks.claim(missionId, "worker-a", 1000, 100), (e: unknown) => isTaskStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line per failed touch");
    assert.ok(lines[1].summary.startsWith("Task store write failed: "), lines[1].summary);

    close();
    assert.ok(!JSON.stringify(lines).includes("A Plan That Must Not Leak"), "no task objective ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    const { missions, tasks, close } = fixture(root);
    const missionId = runningMission(missions, "Insert failure mission");
    const raw = openDatabase(dbPath(root));
    try { raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;"); } finally { raw.close(); }
    assert.throws(() => tasks.add(missionId, "an objective that must not leak"), (e: unknown) => isTaskStoreLedgered(e));
    close();
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Task store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes("an objective that must not leak"), "no task objective ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-store-failed: validation and data errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    const { missions, tasks, close } = fixture(root);
    const aId = runningMission(missions, "Validation mission A");
    const b = missions.create("Validation mission B");
    const task = tasks.add(aId, "first task");
    const plain = (re: RegExp) => (e: unknown) => re.test((e as Error).message) && !isTaskStoreLedgered(e);
    assert.throws(() => tasks.add(aId, "   "), plain(/^Task objective required$/));
    assert.throws(() => tasks.add("00000000-0000-0000-0000-000000000000", "orphan"), plain(/^Mission does not exist$/));
    assert.throws(() => tasks.add(b.id, "second", [task.id]), plain(/^Dependency must belong to mission$/));
    assert.throws(() => tasks.claim(aId, "  ", 1000, 100), plain(/^Invalid worker$/));
    assert.throws(() => tasks.claim(aId, "worker", Number.NaN, 100), plain(/^Invalid lease timestamp or TTL$/));
    assert.throws(() => tasks.heartbeat(task.id, "worker", 1, Number.NaN, 100), plain(/^Invalid lease timestamp or TTL$/));
    assert.throws(() => tasks.complete(task.id, "worker", 1, true, Number.NaN), plain(/^Invalid completion timestamp$/));
    close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-store-failed: a healthy store exercises every surface with zero failure lines, the offline runner's rooted scheduler included", () => {
  const root = scratch();
  try {
    const { missions, tasks, close } = fixture(root);
    const missionId = runningMission(missions, "Healthy mission");
    const first = tasks.add(missionId, "inspect");
    const second = tasks.add(missionId, "fix", [first.id]);
    assert.equal(tasks.list(missionId).length, 2);
    const lease = tasks.claim(missionId, "worker-a", 1000, 1000)!;
    assert.equal(lease.id, first.id);
    assert.equal(tasks.heartbeat(first.id, "worker-a", lease.lease_generation, 1100, 1000), true);
    assert.equal(tasks.complete(first.id, "worker-a", lease.lease_generation, true, 1200), true);
    const next = tasks.claim(missionId, "worker-a", 1201, 1000)!;
    assert.equal(next.id, second.id);
    assert.equal(tasks.complete(second.id, "worker-a", next.lease_generation, true, 1250), true);
    close();

    // The offline runner threads the root into its own
    // scheduler: constructing one and reading a result
    // back over the same store adds no failure lines.
    const db = openDatabase(dbPath(root));
    try {
      const runner = new OfflineMissionRunner(db, Date.now, root);
      assert.equal(runner.result(first.id), undefined);
    } finally { db.close(); }
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

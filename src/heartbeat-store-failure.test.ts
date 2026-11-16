import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  addHeartbeatJob, consolidatePreferences, heartbeatJobs, heartbeatJobsStoreFailureSummary,
  heartbeatState, heartbeatStateStoreFailureSummary, isHeartbeatJobsStoreLedgered,
  isHeartbeatStateStoreLedgered, removeHeartbeatJob, runHeartbeat, updateHeartbeatJob,
} from "./heartbeat.js";
import { classifyDefect } from "./self-work.js";

// Heartbeat stores failure visibility (gap found 2026-11-16,
// hourly run 03:04): heartbeat.ts carries two stores of its
// own - the jobs store (.sam/heartbeat-jobs.db, the standing-
// job registry) and the state store (.sam/heartbeat-state.db,
// the tick/consolidation watermarks and P3 diff records) -
// and every touch of both opened them raw: a dead store threw
// with the seam unnamed, a reader folding the jobs store as
// no jobs would silently retire every standing job, and a
// reader folding the state store as empty state would revert
// every watermark and diff baseline. Each touch now ledgers
// ONE line of its store's kind (phase read / write) and
// rethrows exactly, tagged; reads still fail closed and
// absent stores still read as no jobs / empty state.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-heartbeat-fail-")); }

function jobsFailedLines(root: string) {
  return readActivity(root, 100, { kind: "heartbeat-jobs-store-failed" });
}
function stateFailedLines(root: string) {
  return readActivity(root, 100, { kind: "heartbeat-state-store-failed" });
}

function seedJobRow(root: string, id: string, data: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const db = openDatabase(join(root, ".sam", "heartbeat-jobs.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS heartbeat_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO heartbeat_jobs (id, data) VALUES (?, ?)").run(id, data);
  } finally { db.close(); }
}

function seedStateRow(root: string, key: string, data: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const db = openDatabase(join(root, ".sam", "heartbeat-state.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS heartbeat_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO heartbeat_state (key, data) VALUES (?, ?)").run(key, data);
  } finally { db.close(); }
}

function plantDeadStore(root: string, file: string): void {
  rmSync(join(root, ".sam", file), { force: true });
  rmSync(join(root, ".sam", file + "-wal"), { force: true });
  rmSync(join(root, ".sam", file + "-shm"), { force: true });
  mkdirSync(join(root, ".sam", file), { recursive: true });
}

test("heartbeat-store-failed: summary shapes collapse and cap the reason, and self-work classifies both kinds by phase", () => {
  assert.equal(heartbeatJobsStoreFailureSummary("read", "unable to open\n  database   file"), "Heartbeat jobs store read failed: unable to open database file");
  assert.equal(heartbeatJobsStoreFailureSummary("write", "disk gone"), "Heartbeat jobs store write failed: disk gone");
  assert.equal(heartbeatJobsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  assert.equal(heartbeatStateStoreFailureSummary("read", "unable to open\n  database   file"), "Heartbeat state store read failed: unable to open database file");
  assert.equal(heartbeatStateStoreFailureSummary("write", "disk gone"), "Heartbeat state store write failed: disk gone");
  assert.equal(heartbeatStateStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "heartbeat-jobs-store-failed", summary: heartbeatJobsStoreFailureSummary(phase, "boom") }),
      { key: "heartbeat-jobs-store-failed:" + phase, label: "heartbeat jobs store failures (" + phase + " step)" },
    );
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "heartbeat-state-store-failed", summary: heartbeatStateStoreFailureSummary(phase, "boom") }),
      { key: "heartbeat-state-store-failed:" + phase, label: "heartbeat state store failures (" + phase + " step)" },
    );
  }
});

test("heartbeat-store-failed: healthy job create, read-back, update, remove, and a tick ledger no failure line", async () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack in secret detail");
    assert.equal(heartbeatJobs(root).length, 1);
    const patched = updateHeartbeatJob(root, job.id, { minutes: 45 });
    assert.equal(patched?.minutes, 45);
    const result = await runHeartbeat(root, { ensureChat: async () => "hb-chat", runTurn: async () => "all quiet" });
    assert.deepEqual(result.changed, ["stack watch"]);
    assert.equal(typeof heartbeatState(root).lastTick, "string");
    assert.equal(removeHeartbeatJob(root, job.id), true);
    assert.deepEqual(heartbeatJobs(root), []);
    assert.equal(jobsFailedLines(root).length, 0);
    assert.equal(stateFailedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: absent stores read as no jobs and empty state, create nothing, and ledger nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(heartbeatJobs(root), []);
    assert.deepEqual(heartbeatState(root), { chats: {}, lastTick: null, outputs: {} });
    assert.equal(updateHeartbeatJob(root, "nope", { minutes: 5 }), null);
    assert.equal(removeHeartbeatJob(root, "nope"), false);
    assert.equal(jobsFailedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(stateFailedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a torn state row still parses forgiving and ledgers nothing", () => {
  const root = fresh();
  try {
    seedStateRow(root, "meta", JSON.stringify({ lastTick: "2026-11-10T00:00:00.000Z" }));
    seedStateRow(root, "chat:chat-1", "{ not json");
    const state = heartbeatState(root);
    assert.equal(state.lastTick, "2026-11-10T00:00:00.000Z");
    assert.deepEqual(state.chats, {}, "the torn row's part reads as absent, never fatal");
    assert.equal(stateFailedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a torn job row dies at the read seam with exactly one read line", () => {
  const root = fresh();
  try {
    seedJobRow(root, "job-a", "{ not json");
    assert.throws(() => heartbeatJobs(root), (e: unknown) => isHeartbeatJobsStoreLedgered(e));
    const lines = jobsFailedLines(root);
    assert.equal(lines.length, 1, "the store's own torn content is a read failure, ledgered once");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Heartbeat jobs store read failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: malformed legacy files import nothing and ledger nothing", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), "{ not json");
    writeFileSync(join(root, ".sam", "heartbeat-state.json"), "{ not json");
    assert.deepEqual(heartbeatJobs(root), []);
    assert.deepEqual(heartbeatState(root), { chats: {}, lastTick: null, outputs: {} });
    assert.equal(jobsFailedLines(root).length, 0, "a forgiving import is not a store failure");
    assert.equal(stateFailedLines(root).length, 0, "a forgiving import is not a store failure");
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json")), true, "the malformed file is left in place");
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json")), true, "the malformed file is left in place");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a dead jobs store ledgers exactly one line per touch, tagged, rethrows, and carries no job content", () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack in secret detail");
    plantDeadStore(root, "heartbeat-jobs.db");

    assert.throws(() => heartbeatJobs(root), (e: unknown) => isHeartbeatJobsStoreLedgered(e));
    let lines = jobsFailedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Heartbeat jobs store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "heartbeat-jobs-store-failed:read", label: "heartbeat jobs store failures (read step)" });

    assert.throws(() => updateHeartbeatJob(root, job.id, { minutes: 5 }), (e: unknown) => isHeartbeatJobsStoreLedgered(e));
    lines = jobsFailedLines(root);
    assert.equal(lines.length, 2, "update dies at its inner heartbeatJobs read with exactly one line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Heartbeat jobs store read failed: "), lines[1].summary);

    assert.ok(!JSON.stringify(lines).includes("stack watch"), "no job name ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("secret detail"), "no job prompt ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes(job.id), "no job id ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a failing job insert ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seedJobRow(root, "job-seed", JSON.stringify({ id: "job-seed", name: "seed job", minutes: 30, profile: "sam", prompt: "seed", channelId: null, enabled: true, lastRun: null }));
    const raw = openDatabase(join(root, ".sam", "heartbeat-jobs.db"));
    try {
      raw.exec("CREATE TRIGGER planted_job_insert_fail BEFORE INSERT ON heartbeat_jobs BEGIN SELECT RAISE(ABORT, 'planted job write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack"), (e: unknown) => isHeartbeatJobsStoreLedgered(e));
    const lines = jobsFailedLines(root);
    assert.equal(lines.length, 1, "the write touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Heartbeat jobs store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted job write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "heartbeat-jobs-store-failed:write", label: "heartbeat jobs store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a failing job update ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const raw = openDatabase(join(root, ".sam", "heartbeat-jobs.db"));
    try {
      raw.exec("CREATE TRIGGER planted_job_update_fail BEFORE UPDATE ON heartbeat_jobs BEGIN SELECT RAISE(ABORT, 'planted job write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateHeartbeatJob(root, job.id, { minutes: 5 }), (e: unknown) => isHeartbeatJobsStoreLedgered(e));
    const lines = jobsFailedLines(root);
    assert.equal(lines.length, 1, "the update write ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Heartbeat jobs store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted job write failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a dead state store ledgers exactly one read line, tagged, rethrows, and carries no state content", () => {
  const root = fresh();
  try {
    seedStateRow(root, "meta", JSON.stringify({ lastTick: "2026-11-10T00:00:00.000Z" }));
    plantDeadStore(root, "heartbeat-state.db");
    assert.throws(() => heartbeatState(root), (e: unknown) => isHeartbeatStateStoreLedgered(e));
    const lines = stateFailedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Heartbeat state store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "heartbeat-state-store-failed:read", label: "heartbeat state store failures (read step)" });
    assert.ok(!JSON.stringify(lines).includes("2026-11-10"), "no watermark ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat-store-failed: a failing state save ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seedStateRow(root, "meta", JSON.stringify({ lastTick: null }));
    const raw = openDatabase(join(root, ".sam", "heartbeat-state.db"));
    try {
      raw.exec("CREATE TRIGGER planted_state_insert_fail BEFORE INSERT ON heartbeat_state BEGIN SELECT RAISE(ABORT, 'planted state write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => consolidatePreferences(root), (e: unknown) => isHeartbeatStateStoreLedgered(e));
    const lines = stateFailedLines(root);
    assert.equal(lines.length, 1, "the save touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Heartbeat state store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted state write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "heartbeat-state-store-failed:write", label: "heartbeat state store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

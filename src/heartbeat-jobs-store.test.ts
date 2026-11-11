import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, addScheduledJob, heartbeatJobs, removeHeartbeatJob, runHeartbeat, updateHeartbeatJob, type HeartbeatJob } from "./heartbeat.js";

// State convergence (UNIFICATION item 4, second store): the heartbeat
// job store migrated from whole-file heartbeat-jobs.json rewrites to
// one-row-per-job SQLite. These tests pin the migration contract:
// legacy files import in order with every optional schedule field
// intact, are renamed (never deleted), a malformed file imports
// nothing and stays put, a pure read creates nothing, single-row
// mutations cannot lose each other, and a tick over a migrated
// legacy job persists its lastRun through the row update alone.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-jobs-store-")); }

function legacyJob(id: string, name: string, extra: Partial<HeartbeatJob> = {}): HeartbeatJob {
  return { id, name, minutes: 30, profile: "trading", prompt: "Check the stack", channelId: null, enabled: true, lastRun: null, ...extra };
}

test("job store: a legacy heartbeat-jobs.json imports in order, optional fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const cronJob = legacyJob("job-1", "morning brief", { minutes: 0, prompt: "Brief me", cron: "0 9 * * *", schedule: "daily at 9am", timezone: "America/New_York", createdAt: "2026-11-01T00:00:00.000Z" });
    const scriptJob = legacyJob("job-2", "stack watch", { minutes: 0, prompt: "", mode: "script", script: "sam-stack-watch", schedule: "every 30 minutes", timezone: "America/New_York", createdAt: "2026-11-02T00:00:00.000Z", lastRun: "2026-11-10T00:00:00.000Z" });
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), JSON.stringify([cronJob, scriptJob], null, 2));
    const items = heartbeatJobs(root);
    assert.deepEqual(items.map(j => j.id), ["job-1", "job-2"]);
    assert.deepEqual(items[0], cronJob);
    assert.deepEqual(items[1], scriptJob);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.db")), true);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json")), false);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "heartbeat-jobs.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    const added = addHeartbeatJob(root, "evening check", 60, "sam", "Check in");
    assert.deepEqual(heartbeatJobs(root).map(j => j.id), ["job-1", "job-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("job store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), "{ not json");
    assert.deepEqual(heartbeatJobs(root), []);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json")), true);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json.migrated")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("job store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(heartbeatJobs(root), []);
    assert.equal(existsSync(join(root, ".sam")), false);
    assert.equal(removeHeartbeatJob(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("job store: interleaved creates, an update, and a remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = addHeartbeatJob(root, "alpha watch", 30, "sam", "Watch alpha");
    const b = addScheduledJob(root, { name: "beta brief", profile: "sam", schedule: "daily at 9am", timezone: "UTC", prompt: "Brief beta" });
    const patched = updateHeartbeatJob(root, a.id, { lastRun: "2026-11-10T09:00:00.000Z" });
    assert.equal(patched?.lastRun, "2026-11-10T09:00:00.000Z");
    assert.equal(updateHeartbeatJob(root, "ghost", { lastRun: null }), null);
    assert.equal(removeHeartbeatJob(root, b.id), true);
    assert.equal(removeHeartbeatJob(root, b.id), false);
    const items = heartbeatJobs(root);
    assert.deepEqual(items.map(j => j.id), [a.id]);
    assert.equal(items[0].lastRun, "2026-11-10T09:00:00.000Z");
    assert.equal(items[0].prompt, "Watch alpha");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("job store: a tick over a migrated legacy job runs it and persists lastRun in the DB", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), JSON.stringify([legacyJob("job-9", "stack watch")], null, 2));
    const result = await runHeartbeat(root, {
      ensureChat: async () => "hb-chat",
      runTurn: async () => "Candidates total: 282,966\nALERT verdict count: 9",
    });
    assert.deepEqual(result.ran, ["stack watch"]);
    const items = heartbeatJobs(root);
    assert.equal(items.length, 1);
    assert.ok(items[0].lastRun);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-jobs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

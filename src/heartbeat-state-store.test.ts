import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, consolidatePreferences, heartbeatOutputHash, heartbeatState, runHeartbeat, updateHeartbeatJob, type HeartbeatOutputRecord } from "./heartbeat.js";

// State convergence (UNIFICATION item 4, third store): the heartbeat
// diff/watermark state migrated from whole-file heartbeat-state.json
// rewrites to keyed-row SQLite. These tests pin the migration
// contract: a legacy file imports with full fidelity (watermarks,
// lastTick, P3 output records), is renamed (never deleted), a
// malformed file imports nothing and stays put, a pure read creates
// nothing, the two save paths (consolidation watermarks, tick
// outputs) upsert their own parts without reverting each other's,
// and a migrated P3 baseline still silences an unchanged job.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-state-store-")); }

const OUTPUT: HeartbeatOutputRecord = { hash: "abc123", at: "2026-11-10T00:00:00.000Z", preview: "Candidates total: 282,966", sig: "n:282966|n:9" };

test("state store: a legacy heartbeat-state.json imports with full fidelity, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = { chats: { "chat-1": "2026-11-09T02:05:19.604Z", "chat-2": "" }, lastTick: "2026-11-10T04:01:07.357Z", outputs: { "job-1": OUTPUT } };
    writeFileSync(join(root, ".sam", "heartbeat-state.json"), JSON.stringify(legacy, null, 2));
    const state = heartbeatState(root);
    assert.deepEqual(state.chats, legacy.chats);
    assert.equal(state.lastTick, legacy.lastTick);
    assert.deepEqual(state.outputs, legacy.outputs);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.db")), true);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json")), false);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "heartbeat-state.json.migrated"), "utf8")) as typeof legacy;
    assert.deepEqual(kept, legacy);
    // Later saves ride the DB and never recreate the JSON file.
    consolidatePreferences(root);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json")), false);
    assert.equal(typeof heartbeatState(root).lastTick, "string");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "heartbeat-state.json"), "{ not json");
    assert.deepEqual(heartbeatState(root), { chats: {}, lastTick: null, outputs: {} });
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json")), true);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json.migrated")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(heartbeatState(root), { chats: {}, lastTick: null, outputs: {} });
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state store: consolidation watermarks and tick outputs upsert their own parts (no cross-path revert)", async () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const reply = "- Candidates total: **282,966**\n- ALERT verdict count: **9**";
    const deps = { ensureChat: async () => "hb-chat", runTurn: async () => reply };
    const first = await runHeartbeat(root, deps);
    assert.deepEqual(first.changed, ["stack watch"]);
    const afterTick = heartbeatState(root);
    assert.equal(afterTick.outputs?.[job.id]?.hash, heartbeatOutputHash(reply));
    // A new chat message arrives; consolidation advances its
    // watermark and lastTick. The job's diff baseline must not
    // revert to anything older in the same save.
    const db = new ChatStore(root);
    const chat = db.create("Desk", "trading");
    db.add(chat.id, "user", "I like short answers");
    db.close();
    const consolidation = consolidatePreferences(root);
    assert.equal(consolidation.scanned, 1);
    const afterConsolidation = heartbeatState(root);
    assert.equal(typeof afterConsolidation.chats[chat.id], "string");
    assert.equal(afterConsolidation.outputs?.[job.id]?.hash, heartbeatOutputHash(reply));
    // And the baseline still does its P3 job: the same reply on the
    // next due tick reads unchanged, not a fresh announcement.
    updateHeartbeatJob(root, job.id, { lastRun: "2000-01-01T00:00:00.000Z" });
    const second = await runHeartbeat(root, deps);
    assert.deepEqual(second.unchanged, ["stack watch"]);
    assert.deepEqual(second.changed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state store: a tick over a migrated legacy baseline stays silent on identical facts", async () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const reply = "- Candidates total: **282,966**\n- ALERT verdict count: **9**";
    const legacy = { chats: {}, lastTick: "2026-11-10T00:00:00.000Z", outputs: { [job.id]: { hash: heartbeatOutputHash(reply), at: "2026-11-10T00:00:00.000Z", preview: reply.slice(0, 300) } } };
    writeFileSync(join(root, ".sam", "heartbeat-state.json"), JSON.stringify(legacy));
    const result = await runHeartbeat(root, { ensureChat: async () => "hb-chat", runTurn: async () => reply });
    assert.deepEqual(result.unchanged, ["stack watch"]);
    assert.deepEqual(result.changed, []);
    assert.equal(existsSync(join(root, ".sam", "heartbeat-state.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

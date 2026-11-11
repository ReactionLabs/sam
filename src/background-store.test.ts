import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { drainBackgroundTasks, getBackgroundTask, listBackgroundTasks, queueBackgroundTask, updateBackgroundTask, type BackgroundTask } from "./background.js";

// State convergence (UNIFICATION item 4, fourth store): the background
// queue migrated from whole-file background.json rewrites to
// one-row-per-task SQLite. These tests pin the migration contract:
// legacy files import in order with every field intact, are renamed
// (never deleted), a malformed file imports nothing and stays put, a
// pure read creates nothing, single-row mutations cannot lose each
// other, and a drain over a migrated legacy task persists its done
// mark through the row updates alone.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-bg-store-")); }

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", "trading").id; } finally { db.close(); }
}

function legacyTask(id: string, title: string, extra: Partial<BackgroundTask> = {}): BackgroundTask {
  return { id, actor: "trading", chatId: "chat-1", title, prompt: "Do the deep work", status: "queued", createdAt: "2026-11-01T00:00:00.000Z", startedAt: null, finishedAt: null, result: null, ...extra };
}

test("background store: a legacy background.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const done = legacyTask("task-1", "finished dive", { status: "done", startedAt: "2026-11-01T01:00:00.000Z", finishedAt: "2026-11-01T01:05:00.000Z", result: "the answer" });
    const queued = legacyTask("task-2", "waiting dive");
    writeFileSync(join(root, ".sam", "background.json"), JSON.stringify([done, queued], null, 2));
    const items = listBackgroundTasks(root);
    assert.deepEqual(items.map(t => t.id), ["task-1", "task-2"]);
    assert.deepEqual(items[0], done);
    assert.deepEqual(items[1], queued);
    assert.equal(existsSync(join(root, ".sam", "background.db")), true);
    assert.equal(existsSync(join(root, ".sam", "background.json")), false);
    assert.equal(existsSync(join(root, ".sam", "background.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "background.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    const chatId = scratchChat(root);
    const added = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "Another deep dive" });
    assert.deepEqual(listBackgroundTasks(root).map(t => t.id), ["task-1", "task-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "background.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "background.json"), "{ not json");
    assert.deepEqual(listBackgroundTasks(root), []);
    assert.equal(existsSync(join(root, ".sam", "background.json")), true);
    assert.equal(existsSync(join(root, ".sam", "background.json.migrated")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listBackgroundTasks(root), []);
    assert.equal(getBackgroundTask(root, "nope"), null);
    assert.equal(updateBackgroundTask(root, "nope", { status: "done" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background store: interleaved queues and a single-row update all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const chatId = scratchChat(root);
    const a = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "Alpha research", title: "Alpha" });
    const b = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "Beta research", title: "Beta" });
    const patched = updateBackgroundTask(root, a.id, { status: "running", startedAt: "2026-11-10T09:00:00.000Z" });
    assert.equal(patched?.status, "running");
    assert.equal(patched?.startedAt, "2026-11-10T09:00:00.000Z");
    assert.equal(updateBackgroundTask(root, "ghost", { status: "done" }), null);
    const items = listBackgroundTasks(root);
    assert.deepEqual(items.map(t => t.id), [a.id, b.id]);
    assert.equal(items[0].status, "running");
    assert.equal(items[1].status, "queued");
    assert.equal(items[1].title, "Beta");
    assert.equal(getBackgroundTask(root, b.id)?.prompt, "Beta research");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background store: a drain over a migrated legacy task runs it and persists done in the DB", async () => {
  const root = fresh();
  try {
    const chatId = scratchChat(root);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "background.json"), JSON.stringify([legacyTask("task-9", "legacy dive", { chatId })], null, 2));
    const out = await drainBackgroundTasks(root, { runTurn: async () => "the deep answer" });
    assert.deepEqual(out.ran, ["task-9"]);
    const items = listBackgroundTasks(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "done");
    assert.equal(items[0].result, "the deep answer");
    assert.ok(items[0].startedAt && items[0].finishedAt);
    assert.equal(existsSync(join(root, ".sam", "background.json")), false);
    assert.equal(existsSync(join(root, ".sam", "background.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

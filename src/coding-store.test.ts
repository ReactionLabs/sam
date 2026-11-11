import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { drainCodingTasks, getCodingTask, listCodingTasks, queueCodingTask, updateCodingTask, type CodingTask } from "./coding.js";

// State convergence (UNIFICATION item 4, sixth store): the coding
// queue migrated from whole-file coding.json rewrites to
// one-row-per-task SQLite. These tests pin the migration contract:
// legacy files import in order with every field intact, are renamed
// (never deleted), a malformed file imports nothing and stays put, a
// pure read creates nothing, single-row mutations cannot lose each
// other, and a drain over a migrated legacy task persists its close
// through the row updates alone.

function fresh(): { base: string; sam: string; proj: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-coding-store-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { base, sam, proj };
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", "trading").id; } finally { db.close(); }
}

function legacyTask(id: string, title: string, extra: Partial<CodingTask> = {}): CodingTask {
  return {
    id, actor: "trading", chatId: "chat-1", spec: title, title, status: "queued", iterations: 0, maxIterations: 3,
    createdAt: "2026-11-01T00:00:00.000Z", startedAt: null, finishedAt: null, result: null, verification: null,
    changes: [], review: null, git: null, ...extra,
  };
}

test("coding store: a legacy coding.json imports in order, fields intact, file renamed not deleted", () => {
  const { base, sam, proj } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const done = legacyTask("task-1", "finished build", {
      status: "done", iterations: 2, startedAt: "2026-11-01T01:00:00.000Z", finishedAt: "2026-11-01T01:05:00.000Z",
      result: "shipped", verification: "verified", changes: [{ path: "src/a.ts", created: true, addedLines: 3, removedLines: 0 }],
      review: "PASS: No concerns.", git: { mode: "none", branch: null, baseSha: null, commits: [], pending: [], error: null },
    });
    const queued = legacyTask("task-2", "waiting build");
    writeFileSync(join(sam, ".sam", "coding.json"), JSON.stringify([done, queued], null, 2));
    const items = listCodingTasks(sam);
    assert.deepEqual(items.map(t => t.id), ["task-1", "task-2"]);
    assert.deepEqual(items[0], done);
    assert.deepEqual(items[1], queued);
    assert.equal(existsSync(join(sam, ".sam", "coding.db")), true);
    assert.equal(existsSync(join(sam, ".sam", "coding.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "coding.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(sam, ".sam", "coding.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const added = queueCodingTask(sam, { actor: "trading", chatId, spec: "Another build" });
    assert.deepEqual(listCodingTasks(sam).map(t => t.id), ["task-1", "task-2", added.id]);
    assert.equal(existsSync(join(sam, ".sam", "coding.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding store: a malformed legacy file imports nothing and is left in place", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "coding.json"), "{ not json");
    assert.deepEqual(listCodingTasks(sam), []);
    assert.equal(existsSync(join(sam, ".sam", "coding.json")), true);
    assert.equal(existsSync(join(sam, ".sam", "coding.json.migrated")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding store: a pure read on an empty install creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-coding-store-empty-"));
  try {
    assert.deepEqual(listCodingTasks(root), []);
    assert.equal(getCodingTask(root, "nope"), null);
    assert.equal(updateCodingTask(root, "nope", { status: "done" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coding store: interleaved queues and a single-row update all survive (no whole-file lost update)", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const a = queueCodingTask(sam, { actor: "trading", chatId, spec: "Alpha build" });
    const b = queueCodingTask(sam, { actor: "trading", chatId, spec: "Beta build" });
    const patched = updateCodingTask(sam, a.id, { status: "running", startedAt: "2026-11-10T09:00:00.000Z", iterations: 1 });
    assert.equal(patched?.status, "running");
    assert.equal(patched?.iterations, 1);
    assert.equal(updateCodingTask(sam, "ghost", { status: "done" }), null);
    const items = listCodingTasks(sam);
    assert.deepEqual(items.map(t => t.id), [a.id, b.id]);
    assert.equal(items[0].status, "running");
    assert.equal(items[1].status, "queued");
    assert.equal(items[1].title, "Beta build");
    assert.equal(getCodingTask(sam, b.id)?.spec, "Beta build");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding store: a drain over a migrated legacy task closes it and persists done in the DB", async () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    writeFileSync(join(sam, ".sam", "coding.json"), JSON.stringify([legacyTask("task-9", "legacy build", { chatId, spec: "Check whether a greeting file exists" })], null, 2));
    const out = await drainCodingTasks(sam, { runTurn: async () => "nothing to change" });
    assert.deepEqual(out.ran, ["task-9"]);
    const items = listCodingTasks(sam);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "done");
    assert.match(items[0].result ?? "", /No code changes were made/);
    assert.ok(items[0].startedAt && items[0].finishedAt);
    assert.equal(existsSync(join(sam, ".sam", "coding.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "coding.db")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

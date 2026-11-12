import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { drainEngineTasks, getEngineTask, listEngineTasks, queueEngineTask, updateEngineTask, type EngineTask } from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";

// State convergence (UNIFICATION item 4, seventh store): the
// managed engine queue migrated from whole-file engine.json
// rewrites to one-row-per-task SQLite. These tests pin the
// migration contract: legacy files import in order with every
// field intact, are renamed (never deleted), a malformed file
// imports nothing and stays put, a pure read creates nothing,
// single-row mutations cannot lose each other, and a drain over
// a migrated legacy task persists its close through the row
// updates alone.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-store-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const binDir = join(base, "bin");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  git(proj, "init", "-q");
  git(proj, "add", "package.json", "tracked.txt");
  git(proj, "commit", "-q", "-m", "initial");
  const fake = installFakeEngine(binDir, { workFile: join(base, "engine-work.mjs"), projectDir: proj });
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  const prev = process.env.SAM_ENGINE_BIN;
  process.env.SAM_ENGINE_BIN = fake;
  return {
    base, sam, proj, chatId,
    cleanup() {
      if (prev === undefined) delete process.env.SAM_ENGINE_BIN; else process.env.SAM_ENGINE_BIN = prev;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-store-plain-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function legacyTask(id: string, title: string, extra: Partial<EngineTask> = {}): EngineTask {
  return {
    id, actor: "trading", chatId: "chat-1", spec: title, title, status: "queued",
    createdAt: "2026-11-01T00:00:00.000Z", startedAt: null, finishedAt: null,
    result: null, output: null, exitCode: null, changes: [], unreviewable: [],
    verification: null, review: null, git: null, ...extra,
  };
}

test("engine store: a legacy engine.json imports in order, fields intact, file renamed not deleted", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const done = legacyTask("task-1", "finished run", {
      status: "done", startedAt: "2026-11-01T01:00:00.000Z", finishedAt: "2026-11-01T01:05:00.000Z",
      result: "shipped", output: "engine: work complete", exitCode: 0, changes: ["hello.txt"],
      verification: "verified", review: "PASS: No concerns.",
      git: { mode: "branch", branch: "sam/finished-run-task-1", baseSha: "abc123", commits: [{ sha: "def456", iteration: 1, paths: ["hello.txt"], at: "2026-11-01T01:04:00.000Z" }], pending: [], error: null },
    });
    const queued = legacyTask("task-2", "waiting run");
    writeFileSync(join(sam, ".sam", "engine.json"), JSON.stringify([done, queued], null, 2));
    const items = listEngineTasks(sam);
    assert.deepEqual(items.map(t => t.id), ["task-1", "task-2"]);
    assert.deepEqual(items[0], done);
    assert.deepEqual(items[1], queued);
    assert.equal(existsSync(join(sam, ".sam", "engine.db")), true);
    assert.equal(existsSync(join(sam, ".sam", "engine.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "engine.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(sam, ".sam", "engine.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("engine store: a malformed legacy file imports nothing and is left in place", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "engine.json"), "{ not json");
    assert.deepEqual(listEngineTasks(sam), []);
    assert.equal(existsSync(join(sam, ".sam", "engine.json")), true);
    assert.equal(existsSync(join(sam, ".sam", "engine.json.migrated")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("engine store: a pure read on an empty install creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-engine-store-empty-"));
  try {
    assert.deepEqual(listEngineTasks(root), []);
    assert.equal(getEngineTask(root, "nope"), null);
    assert.equal(updateEngineTask(root, "nope", { status: "done" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine store: interleaved queues and a single-row update all survive (no whole-file lost update)", () => {
  const f = fixture();
  try {
    const a = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Alpha run" });
    const b = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Beta run" });
    const patched = updateEngineTask(f.sam, a.id, { status: "running", startedAt: "2026-11-10T09:00:00.000Z" });
    assert.equal(patched?.status, "running");
    assert.equal(updateEngineTask(f.sam, "ghost", { status: "done" }), null);
    const items = listEngineTasks(f.sam);
    assert.deepEqual(items.map(t => t.id), [a.id, b.id]);
    assert.equal(items[0].status, "running");
    assert.equal(items[1].status, "queued");
    assert.equal(items[1].title, "Beta run");
    assert.equal(getEngineTask(f.sam, b.id)?.spec, "Beta run");
    assert.equal(existsSync(join(f.sam, ".sam", "engine.json")), false);
  } finally { f.cleanup(); }
});

test("engine store: a drain over a migrated legacy task closes it and persists done in the DB", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sam, ".sam", "engine.json"), JSON.stringify([legacyTask("task-9", "legacy run", { chatId: f.chatId, spec: "Look around and change nothing" })], null, 2));
    const out = await drainEngineTasks(f.sam, { runEngine: async () => ({ exitCode: 0, output: "engine: nothing to do" }) });
    assert.deepEqual(out.ran, ["task-9"]);
    const items = listEngineTasks(f.sam);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "done");
    assert.match(items[0].result ?? "", /made no changes/);
    assert.ok(items[0].startedAt && items[0].finishedAt);
    assert.equal(existsSync(join(f.sam, ".sam", "engine.json")), false);
    assert.equal(existsSync(join(f.sam, ".sam", "engine.db")), true);
  } finally { f.cleanup(); }
});

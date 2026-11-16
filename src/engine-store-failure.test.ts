import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { openDatabase } from "./sqlite.js";
import {
  engineStoreFailureSummary, getEngineTask, isEngineStoreLedgered,
  listEngineTasks, queueEngineTask, updateEngineTask,
} from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";
import { classifyDefect } from "./self-work.js";

// Engine store failure visibility (gap found 2026-11-15,
// hourly run 19:04): the engine store (.sam/engine.db) is
// the managed coding-engine queue - listEngineTasks rides
// engineStatus (dashboard status, morning brief, CLI
// overview, self-audit, eval battery); the row writes ride
// the heartbeat drain's transitions, updateEngineTask, the
// ONE gate's engine executor, and the CLI engine verbs -
// and every touch opened it raw: a dead engine.db threw
// into whichever catch wrapped the call, none naming the
// store. Each touch now ledgers ONE engine-store-failed
// line (phase read / write) and rethrows exactly, tagged;
// every caller's handling is unchanged and reads still
// fail closed (never folded as no tasks, which would
// silently empty the managed-run queue dressed as an idle
// engine).
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-store-fail-"));
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
  const base = mkdtempSync(join(tmpdir(), "sam-engine-store-fail-plain-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "engine-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "engine.db"), { force: true });
  mkdirSync(join(root, ".sam", "engine.db"), { recursive: true });
}

test("engine-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(engineStoreFailureSummary("read", "unable to open\n  database   file"), "Engine store read failed: unable to open database file");
  assert.equal(engineStoreFailureSummary("write", "disk gone"), "Engine store write failed: disk gone");
  assert.equal(engineStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "engine-store-failed", summary: engineStoreFailureSummary(phase, "boom") }),
      { key: "engine-store-failed:" + phase, label: "engine store failures (" + phase + " step)" },
    );
  }
});

test("engine-store-failed: a healthy queue, read, and update round trip ledgers no failure line", () => {
  const f = fixture();
  try {
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Fix the secret zorblax widget" });
    assert.equal(listEngineTasks(f.sam).length, 1);
    assert.equal(getEngineTask(f.sam, task.id)?.spec, "Fix the secret zorblax widget");
    const updated = updateEngineTask(f.sam, task.id, { status: "failed", result: "done checking" });
    assert.equal(updated?.status, "failed");
    assert.equal(failedLines(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("engine-store-failed: an absent store reads as no tasks, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(listEngineTasks(sam), []);
    assert.equal(getEngineTask(sam, "nope"), null);
    assert.equal(updateEngineTask(sam, "nope", { status: "failed" }), null);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("engine-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const f = fixture();
  try {
    queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "A real run" });
    const db = openDatabase(join(f.sam, ".sam", "engine.db"));
    try { db.prepare("INSERT INTO engine_tasks (id, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.equal(listEngineTasks(f.sam).length, 1, "the torn row is skipped, the real run still reads");
    assert.equal(failedLines(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("engine-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no task content", () => {
  const f = fixture();
  try {
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Fix the secret zorblax widget" });
    plantDeadStore(f.sam);

    assert.throws(() => listEngineTasks(f.sam), (e: unknown) => isEngineStoreLedgered(e));
    let lines = failedLines(f.sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Engine store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "engine-store-failed:read", label: "engine store failures (read step)" });

    assert.throws(() => getEngineTask(f.sam, task.id), (e: unknown) => isEngineStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Engine store read failed: "), lines[1].summary);

    assert.throws(() => updateEngineTask(f.sam, task.id, { status: "failed" }), (e: unknown) => isEngineStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 3, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Engine store read failed: "), lines[2].summary);

    assert.throws(() => queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Another run" }), (e: unknown) => isEngineStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 4, "a queue on a dead store dies at its read touch with exactly one line");
    assert.ok(lines[3].summary.startsWith("Engine store read failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no task spec ever enters a failure line");
  } finally { f.cleanup(); }
});

test("engine-store-failed: validation errors are not store failures and ledger nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.throws(() => queueEngineTask(sam, { actor: "Bad Actor", chatId: "c1", spec: "x" }), (e: unknown) => /Invalid actor/.test((e as Error).message) && !isEngineStoreLedgered(e));
    assert.throws(() => queueEngineTask(sam, { actor: "trading", chatId: "c1", spec: "  " }), (e: unknown) => /Invalid engine task spec/.test((e as Error).message) && !isEngineStoreLedgered(e));
    assert.throws(() => queueEngineTask(sam, { actor: "trading", chatId: "", spec: "x" }), (e: unknown) => /A chat is required/.test((e as Error).message) && !isEngineStoreLedgered(e));
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "engine.db")), false, "no validation refusal created the store");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("engine-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const f = fixture();
  try {
    queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "First run" });
    const raw = openDatabase(join(f.sam, ".sam", "engine.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON engine_tasks BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Second run" }), (e: unknown) => isEngineStoreLedgered(e));
    const lines = failedLines(f.sam);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Engine store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "engine-store-failed:write", label: "engine store failures (write step)" });
  } finally { f.cleanup(); }
});

test("engine-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const f = fixture();
  try {
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Fix the secret zorblax widget" });
    const raw = openDatabase(join(f.sam, ".sam", "engine.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON engine_tasks BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateEngineTask(f.sam, task.id, { status: "failed" }), (e: unknown) => isEngineStoreLedgered(e));
    const lines = failedLines(f.sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Engine store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no task spec ever enters a failure line");
  } finally { f.cleanup(); }
});

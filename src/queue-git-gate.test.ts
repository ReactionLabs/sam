import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { listCodingTasks, queueCodingTask } from "./coding.js";
import { listEngineTasks, queueEngineTask, validateEngineDetail } from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";
import { readActivity } from "./activity.js";

// The queue-time git gate for the two remaining queue doors: the
// 06:04 self-work gate read codeRootGitBlocker before minting a
// doomed task, but queueCodingTask (the sam_coding_task chat
// tool and the coding queue CLI) and validateEngineDetail (the
// ONE gate's engine kind, whose header promises a card that
// cannot execute is never shown) still checked only the code
// root's presence / repo-rootedness. Live evidence (2026-11-24):
// /opt/sam/code sits dirty on a self-work branch, so either door
// would mint work whose only drain outcome is the identical
// git-discipline block. Fixtures use REAL git in temp dirs.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture(opts: { commit?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "sam-queue-gitgate-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const binDir = join(base, "bin");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "true", test: "true" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  git(proj, "init", "-q");
  if (opts.commit !== false) {
    git(proj, "add", "package.json", "tracked.txt");
    git(proj, "commit", "-q", "-m", "initial");
  }
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

test("coding queue: a dirty git code root refuses before creating anything, in the probe's own words", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proj, "tracked.txt"), "owner work in progress\n");
    assert.throws(() => queueCodingTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add a hello file" }), /uncommitted changes that are not this task's/);
    assert.deepEqual(listCodingTasks(f.sam), []);
    assert.equal(readActivity(f.sam).some(a => a.kind === "coding-queued"), false);
    // The gate is a read, not a latch: clean the tree and the
    // same spec queues.
    git(f.proj, "checkout", "--", "tracked.txt");
    const task = queueCodingTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add a hello file" });
    assert.equal(task.status, "queued");
    assert.equal(listCodingTasks(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("coding queue: an unborn git code root refuses with the no-commits reason and queues nothing", () => {
  const f = fixture({ commit: false });
  try {
    assert.throws(() => queueCodingTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add a hello file" }), /no commits yet/);
    assert.deepEqual(listCodingTasks(f.sam), []);
  } finally { f.cleanup(); }
});

test("coding queue: an untracked scratch file alone is enough to refuse", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proj, "scratch.py"), "# debris\n");
    assert.throws(() => queueCodingTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add a hello file" }), /uncommitted changes/);
    assert.deepEqual(listCodingTasks(f.sam), []);
  } finally { f.cleanup(); }
});

test("engine gate: validateEngineDetail refuses a dirty tree, so no card is shown and no run queues", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proj, "tracked.txt"), "owner work in progress\n");
    assert.throws(() => validateEngineDetail(f.sam, JSON.stringify({ task: "Do the thing" })), /uncommitted changes that are not this task's/);
    assert.throws(() => queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Do the thing" }), /uncommitted changes/);
    assert.deepEqual(listEngineTasks(f.sam), []);
    assert.equal(readActivity(f.sam).some(a => a.kind === "engine-queued"), false);
    git(f.proj, "checkout", "--", "tracked.txt");
    const ok = validateEngineDetail(f.sam, JSON.stringify({ task: "Do the thing" }));
    assert.equal(ok.task, "Do the thing");
    const run = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Do the thing" });
    assert.equal(run.status, "queued");
    assert.equal(listEngineTasks(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("engine gate: an unborn git code root refuses validation with the no-commits reason", () => {
  const f = fixture({ commit: false });
  try {
    assert.throws(() => validateEngineDetail(f.sam, JSON.stringify({ task: "Do the thing" })), /no commits yet/);
    assert.deepEqual(listEngineTasks(f.sam), []);
  } finally { f.cleanup(); }
});

test("both doors: the queue-time refusal text is byte-identical to the drain's block reason", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proj, "tracked.txt"), "changed\n");
    let codingErr = "";
    try { queueCodingTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add a hello file" }); } catch (e) { codingErr = (e as Error).message; }
    let engineErr = "";
    try { validateEngineDetail(f.sam, JSON.stringify({ task: "Do the thing" })); } catch (e) { engineErr = (e as Error).message; }
    assert.ok(codingErr.length > 0);
    assert.equal(engineErr, codingErr);
  } finally { f.cleanup(); }
});

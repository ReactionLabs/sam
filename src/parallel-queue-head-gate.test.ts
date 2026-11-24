import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { readActivity } from "./activity.js";
import { listParallelJobs, parallelNoCommitsReason, queueParallelJob, surveyRepo } from "./parallel-coding.js";

// The queue-time unborn-HEAD gate for parallel jobs: the queue
// checked that the code root is a git repository rooted at
// itself, but not that the repository has a HEAD - while the
// drain's survey refuses a commit-less repo deterministically
// (no base for any slice worktree to branch from). A job queued
// into that state could only close blocked. The queue now reads
// the precondition first, in the survey's own words (the ONE
// source). A dirty tree is deliberately NOT gated here: slices
// branch from HEAD into their own worktrees, so uncommitted
// owner work never blocks a parallel job the way it blocks the
// coding and engine loops. Fixtures use REAL git in temp dirs.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-headgate-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "shared.txt"), "base\n");
  git(proj, "init", "-q");
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  return {
    base, sam, proj, chatId,
    env: { SAM_ENGINE_BIN: process.execPath } as NodeJS.ProcessEnv,
    cleanup() { rmSync(base, { recursive: true, force: true }); },
  };
}

const SPEC = { actor: "sam", spec: "Build the fixture feature in parallel slices.", slices: [{ name: "one", task: "WRITE a.txt :: a" }] };

test("parallel queue: an unborn git code root refuses before creating anything, in the survey's own words", () => {
  const f = fixture();
  try {
    let queueErr = "";
    try { queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, f.env); } catch (e) { queueErr = (e as Error).message; }
    assert.equal(queueErr, parallelNoCommitsReason());
    assert.deepEqual(listParallelJobs(f.sam), []);
    assert.equal(readActivity(f.sam).some(a => a.kind === "parallel-queued"), false);
    // Byte-identical to the drain seam's refusal: the survey
    // throws the same ONE-source text.
    let surveyErr = "";
    try { surveyRepo(f.sam); } catch (e) { surveyErr = (e as Error).message; }
    assert.equal(surveyErr, queueErr);
    // The gate is a read, not a latch: make the first commit and
    // the same spec queues.
    git(f.proj, "add", "package.json", "shared.txt");
    git(f.proj, "commit", "-q", "-m", "initial");
    const job = queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, f.env);
    assert.equal(job.status, "queued");
    assert.equal(listParallelJobs(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("parallel queue: the unborn refusal fires before the engine check - the deterministic precondition is named first", () => {
  const f = fixture();
  try {
    // No engine binary resolvable at all: the queue still names
    // the git precondition, not the missing engine, because the
    // HEAD check rides ahead of the provider check.
    assert.throws(() => queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, {} as NodeJS.ProcessEnv), (e: unknown) => (e as Error).message === parallelNoCommitsReason());
    assert.deepEqual(listParallelJobs(f.sam), []);
  } finally { f.cleanup(); }
});

test("parallel queue: a non-git code root keeps its own refusal, not the no-commits one", () => {
  const f = fixture();
  try {
    rmSync(join(f.proj, ".git"), { recursive: true, force: true });
    assert.throws(() => queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, f.env), /not a git repository rooted at itself/);
    assert.deepEqual(listParallelJobs(f.sam), []);
  } finally { f.cleanup(); }
});

test("parallel queue: after the first commit the engine check still binds - the gate adds a precondition, it does not mask the next one", () => {
  const f = fixture();
  try {
    git(f.proj, "add", "package.json", "shared.txt");
    git(f.proj, "commit", "-q", "-m", "initial");
    assert.throws(() => queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, { PATH: "/nonexistent-sam-headgate" } as NodeJS.ProcessEnv), /not installed on this machine/);
    assert.deepEqual(listParallelJobs(f.sam), []);
  } finally { f.cleanup(); }
});

test("parallel queue: a dirty tree still queues - slices branch from HEAD, not from the working tree", () => {
  const f = fixture();
  try {
    git(f.proj, "add", "package.json", "shared.txt");
    git(f.proj, "commit", "-q", "-m", "initial");
    writeFileSync(join(f.proj, "shared.txt"), "owner work in progress\n");
    writeFileSync(join(f.proj, "scratch.py"), "# debris\n");
    const job = queueParallelJob(f.sam, { ...SPEC, chatId: f.chatId }, f.env);
    assert.equal(job.status, "queued");
    assert.equal(listParallelJobs(f.sam).length, 1);
  } finally { f.cleanup(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { setCodeRoot } from "./code.js";
import { listCodingTasks } from "./coding.js";
import { codeRootGitBlocker, prepareTaskBranch } from "./git-work.js";
import { runSelfAudit } from "./self-audit.js";
import { advanceSelfWork, listSelfWorkFixes, queueSelfWorkFix, runSelfWork } from "./self-work.js";

// The self-work queue-time git gate: the coding runner refuses a
// git code root whose tree is dirty (or has no commits yet) at
// task start, deterministically - so the work bridge reads that
// precondition BEFORE creating anything. Live evidence
// (2026-11-22/23): the daily loop queued a fresh coding task
// into a dirty /opt/sam/code two days running; each started and
// closed coding-blocked (git discipline) within a second, and
// the run reported churn instead of the one precondition the
// owner can clear. Fixtures use REAL git in temp dirs, like
// git-work.test.ts - the discipline is git's behavior.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-sw-gitgate-")); }

function gitCodeRoot(commit: boolean): string {
  const dir = fresh();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
  writeFileSync(join(dir, "tracked.txt"), "original\n");
  git(dir, "init", "-q");
  if (commit) {
    git(dir, "add", "package.json", "tracked.txt");
    git(dir, "commit", "-q", "-m", "initial");
  }
  return dir;
}

function workableRoot(codeRootDir: string): string {
  const root = fresh();
  recordActivity(root, "trading", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_load_tools); not executed: mcp_stack_health");
  recordActivity(root, "trading", "tool-budget", "Turn step limit reached: 1 calls used (sam_load_tools) - the call budget (4) was NOT reached");
  recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 5/6 calls used (sam_read_skill)");
  setCodeRoot(root, codeRootDir);
  runSelfAudit(root, {});
  runSelfWork(root);
  return root;
}

test("codeRootGitBlocker: a non-git code root and a clean git root read no blocker", () => {
  const plain = fresh();
  const rootA = fresh();
  try {
    writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "x" }));
    setCodeRoot(rootA, plain);
    assert.equal(codeRootGitBlocker(rootA), null);
  } finally { rmSync(plain, { recursive: true, force: true }); rmSync(rootA, { recursive: true, force: true }); }
  const clean = gitCodeRoot(true);
  const rootB = fresh();
  try {
    setCodeRoot(rootB, clean);
    assert.equal(codeRootGitBlocker(rootB), null);
    // The probe is a pure read: the tree stays on its own branch,
    // untouched, with no sam/<task> branch created.
    assert.equal(git(clean, "branch", "--list", "sam/*"), "");
    assert.equal(git(clean, "status", "--porcelain"), "");
  } finally { rmSync(clean, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); }
});

test("codeRootGitBlocker: a dirty tree, an untracked file, and an unborn HEAD each name the runner's refusal", () => {
  const dirty = gitCodeRoot(true);
  const rootA = fresh();
  try {
    setCodeRoot(rootA, dirty);
    writeFileSync(join(dirty, "tracked.txt"), "changed\n");
    assert.match(codeRootGitBlocker(rootA) ?? "", /uncommitted changes that are not this task's/);
    git(dirty, "checkout", "--", "tracked.txt");
    assert.equal(codeRootGitBlocker(rootA), null);
    writeFileSync(join(dirty, "scratch.py"), "# debris\n");
    assert.match(codeRootGitBlocker(rootA) ?? "", /uncommitted changes/);
  } finally { rmSync(dirty, { recursive: true, force: true }); rmSync(rootA, { recursive: true, force: true }); }
  const unborn = gitCodeRoot(false);
  const rootB = fresh();
  try {
    setCodeRoot(rootB, unborn);
    assert.match(codeRootGitBlocker(rootB) ?? "", /no commits yet/);
  } finally { rmSync(unborn, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); }
});

test("codeRootGitBlocker: the probe's refusal text is byte-identical to prepareTaskBranch's block reason", () => {
  const dirty = gitCodeRoot(true);
  const root = fresh();
  try {
    setCodeRoot(root, dirty);
    writeFileSync(join(dirty, "tracked.txt"), "changed\n");
    const probe = codeRootGitBlocker(root);
    const state = prepareTaskBranch(root, { id: "aaaaaaaa-1", title: "Anything" });
    assert.equal(state.mode, "refused");
    assert.equal(state.error, probe);
  } finally { rmSync(dirty, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("self-work queue: a dirty git code root refuses before creating anything, and the advance note names the precondition", () => {
  const codeRootDir = gitCodeRoot(true);
  const root = workableRoot(codeRootDir);
  try {
    writeFileSync(join(codeRootDir, "tracked.txt"), "owner work in progress\n");
    assert.throws(() => queueSelfWorkFix(root), /cannot queue yet: The code root's working tree has uncommitted changes/);
    assert.deepEqual(listCodingTasks(root), []);
    assert.deepEqual(listSelfWorkFixes(root), []);
    const adv = advanceSelfWork(root);
    assert.equal(adv.queued, null);
    assert.match(adv.queueNote ?? "", /cannot queue yet/);
    assert.match(adv.queueNote ?? "", /Commit or stash them outside SAM/);
    assert.deepEqual(listCodingTasks(root), []);
    // The day the tree is cleaned, the same spec queues with no
    // further change - the gate is a read, not a latch.
    git(codeRootDir, "checkout", "--", "tracked.txt");
    const fix = queueSelfWorkFix(root);
    assert.equal(fix.defectKey, "tool-budget");
    assert.equal(listCodingTasks(root).length, 1);
  } finally { rmSync(codeRootDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("self-work queue: an unborn git code root refuses with the no-commits reason and queues nothing", () => {
  const codeRootDir = gitCodeRoot(false);
  const root = workableRoot(codeRootDir);
  try {
    assert.throws(() => queueSelfWorkFix(root), /cannot queue yet: .*no commits yet/);
    assert.deepEqual(listCodingTasks(root), []);
    assert.deepEqual(listSelfWorkFixes(root), []);
  } finally { rmSync(codeRootDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("self-work queue: a clean git code root queues exactly as a non-git root does", () => {
  const codeRootDir = gitCodeRoot(true);
  const root = workableRoot(codeRootDir);
  try {
    const fix = queueSelfWorkFix(root);
    assert.equal(fix.defectKey, "tool-budget");
    const tasks = listCodingTasks(root);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "queued");
  } finally { rmSync(codeRootDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

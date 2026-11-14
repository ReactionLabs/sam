import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { isTaskBranch } from "./git-work.js";
import type { EngineRunner } from "./engine.js";
import { runGoldfishDiffReview, type GoldfishRecord } from "./goldfish.js";
import { drainParallelJobs, getParallelJob, listParallelJobs, parallelSummaryText, queueParallelJob, surveyRepo } from "./parallel-coding.js";

// Program E: parallel coding. Fixtures use REAL git and an
// injected fake engine runner that performs WRITE directives
// parsed from the prompt it is handed, so the survey, the
// worktree isolation, the concurrent fan-out, the coordinator
// merge, the battery, and the close rules are all exercised as
// behavior. The production drain spawns the real engine binary
// through the same runner seam.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

const PASS_REVIEW: GoldfishRecord = { verdict: "PASS", summary: "clean", findings: [], at: new Date().toISOString(), spec: "s", model: "stub", changeCount: 1, changeHashes: [], malformed: false };
const BLOCK_REVIEW: GoldfishRecord = { verdict: "BLOCK", summary: "no", findings: [{ severity: "BLOCKER", detail: "bad", evidence: "diff", patternId: null }], at: new Date().toISOString(), spec: "s", model: "stub", changeCount: 1, changeHashes: [], malformed: false };

function fixture(opts: { gitInit?: boolean; testScript?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: opts.testScript ?? "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "shared.txt"), "base\n");
  writeFileSync(join(proj, "README.md"), "# proj\n");
  if (opts.gitInit !== false) {
    git(proj, "init", "-q");
    git(proj, "add", "package.json", "shared.txt", "README.md");
    git(proj, "commit", "-q", "-m", "initial");
  }
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

/** The fake engine: obeys directives embedded in the prompt text.
 *  WRITE <path> :: <content> writes a file; SLEEP <ms> delays;
 *  FAILALWAYS exits 1; FLAKY fails once per worktree, then works;
 *  a coordinator fix-iteration prompt writes the fix file. */
function directiveEngine(): EngineRunner {
  return async (_binary, args, cwd) => {
    const prompt = args.join("\n");
    const sleep = /SLEEP (\d+)/.exec(prompt);
    if (sleep) await new Promise(r => setTimeout(r, parseInt(sleep[1], 10)));
    if (prompt.includes("FAILALWAYS")) return { exitCode: 1, output: "always fails" };
    if (prompt.includes("FLAKY")) {
      const marker = join(cwd, ".flaky-attempted");
      if (!existsSync(marker)) { writeFileSync(marker, "1"); return { exitCode: 1, output: "first attempt fails" }; }
    }
    if (prompt.includes("fix iteration")) writeFileSync(join(cwd, "fix.txt"), "fixed\n");
    for (const m of prompt.matchAll(/WRITE (\S+) :: ([^\n]*)/g)) {
      const target = join(cwd, m[1]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, m[2] + "\n");
    }
    return { exitCode: 0, output: "engine ok" };
  };
}

function queueSpec(f: ReturnType<typeof fixture>, slices: Array<{ name: string; task: string; files?: string[] }>, extra: { concurrency?: number; spec?: string } = {}) {
  return queueParallelJob(f.sam, {
    actor: "sam", chatId: f.chatId,
    spec: extra.spec ?? "Build the fixture feature in parallel slices.",
    slices, concurrency: extra.concurrency,
  }, f.env);
}

test("queue validation: fences refuse cleanly", () => {
  const f = fixture();
  try {
    assert.throws(() => queueParallelJob(f.sam, { actor: "sam", chatId: f.chatId, spec: "x", slices: [] }, f.env), /1 to 24 slices/);
    assert.throws(() => queueParallelJob(f.sam, { actor: "sam", chatId: f.chatId, spec: "x", slices: [{ name: "Bad Name", task: "t" }] }, f.env), /Invalid slice name/);
    assert.throws(() => queueParallelJob(f.sam, { actor: "sam", chatId: f.chatId, spec: "x", slices: [{ name: "a", task: "t" }, { name: "a", task: "t" }] }, f.env), /Duplicate slice name/);
    const job = queueSpec(f, [{ name: "one", task: "WRITE a.txt :: a" }]);
    assert.equal(job.status, "queued");
    assert.equal(job.provider, "claude-code");
    assert.ok(isTaskBranch(job.branch as string), "job branch passes the git-push gate shape: " + job.branch);
    for (const s of job.slices) assert.ok(isTaskBranch(s.branch), "slice branch passes the shape: " + s.branch);
  } finally { f.cleanup(); }
});

test("queue validation: a non-git code root refuses", () => {
  const f = fixture({ gitInit: false });
  try {
    assert.throws(() => queueSpec(f, [{ name: "one", task: "WRITE a.txt :: a" }]), /not a git repository/);
  } finally { f.cleanup(); }
});

test("survey: the read slices are cut against", () => {
  const f = fixture();
  try {
    const survey = surveyRepo(f.sam);
    assert.equal(survey.fileCount, 3);
    assert.deepEqual(survey.keyFiles, ["package.json", "README.md"]);
    assert.equal(survey.scripts.build, "node -e \"process.exit(0)\"");
    assert.equal(survey.byExtension.txt, 1);
    assert.equal(survey.filesTruncated, false);
  } finally { f.cleanup(); }
});

test("fan-out: six slices land, merge, verify, and close done with one consolidated summary", async () => {
  const f = fixture();
  try {
    const branchBefore = git(f.proj, "branch", "--show-current");
    const job = queueSpec(f, [1, 2, 3, 4, 5, 6].map(n => ({ name: "s" + n, task: "WRITE mod" + n + ".txt :: content " + n, files: ["mod" + n + ".txt"] })), { concurrency: 3 });
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), reviewDiff: async () => PASS_REVIEW, env: f.env });
    assert.deepEqual(result.ran, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.slices.every(s => s.status === "done"), true);
    assert.deepEqual(done.filesTouched, ["mod1.txt", "mod2.txt", "mod3.txt", "mod4.txt", "mod5.txt", "mod6.txt"]);
    assert.ok(done.survey && done.survey.fileCount === 3, "survey recorded on the job");
    assert.match(done.verification ?? "", /build: pass, test: pass/);
    assert.match(done.review ?? "", /^PASS:/);
    // The merged tree on the job branch carries every slice's file.
    const tree = git(f.proj, "ls-tree", "-r", "--name-only", done.branch as string).split("\n");
    for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(tree.includes("mod" + n + ".txt"), "mod" + n + ".txt on the job branch");
    // The code root's own checkout was never moved.
    assert.equal(git(f.proj, "branch", "--show-current"), branchBefore);
    // Worktrees are cleaned up; branches remain.
    assert.equal(existsSync(join(f.sam, ".sam", "parallel", job.id, "s1")), false);
    const branches = git(f.proj, "branch", "--list", "sam/par-*").split("\n").map(s => s.trim().replace(/^\* /, ""));
    assert.ok(branches.includes(done.branch as string));
    // The summary posted to the chat names the outcome and the files.
    const summary = parallelSummaryText(done);
    assert.match(summary, /Parallel job done/);
    assert.match(summary, /Files touched \(6\)/);
  } finally { f.cleanup(); }
});

test("the named bar: 20 files in one fan-out", async () => {
  const f = fixture();
  try {
    const slices = Array.from({ length: 10 }, (_, i) => ({
      name: "part" + (i + 1),
      task: "WRITE src/part" + (i + 1) + "a.txt :: a" + (i + 1) + "\nWRITE src/part" + (i + 1) + "b.txt :: b" + (i + 1),
      files: ["src/part" + (i + 1) + "a.txt", "src/part" + (i + 1) + "b.txt"],
    }));
    const job = queueSpec(f, slices, { concurrency: 5 });
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    assert.deepEqual(result.ran, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.filesTouched.length, 20);
    assert.equal(done.review, null, "no reviewer wired on this drain: the record says so");
  } finally { f.cleanup(); }
});

test("parallel beats serial on the same job shape", async () => {
  const f = fixture();
  try {
    const mk = () => [1, 2, 3, 4, 5, 6].map(n => ({ name: "w" + n, task: "SLEEP 200\nWRITE w" + n + ".txt :: x" }));
    const serial = queueSpec(f, mk(), { concurrency: 1 });
    const t0 = Date.now();
    await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    const serialMs = Date.now() - t0;
    const parallel = queueSpec(f, mk(), { concurrency: 3 });
    const t1 = Date.now();
    await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    const parallelMs = Date.now() - t1;
    assert.equal(getParallelJob(f.sam, serial.id)?.status, "done");
    assert.equal(getParallelJob(f.sam, parallel.id)?.status, "done");
    assert.ok(parallelMs < serialMs * 0.7, "parallel " + parallelMs + "ms should be well under serial " + serialMs + "ms");
  } finally { f.cleanup(); }
});

test("a failed slice is retried once, then reported by name; the job blocks and the finished slices still merge", async () => {
  const f = fixture();
  try {
    const job = queueSpec(f, [
      { name: "good", task: "WRITE good.txt :: good" },
      { name: "bad", task: "FAILALWAYS WRITE bad.txt :: bad" },
    ]);
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    assert.deepEqual(result.blocked, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.ok(done);
    assert.equal(done.status, "blocked");
    const bad = done.slices.find(s => s.name === "bad");
    assert.equal(bad?.status, "failed");
    assert.equal(bad?.attempts, 2, "one retry within budget");
    assert.match(done.result ?? "", /bad/);
    const tree = git(f.proj, "ls-tree", "-r", "--name-only", done.branch as string).split("\n");
    assert.ok(tree.includes("good.txt"), "the finished slice's work is on the job branch for inspection");
  } finally { f.cleanup(); }
});

test("a flaky slice recovers on its retry and the job closes done", async () => {
  const f = fixture();
  try {
    const job = queueSpec(f, [{ name: "flaky", task: "FLAKY\nWRITE flaky.txt :: recovered" }]);
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    assert.deepEqual(result.ran, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.equal(done?.slices[0].attempts, 2);
    assert.equal(done?.slices[0].status, "done");
  } finally { f.cleanup(); }
});

test("a merge conflict is reported by name with its files; the job blocks", async () => {
  const f = fixture();
  try {
    const job = queueSpec(f, [
      { name: "alpha", task: "WRITE shared.txt :: alpha version" },
      { name: "beta", task: "WRITE shared.txt :: beta version" },
    ]);
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: f.env });
    assert.deepEqual(result.blocked, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.ok(done);
    const beta = done.slices.find(s => s.name === "beta");
    assert.equal(beta?.status, "conflicted");
    assert.match(beta?.error ?? "", /shared\.txt/);
    assert.deepEqual(done.merges.find(m => m.slice === "beta")?.conflicts, ["shared.txt"]);
    assert.match(done.result ?? "", /beta/);
  } finally { f.cleanup(); }
});

test("a red merged battery feeds a fix iteration and closes done when it greens", async () => {
  const f = fixture({ testScript: "node -e \"const fs=require('fs');process.exit(fs.existsSync('fix.txt')&&fs.readFileSync('fix.txt','utf8').includes('fixed')?0:1)\"" });
  try {
    const job = queueSpec(f, [{ name: "only", task: "WRITE only.txt :: only" }]);
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), reviewDiff: async () => PASS_REVIEW, env: f.env });
    assert.deepEqual(result.ran, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.ok(done);
    assert.equal(done.verifyIterations.length, 1);
    assert.equal(done.verifyIterations[0].testOk, true);
    assert.ok(done.filesTouched.includes("fix.txt"), "the fix iteration's file is on the record");
  } finally { f.cleanup(); }
});

test("a review BLOCK closes the job blocked even on a green battery", async () => {
  const f = fixture();
  try {
    const job = queueSpec(f, [{ name: "one", task: "WRITE a.txt :: a" }]);
    const result = await drainParallelJobs(f.sam, { runEngine: directiveEngine(), reviewDiff: async () => BLOCK_REVIEW, env: f.env });
    assert.deepEqual(result.blocked, [job.id]);
    const done = getParallelJob(f.sam, job.id);
    assert.match(done?.result ?? "", /BLOCKED/);
    assert.match(done?.review ?? "", /^BLOCK:/);
  } finally { f.cleanup(); }
});

test("the store: a pure read on a fresh install creates nothing, and jobs list in queue order", () => {
  const f = fixture();
  try {
    assert.deepEqual(listParallelJobs(f.sam), []);
    assert.equal(existsSync(join(f.sam, ".sam", "parallel.db")), false);
    const a = queueSpec(f, [{ name: "one", task: "WRITE a.txt :: a" }]);
    const b = queueSpec(f, [{ name: "two", task: "WRITE b.txt :: b" }]);
    assert.deepEqual(listParallelJobs(f.sam).map(j => j.id), [a.id, b.id]);
  } finally { f.cleanup(); }
});

test("goldfish diff review: explicit diffs, fresh context, fail-closed on malformed output", async () => {
  const f = fixture();
  try {
    const passProvider = { complete: async () => ({ message: { content: JSON.stringify({ verdict: "PASS", summary: "fine", findings: [] }) } }) };
    const record = await runGoldfishDiffReview(f.sam, "spec", [{ path: "a.txt", replacementHash: "abc", diff: "+hello" }], "stub", passProvider as never);
    assert.equal(record.verdict, "PASS");
    assert.equal(record.changeCount, 1);
    assert.deepEqual(record.changeHashes, ["abc"]);
    const junkProvider = { complete: async () => ({ message: { content: "not json" } }) };
    const blocked = await runGoldfishDiffReview(f.sam, "spec", [{ path: "a.txt", replacementHash: "abc", diff: "+hello" }], "stub", junkProvider as never);
    assert.equal(blocked.verdict, "BLOCK");
    assert.equal(blocked.malformed, true);
    await assert.rejects(
      () => runGoldfishDiffReview(f.sam, "spec", [{ path: "a.txt", replacementHash: "abc", diff: "x".repeat(25_000) }], "stub", passProvider as never),
      /Diff truncated/);
  } finally { f.cleanup(); }
});

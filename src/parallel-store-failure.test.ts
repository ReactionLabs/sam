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
  getParallelJob, isParallelStoreLedgered, listParallelJobs,
  parallelStoreFailureSummary, queueParallelJob, updateParallelJob,
} from "./parallel-coding.js";
import { classifyDefect } from "./self-work.js";

// Parallel store failure visibility (gap found 2026-11-15,
// hourly run 20:04): the parallel store (.sam/parallel.db)
// is the parallel coding queue - listParallelJobs rides
// parallelSummary (dashboard status, CLI overview) and
// the heartbeat drain; the row writes ride the drain's
// transitions, updateParallelJob, proposeParallelPush,
// and the CLI parallel verbs - and every touch opened it
// raw: a dead parallel.db threw into whichever catch
// wrapped the call, none naming the store. Each touch
// now ledgers ONE parallel-store-failed line (phase
// read / write) and rethrows exactly, tagged; every
// caller's handling is unchanged and reads still fail
// closed (never folded as no jobs, which would silently
// empty the parallel queue dressed as an idle install).
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-store-fail-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  git(proj, "init", "-q");
  git(proj, "add", "package.json", "tracked.txt");
  git(proj, "commit", "-q", "-m", "initial");
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

function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-store-fail-plain-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "parallel-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "parallel.db"), { force: true });
  mkdirSync(join(root, ".sam", "parallel.db"), { recursive: true });
}

function queueOne(f: ReturnType<typeof fixture>, spec = "Fix the secret zorblax widget") {
  return queueParallelJob(f.sam, {
    actor: "sam", chatId: f.chatId, spec,
    slices: [{ name: "one", task: "WRITE a.txt :: a" }],
  }, f.env);
}

test("parallel-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(parallelStoreFailureSummary("read", "unable to open\n  database   file"), "Parallel store read failed: unable to open database file");
  assert.equal(parallelStoreFailureSummary("write", "disk gone"), "Parallel store write failed: disk gone");
  assert.equal(parallelStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "parallel-store-failed", summary: parallelStoreFailureSummary(phase, "boom") }),
      { key: "parallel-store-failed:" + phase, label: "parallel store failures (" + phase + " step)" },
    );
  }
});

test("parallel-store-failed: a healthy queue, read, and update round trip ledgers no failure line", () => {
  const f = fixture();
  try {
    const job = queueOne(f);
    assert.equal(listParallelJobs(f.sam).length, 1);
    assert.equal(getParallelJob(f.sam, job.id)?.spec, "Fix the secret zorblax widget");
    const updated = updateParallelJob(f.sam, job.id, { status: "failed", result: "done checking" });
    assert.equal(updated?.status, "failed");
    assert.equal(failedLines(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("parallel-store-failed: an absent store reads as no jobs, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(listParallelJobs(sam), []);
    assert.equal(getParallelJob(sam, "nope"), null);
    assert.equal(updateParallelJob(sam, "nope", { status: "failed" }), null);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("parallel-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const f = fixture();
  try {
    queueOne(f, "A real job");
    const db = openDatabase(join(f.sam, ".sam", "parallel.db"));
    try { db.prepare("INSERT INTO parallel_jobs (id, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.equal(listParallelJobs(f.sam).length, 1, "the torn row is skipped, the real job still reads");
    assert.equal(failedLines(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("parallel-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no job content", () => {
  const f = fixture();
  try {
    const job = queueOne(f);
    plantDeadStore(f.sam);

    assert.throws(() => listParallelJobs(f.sam), (e: unknown) => isParallelStoreLedgered(e));
    let lines = failedLines(f.sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Parallel store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "parallel-store-failed:read", label: "parallel store failures (read step)" });

    assert.throws(() => getParallelJob(f.sam, job.id), (e: unknown) => isParallelStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Parallel store read failed: "), lines[1].summary);

    assert.throws(() => updateParallelJob(f.sam, job.id, { status: "failed" }), (e: unknown) => isParallelStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 3, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Parallel store read failed: "), lines[2].summary);

    assert.throws(() => queueOne(f, "Another job"), (e: unknown) => isParallelStoreLedgered(e));
    lines = failedLines(f.sam);
    assert.equal(lines.length, 4, "a queue on a dead store dies at its read touch with exactly one line");
    assert.ok(lines[3].summary.startsWith("Parallel store read failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no job spec ever enters a failure line");
  } finally { f.cleanup(); }
});

test("parallel-store-failed: validation errors are not store failures and ledger nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.throws(() => queueParallelJob(sam, { actor: "Bad Actor", chatId: "c1", spec: "x", slices: [{ name: "one", task: "t" }] }), (e: unknown) => /Invalid actor/.test((e as Error).message) && !isParallelStoreLedgered(e));
    assert.throws(() => queueParallelJob(sam, { actor: "sam", chatId: "c1", spec: "  ", slices: [{ name: "one", task: "t" }] }), (e: unknown) => /Invalid parallel job spec/.test((e as Error).message) && !isParallelStoreLedgered(e));
    assert.throws(() => queueParallelJob(sam, { actor: "sam", chatId: "", spec: "x", slices: [{ name: "one", task: "t" }] }), (e: unknown) => /A chat is required/.test((e as Error).message) && !isParallelStoreLedgered(e));
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "parallel.db")), false, "no validation refusal created the store");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("parallel-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const f = fixture();
  try {
    queueOne(f, "First job");
    const raw = openDatabase(join(f.sam, ".sam", "parallel.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON parallel_jobs BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => queueOne(f, "Second job"), (e: unknown) => isParallelStoreLedgered(e));
    const lines = failedLines(f.sam);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Parallel store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "parallel-store-failed:write", label: "parallel store failures (write step)" });
  } finally { f.cleanup(); }
});

test("parallel-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const f = fixture();
  try {
    const job = queueOne(f);
    const raw = openDatabase(join(f.sam, ".sam", "parallel.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON parallel_jobs BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateParallelJob(f.sam, job.id, { status: "failed" }), (e: unknown) => isParallelStoreLedgered(e));
    const lines = failedLines(f.sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Parallel store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no job spec ever enters a failure line");
  } finally { f.cleanup(); }
});

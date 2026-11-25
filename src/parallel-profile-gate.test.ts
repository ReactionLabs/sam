import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { listParallelJobs, parallelProfileBlocker, queueParallelJob } from "./parallel-coding.js";

// The profile gate for the parallel queue door: every
// profile-naming creation door and the background, coding,
// and engine queue doors read the profile registry before
// creating anything, but CLI `parallel queue --actor`
// passed the raw actor into queueParallelJob, which checks
// only the name's shape - minting a queued parallel job
// bound to nobody: the record sits in the queue under an
// actor that is no profile, its ledger line carries that
// same phantom actor, and the job's slices and merged work
// are accounted to a profile that resolves no registered
// profile. parallelProfileBlocker is now the ONE source
// carrying the refusal text: the queue door throws it
// before queuing anything. queueParallelJob itself stays
// permissive by design (a profile removed after a job
// names it leaves the record with its stored actor, and
// the sam_parallel_task chat tool names its actor by
// construction - the speaking chat's own profile), so it
// is NOT gated here.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-profile-gate-"));
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
  try { chatId = db.create("Desk", null).id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  return {
    base, sam, proj, chatId,
    env: { SAM_ENGINE_BIN: process.execPath } as NodeJS.ProcessEnv,
    cleanup() { rmSync(base, { recursive: true, force: true }); },
  };
}

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("parallel profile gate: sam and a registered profile read no blocker", () => {
  const f = fixture();
  try {
    assert.equal(parallelProfileBlocker(f.sam, "sam"), null);
    register(f.sam, "second-shift");
    assert.equal(parallelProfileBlocker(f.sam, "second-shift"), null);
  } finally { f.cleanup(); }
});

test("parallel profile gate: an unknown profile names the registry and the fold correction", () => {
  const f = fixture();
  try {
    assert.equal(
      parallelProfileBlocker(f.sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in parallel detail. Valid profiles: sam",
    );
    register(f.sam, "second-shift");
    assert.equal(
      parallelProfileBlocker(f.sam, "Second Shift"),
      "Unknown profile \"Second Shift\" in parallel detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      parallelProfileBlocker(f.sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in parallel detail. Valid profiles: sam, second-shift",
    );
  } finally { f.cleanup(); }
});

test("parallel profile gate: the door's check queues nothing for a bogus profile", () => {
  const f = fixture();
  try {
    const blocker = parallelProfileBlocker(f.sam, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // queueParallelJob; pin that the check alone leaves
    // no job behind.
    assert.equal(listParallelJobs(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("parallel profile gate: a registered profile passes the check and the job is queued bound to it", () => {
  const f = fixture();
  try {
    register(f.sam, "second-shift");
    assert.equal(parallelProfileBlocker(f.sam, "second-shift"), null);
    const job = queueParallelJob(f.sam, { actor: "second-shift", chatId: f.chatId, spec: "Build the fixture feature", slices: [{ name: "one", task: "WRITE a.txt :: a" }] }, f.env);
    assert.equal(job.actor, "second-shift");
    assert.equal(job.status, "queued");
    assert.equal(listParallelJobs(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("parallel profile gate: queueParallelJob stays permissive - a job may name a profile removed later", () => {
  const f = fixture();
  try {
    const job = queueParallelJob(f.sam, { actor: "trading", chatId: f.chatId, spec: "Build the fixture feature", slices: [{ name: "one", task: "WRITE a.txt :: a" }] }, f.env);
    assert.equal(job.actor, "trading");
    assert.equal(listParallelJobs(f.sam).length, 1);
  } finally { f.cleanup(); }
});

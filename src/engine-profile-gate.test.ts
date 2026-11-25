import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { engineProfileBlocker, listEngineTasks, queueEngineTask } from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";

// The profile gate for the engine queue door: every
// profile-naming creation door and the background and
// coding queue doors read the profile registry before
// creating anything, but CLI `engine queue --actor`
// passed the raw actor into queueEngineTask, which checks
// only the name's shape - minting a queued engine run
// bound to nobody: the record sits in the queue under an
// actor that is no profile, its ledger line carries that
// same phantom actor, and the run's work is accounted to
// a profile that resolves no registered profile.
// engineProfileBlocker is now the ONE source carrying
// the refusal text: the queue door throws it before
// queuing anything. queueEngineTask itself stays
// permissive by design (a profile removed after a run
// names it leaves the record with its stored actor, and
// the ONE gate's approved engine execution names its
// actor by construction), so it is NOT gated here.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-profile-gate-"));
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
  const prev = process.env.SAM_ENGINE_BIN;
  process.env.SAM_ENGINE_BIN = fake;
  return {
    base, sam, proj,
    cleanup() {
      if (prev === undefined) delete process.env.SAM_ENGINE_BIN; else process.env.SAM_ENGINE_BIN = prev;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", null).id; } finally { db.close(); }
}

test("engine profile gate: sam and a registered profile read no blocker", () => {
  const f = fixture();
  try {
    assert.equal(engineProfileBlocker(f.sam, "sam"), null);
    register(f.sam, "second-shift");
    assert.equal(engineProfileBlocker(f.sam, "second-shift"), null);
  } finally { f.cleanup(); }
});

test("engine profile gate: an unknown profile names the registry and the fold correction", () => {
  const f = fixture();
  try {
    assert.equal(
      engineProfileBlocker(f.sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in engine detail. Valid profiles: sam",
    );
    register(f.sam, "second-shift");
    assert.equal(
      engineProfileBlocker(f.sam, "Second Shift"),
      "Unknown profile \"Second Shift\" in engine detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      engineProfileBlocker(f.sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in engine detail. Valid profiles: sam, second-shift",
    );
  } finally { f.cleanup(); }
});

test("engine profile gate: the door's check queues nothing for a bogus profile", () => {
  const f = fixture();
  try {
    const blocker = engineProfileBlocker(f.sam, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // queueEngineTask; pin that the check alone leaves
    // no run behind.
    assert.equal(listEngineTasks(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("engine profile gate: a registered profile passes the check and the run is queued bound to it", () => {
  const f = fixture();
  try {
    register(f.sam, "second-shift");
    assert.equal(engineProfileBlocker(f.sam, "second-shift"), null);
    setCodeRoot(f.sam, f.proj);
    const chatId = scratchChat(f.sam);
    const task = queueEngineTask(f.sam, { actor: "second-shift", chatId, spec: "Add a hello file" });
    assert.equal(task.actor, "second-shift");
    assert.equal(task.status, "queued");
    assert.equal(listEngineTasks(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("engine profile gate: queueEngineTask stays permissive - a run may name a profile removed later", () => {
  const f = fixture();
  try {
    setCodeRoot(f.sam, f.proj);
    const chatId = scratchChat(f.sam);
    const task = queueEngineTask(f.sam, { actor: "trading", chatId, spec: "Add a hello file" });
    assert.equal(task.actor, "trading");
    assert.equal(listEngineTasks(f.sam).length, 1);
  } finally { f.cleanup(); }
});

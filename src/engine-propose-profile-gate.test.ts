import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { engineProfileBlocker } from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";

// The profile gate for the engine PROPOSE door (the
// gate-level actor audit, after the queue-door class):
// every queue door read the profile registry before
// creating anything, but CLI `engine propose --actor`
// passed the raw actor into proposeAction, which checks
// only the name's shape - minting a pending approval card
// bound to nobody: the card sits on the ONE gate under a
// phantom actor, and on approval the engine run queues
// under that same actor, its work accounted to no
// profile. engineProfileBlocker (the queue door's ONE
// source) now carries the refusal for this door too: the
// propose door throws it before proposing anything.
// proposeAction itself stays permissive by design (the
// chat tools name their actor by construction - the
// speaking chat's own profile - and the push doors carry
// a stored task's actor), so it is NOT gated here.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-propose-profile-gate-"));
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

test("engine propose profile gate: sam and a registered profile read no blocker", () => {
  const f = fixture();
  try {
    assert.equal(engineProfileBlocker(f.sam, "sam"), null);
    register(f.sam, "second-shift");
    assert.equal(engineProfileBlocker(f.sam, "second-shift"), null);
  } finally { f.cleanup(); }
});

test("engine propose profile gate: an unknown profile names the registry and the fold correction", () => {
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
  } finally { f.cleanup(); }
});

test("engine propose profile gate: the door's check proposes nothing for a bogus profile", () => {
  const f = fixture();
  try {
    const blocker = engineProfileBlocker(f.sam, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // proposeAction; pin that the check alone leaves
    // no card behind.
    assert.equal(listActions(f.sam).length, 0);
  } finally { f.cleanup(); }
});

test("engine propose profile gate: a registered profile passes the check and the card is proposed bound to it", () => {
  const f = fixture();
  try {
    register(f.sam, "second-shift");
    assert.equal(engineProfileBlocker(f.sam, "second-shift"), null);
    setCodeRoot(f.sam, f.proj);
    const chatId = scratchChat(f.sam);
    const a = proposeAction(f.sam, { actor: "second-shift", kind: "engine", title: "Engine run: Add a hello file", detail: JSON.stringify({ task: "Add a hello file" }), chatId });
    assert.equal(a.actor, "second-shift");
    assert.equal(a.kind, "engine");
    assert.equal(a.status, "pending");
    assert.equal(listActions(f.sam).length, 1);
  } finally { f.cleanup(); }
});

test("engine propose profile gate: proposeAction stays permissive - a card may name a profile removed later", () => {
  const f = fixture();
  try {
    setCodeRoot(f.sam, f.proj);
    const chatId = scratchChat(f.sam);
    const a = proposeAction(f.sam, { actor: "trading", kind: "engine", title: "Engine run: Add a hello file", detail: JSON.stringify({ task: "Add a hello file" }), chatId });
    assert.equal(a.actor, "trading");
    assert.equal(listActions(f.sam).length, 1);
  } finally { f.cleanup(); }
});

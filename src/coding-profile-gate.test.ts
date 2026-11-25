import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { codingProfileBlocker, listCodingTasks, queueCodingTask } from "./coding.js";

// The profile gate for the coding queue door: every
// profile-naming creation door and the background queue
// door read the profile registry before creating anything,
// but CLI `coding queue --actor` passed the raw actor into
// queueCodingTask, which checks only the name's shape -
// minting a queued coding task bound to nobody: the record
// sits in the queue under an actor that is no profile, its
// ledger line carries that same phantom actor, and the
// drain runs its turns under a profile that resolves no
// registered profile.
// codingProfileBlocker is now the ONE source carrying the
// refusal text: the queue door throws it before queuing
// anything. queueCodingTask itself stays permissive by
// design (a profile removed after a task names it leaves
// the record with its stored actor, the sam_coding_task
// chat tool names its actor by construction, and the
// self-work bridge queues under "sam" by construction),
// so it is NOT gated here.

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-coding-profile-gate-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
  return { base, sam, proj };
}

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", null).id; } finally { db.close(); }
}

test("coding profile gate: sam and a registered profile read no blocker", () => {
  const { base, sam } = fixture();
  try {
    assert.equal(codingProfileBlocker(sam, "sam"), null);
    register(sam, "second-shift");
    assert.equal(codingProfileBlocker(sam, "second-shift"), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding profile gate: an unknown profile names the registry and the fold correction", () => {
  const { base, sam } = fixture();
  try {
    assert.equal(
      codingProfileBlocker(sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in coding detail. Valid profiles: sam",
    );
    register(sam, "second-shift");
    assert.equal(
      codingProfileBlocker(sam, "Second Shift"),
      "Unknown profile \"Second Shift\" in coding detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      codingProfileBlocker(sam, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in coding detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding profile gate: the door's check queues nothing for a bogus profile", () => {
  const { base, sam } = fixture();
  try {
    const blocker = codingProfileBlocker(sam, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // queueCodingTask; pin that the check alone leaves
    // no task behind.
    assert.equal(listCodingTasks(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding profile gate: a registered profile passes the check and the task is queued bound to it", () => {
  const { base, sam, proj } = fixture();
  try {
    register(sam, "second-shift");
    assert.equal(codingProfileBlocker(sam, "second-shift"), null);
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const task = queueCodingTask(sam, { actor: "second-shift", chatId, spec: "Add a hello file" });
    assert.equal(task.actor, "second-shift");
    assert.equal(task.status, "queued");
    assert.equal(listCodingTasks(sam).length, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding profile gate: queueCodingTask stays permissive - a task may name a profile removed later", () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Add a hello file" });
    assert.equal(task.actor, "trading");
    assert.equal(listCodingTasks(sam).length, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

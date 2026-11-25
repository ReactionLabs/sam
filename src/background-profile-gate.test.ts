import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { backgroundProfileBlocker, listBackgroundTasks, queueBackgroundTask } from "./background.js";

// The profile gate for the background queue door: every
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `background handoff
// --actor` passed the raw actor into queueBackgroundTask,
// which checks only the name's shape - minting a queued task
// bound to nobody: the record sits in the queue under an
// actor that is no profile, its ledger line carries that
// same phantom actor, and the drain runs its turn under a
// profile that resolves no registered profile.
// backgroundProfileBlocker is now the ONE source carrying
// the refusal text: the queue door throws it before queuing
// anything. queueBackgroundTask itself stays permissive by
// design (a profile removed after a task names it leaves
// the record with its stored actor, and the sam_handoff_task
// chat tool names its actor by construction), so it is NOT
// gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-background-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", null).id; } finally { db.close(); }
}

test("background profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(backgroundProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(backgroundProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      backgroundProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in background detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      backgroundProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in background detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      backgroundProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in background detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background profile gate: the door's check queues nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = backgroundProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // queueBackgroundTask; pin that the check alone leaves
    // no task behind.
    assert.equal(listBackgroundTasks(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background profile gate: a registered profile passes the check and the task is queued bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(backgroundProfileBlocker(root, "second-shift"), null);
    const chatId = scratchChat(root);
    const task = queueBackgroundTask(root, { actor: "second-shift", chatId, prompt: "Compare the last three stack reports in depth" });
    assert.equal(task.actor, "second-shift");
    assert.equal(task.status, "queued");
    assert.equal(listBackgroundTasks(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background profile gate: queueBackgroundTask stays permissive - a task may name a profile removed later", () => {
  const root = fresh();
  try {
    const chatId = scratchChat(root);
    const task = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "deep dive please" });
    assert.equal(task.actor, "trading");
    assert.equal(listBackgroundTasks(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

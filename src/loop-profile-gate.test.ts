import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listLoops, loopProfileBlocker, openLoop } from "./loops.js";

// The profile gate for the loop creation door: every other
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `loops open <profile>`
// passed the raw profile into openLoop, which checks only
// the question and watchFor, minting a loop bound to nobody
// whose heartbeat revisit runs a turn under a profile that
// resolves no registered profile and runs unscoped.
// loopProfileBlocker is now the ONE source carrying the
// refusal text: the CLI door throws it before creating
// anything. The store itself stays permissive by design (a
// profile removed after a loop names it leaves the loop with
// its stored binding, and internal callers name a profile by
// construction), so openLoop is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-loop-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("loop profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(loopProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(loopProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      loopProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in loop detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      loopProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in loop detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      loopProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in loop detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop profile gate: the CLI door's check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = loopProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling openLoop;
    // pin that the check alone leaves the loop list empty.
    assert.equal(listLoops(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop profile gate: a registered profile passes the check and the loop is opened bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(loopProfileBlocker(root, "second-shift"), null);
    const loop = openLoop(root, { profile: "second-shift", question: "Did it ship?", watchFor: "the release" });
    assert.equal(loop.profile, "second-shift");
    assert.equal(listLoops(root, { profile: "second-shift" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop profile gate: the store stays permissive - a loop may name a profile removed later", () => {
  const root = fresh();
  try {
    const loop = openLoop(root, { profile: "trading", question: "Did it move?", watchFor: "the price" });
    assert.equal(loop.profile, "trading");
    assert.equal(listLoops(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { actionProfileBlocker, listActions, proposeAction } from "./actions.js";

// The profile gate for the generic actions propose door
// (the gate-level actor audit, after the engine propose
// door): every queue door and the engine propose door read
// the profile registry before creating anything, but CLI
// `actions propose <profile>` passed the raw profile into
// proposeAction, which checks only the name's shape -
// minting a pending approval card bound to nobody: the card
// sits on the ONE gate under a phantom actor, its proposal
// ledger line carries that same actor, and on approval its
// execution runs under that actor. actionProfileBlocker is
// now the ONE source carrying the refusal text: the CLI
// door throws it before proposing anything. proposeAction
// itself stays permissive by design (chat tools name their
// actor by construction - the speaking chat's own profile -
// the domain propose doors ride their own ONE sources, and
// push doors carry a stored task's actor), so it is NOT
// gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-action-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("action profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(actionProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(actionProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      actionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in action detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      actionProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in action detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      actionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in action detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action profile gate: the CLI door's check proposes nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = actionProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling
    // proposeAction; pin that the check alone leaves
    // no card behind.
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action profile gate: a registered profile passes the check and the card is proposed bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(actionProfileBlocker(root, "second-shift"), null);
    const a = proposeAction(root, { actor: "second-shift", kind: "note", title: "Remember this", detail: "A note for the profile" });
    assert.equal(a.actor, "second-shift");
    assert.equal(a.status, "pending");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action profile gate: proposeAction stays permissive - a card may name a profile removed later", () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "trading", kind: "note", title: "Remember this", detail: "A note for the profile" });
    assert.equal(a.actor, "trading");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

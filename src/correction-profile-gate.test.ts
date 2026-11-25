import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listActions } from "./actions.js";
import { correctionProfileBlocker, proposeCorrection } from "./corrections.js";

// The profile gate for the correction door: every
// profile-naming creation and gate-level propose door
// reads the profile registry before creating anything,
// but CLI `corrections check <profile>` passed the raw
// profile into proposeCorrection, which checks only the
// name's shape - minting a pending law proposal bound to
// nobody: on approval the executor saves standing law at
// that profile's scope, and law injection only ever
// consults "sam" and real profile scopes, so the owner's
// correction would become law for nobody and govern
// nothing, silently. correctionProfileBlocker is now the
// ONE source carrying the refusal text: the corrections
// check door throws it before detecting or proposing
// anything. proposeCorrection itself stays permissive by
// design (a profile removed after a correction names it
// keeps its stored actor, and the live turn, consolidation,
// and the eval battery name their actor by construction),
// so it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-correction-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("correction profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(correctionProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(correctionProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      correctionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in correction detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      correctionProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in correction detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      correctionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in correction detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction profile gate: the door's check proposes nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = correctionProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // proposeCorrection; pin that the check alone leaves
    // no proposal behind.
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction profile gate: a registered profile passes the check and the correction is proposed bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(correctionProfileBlocker(root, "second-shift"), null);
    const routed = proposeCorrection(root, { actor: "second-shift", text: "don't call it a mini" });
    assert.ok(routed);
    assert.equal(routed.created, true);
    assert.equal(routed.proposal.actor, "second-shift");
    assert.equal(routed.proposal.kind, "law");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction profile gate: proposeCorrection stays permissive - a correction may name a profile removed later", () => {
  const root = fresh();
  try {
    const routed = proposeCorrection(root, { actor: "trading", text: "don't call it a mini" });
    assert.ok(routed);
    assert.equal(routed.created, true);
    assert.equal(routed.proposal.actor, "trading");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

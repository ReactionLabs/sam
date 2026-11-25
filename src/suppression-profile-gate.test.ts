import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { CaptureGuardStore, addSuppression, suppressionProfileBlocker } from "./capture-guard.js";

// The profile gate for the memory suppression door: every
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `memory suppress
// --profile` passed the raw profile into addSuppression,
// whose store checks only the name's shape - recording a
// standing do-not-store instruction bound to nobody:
// suppression matching only ever consults "sam" and real
// profile scopes, so the record can never match anything
// and the owner's instruction silently protects nothing.
// suppressionProfileBlocker is now the ONE source carrying
// the refusal text: the suppress door throws it before
// recording anything. addSuppression itself stays
// permissive by design (a profile removed after a
// suppression names it keeps its stored record, and
// captureSuppressionsFromText names its profile by
// construction from the speaking chat), so it is NOT gated
// here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-suppression-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function suppressionCount(root: string): number {
  const guard = new CaptureGuardStore(root);
  try { return guard.list(undefined, true).length; } finally { guard.close(); }
}

test("suppression profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(suppressionProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(suppressionProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suppression profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      suppressionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in suppression detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      suppressionProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in suppression detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      suppressionProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in suppression detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suppression profile gate: the door's check records nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = suppressionProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // addSuppression; pin that the check alone leaves no
    // suppression behind.
    assert.equal(suppressionCount(root), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suppression profile gate: a registered profile passes the check and the suppression is recorded bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(suppressionProfileBlocker(root, "second-shift"), null);
    const result = addSuppression(root, { profile: "second-shift", needle: "harbor gate code", source: "cli" });
    assert.equal(result.created, true);
    assert.equal(result.record.profile, "second-shift");
    assert.equal(suppressionCount(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suppression profile gate: addSuppression stays permissive - a suppression may name a profile removed later", () => {
  const root = fresh();
  try {
    const result = addSuppression(root, { profile: "trading", needle: "harbor gate code", source: "chat-1" });
    assert.equal(result.created, true);
    assert.equal(result.record.profile, "trading");
    assert.equal(suppressionCount(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

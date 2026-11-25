import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { createDraft, draftProfileBlocker, listDrafts } from "./drafts.js";

// The profile gate for the draft creation door: every other
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `drafts create --actor`
// passed the raw actor into createDraft, which checks only
// the name's shape - minting a draft record bound to nobody:
// the record sits in the store under an actor that is no
// profile, its ledger line carries that same phantom actor,
// and no profile's surface ever accounts for it as its own
// work. draftProfileBlocker is now the ONE source carrying
// the refusal text: the CLI door throws it before creating
// anything. createDraft itself stays permissive by design
// (a profile removed after a draft names it leaves the
// record with its stored actor, and the ONE gate's approved
// draft execution names its actor by construction), so it
// is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-draft-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("draft profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(draftProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(draftProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      draftProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in draft detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      draftProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in draft detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      draftProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in draft detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft profile gate: the CLI door's check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = draftProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling createDraft;
    // pin that the check alone leaves no draft behind.
    assert.equal(listDrafts(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft profile gate: a registered profile passes the check and the draft is stored bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(draftProfileBlocker(root, "second-shift"), null);
    const draft = createDraft(root, { actor: "second-shift", to: "A Client", body: "Hello there" });
    assert.equal(draft.actor, "second-shift");
    assert.equal(listDrafts(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft profile gate: createDraft stays permissive - a draft may name a profile removed later", () => {
  const root = fresh();
  try {
    const draft = createDraft(root, { actor: "trading", to: "A Client", body: "Hello there" });
    assert.equal(draft.actor, "trading");
    assert.equal(listDrafts(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

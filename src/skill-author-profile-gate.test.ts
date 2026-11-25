import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listActions } from "./actions.js";
import { proposeAuthoredSkill, skillAuthorProfileBlocker } from "./skill-author.js";

// The profile gate for the skill propose door: every
// profile-naming creation, queue, and gate-level propose
// door reads the profile registry before creating
// anything, but CLI `skills propose --profile` passed the
// raw profile into proposeAuthoredSkill, which checks only
// the name's shape - minting a pending skill-author
// proposal bound to nobody: the proposal record and the
// skill-gated ledger line carry that phantom actor, and on
// approval the authored skill's provenance record carries
// it too, corrupting the provenance of a real, global
// skill. skillAuthorProfileBlocker is now the ONE source
// carrying the refusal text: the skills propose door
// throws it before validating or proposing anything.
// proposeAuthoredSkill itself stays permissive by design
// (a profile removed after a proposal names it keeps its
// stored actor, and the sam_author_skill chat tool names
// its actor by construction from the speaking chat), so
// it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-author-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

const DRAFT = {
  name: "gate-probe-skill",
  description: "Probe skill for checking the profile gate on the propose door",
  instructions: "Step one: check the acting profile against the registry. Step two: only then propose the draft for owner approval.",
};

test("skill author profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(skillAuthorProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(skillAuthorProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      skillAuthorProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in skill propose detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      skillAuthorProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in skill propose detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      skillAuthorProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in skill propose detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author profile gate: the door's check proposes nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = skillAuthorProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // proposeAuthoredSkill; pin that the check alone
    // leaves no proposal behind.
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author profile gate: a registered profile passes the check and the draft is proposed bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(skillAuthorProfileBlocker(root, "second-shift"), null);
    const routed = proposeAuthoredSkill(root, { actor: "second-shift", ...DRAFT });
    assert.equal(routed.status, "pending_owner_approval");
    assert.equal(routed.patch, false);
    assert.equal(routed.proposal.actor, "second-shift");
    assert.equal(routed.proposal.kind, "skill-author");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author profile gate: proposeAuthoredSkill stays permissive - a draft may name a profile removed later", () => {
  const root = fresh();
  try {
    const routed = proposeAuthoredSkill(root, { actor: "trading", ...DRAFT });
    assert.equal(routed.status, "pending_owner_approval");
    assert.equal(routed.proposal.actor, "trading");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

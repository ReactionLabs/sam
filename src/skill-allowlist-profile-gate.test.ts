import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { setSkillAllowlist, skillAllowlist, skillAllowlistProfileBlocker } from "./skills.js";

// The profile gate for the skill allowlist doors: every
// profile-naming creation, queue, propose, and standing-
// instruction door reads the profile registry before
// writing anything, and `skills allow` gated inline on
// it, but `skills allow-clear <profile>` called
// setSkillAllowlist with no registry check anywhere -
// the store checks only the name's shape. A shape-valid
// phantom (or a typo) deleted nothing, yet the verb
// reported success and the store wrote a skill-allowlist
// ledger line carrying that phantom actor, so the
// operator believed a real profile's skill fence was
// lifted while the real fence stood untouched.
// skillAllowlistProfileBlocker is now the ONE source
// carrying the refusal text: both allowlist doors throw
// it before setting or clearing anything.
// setSkillAllowlist itself stays permissive by design
// (a profile removed after a fence names it keeps its
// stored row, and a later store-level clear under that
// name must still be able to lift it), so it is NOT
// gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-allowlist-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("skill allowlist profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(skillAllowlistProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(skillAllowlistProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlist profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      skillAllowlistProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in skill allowlist detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      skillAllowlistProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in skill allowlist detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      skillAllowlistProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in skill allowlist detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlist profile gate: the door's check clears nothing and ledgers nothing for a bogus profile", () => {
  const root = fresh();
  try {
    register(root, "trading");
    setSkillAllowlist(root, "trading", []);
    const before = readActivity(root, 100).filter(l => l.kind === "skill-allowlist").length;
    const blocker = skillAllowlistProfileBlocker(root, "tradign");
    assert.ok(blocker);
    // The door throws this text before calling
    // setSkillAllowlist; pin that the check alone leaves
    // the real fence and the ledger untouched.
    assert.deepEqual(skillAllowlist(root, "trading"), []);
    assert.equal(readActivity(root, 100).filter(l => l.kind === "skill-allowlist").length, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlist profile gate: a registered profile passes the check and its fence really clears", () => {
  const root = fresh();
  try {
    register(root, "trading");
    setSkillAllowlist(root, "trading", []);
    assert.deepEqual(skillAllowlist(root, "trading"), []);
    assert.equal(skillAllowlistProfileBlocker(root, "trading"), null);
    assert.equal(setSkillAllowlist(root, "trading", null), null);
    assert.equal(skillAllowlist(root, "trading"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlist profile gate: setSkillAllowlist stays permissive - a fence may name a profile removed later", () => {
  const root = fresh();
  try {
    assert.deepEqual(setSkillAllowlist(root, "trading", []), []);
    assert.deepEqual(skillAllowlist(root, "trading"), []);
    assert.equal(setSkillAllowlist(root, "trading", null), null);
    assert.equal(skillAllowlist(root, "trading"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

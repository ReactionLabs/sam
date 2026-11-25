import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { artifactProfileBlocker, createArtifact, listArtifacts, updateArtifact } from "./artifacts.js";

// The profile gate for the artifact creation doors: every other
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `artifacts create
// --profile` and `artifacts update --profile` (and the
// dashboard artifacts API) passed the raw profile into
// createArtifact / updateArtifact, which check only the name's
// shape - minting an artifact owned by nobody: the record sits
// in the store under a profile that is no profile, its ledger
// line carries that same phantom profile, and no profile's
// surface ever lists it as its own work (an update under a
// phantom profile died misleadingly on the ownership check
// instead). artifactProfileBlocker is now the ONE source
// carrying the refusal text: the creation doors throw it
// before creating or versioning anything. createArtifact /
// updateArtifact themselves stay permissive by design (a
// profile removed after an artifact names it leaves the
// record with its stored profile, and the chat tool names its
// actor by construction), so they are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-artifact-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("artifact profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(artifactProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(artifactProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      artifactProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in artifact detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      artifactProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in artifact detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      artifactProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in artifact detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact profile gate: the doors' check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = artifactProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The doors throw this text before calling createArtifact /
    // updateArtifact; pin that the check alone leaves no
    // artifact behind.
    assert.equal(listArtifacts(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact profile gate: a registered profile passes the check and the artifact is stored and updated bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(artifactProfileBlocker(root, "second-shift"), null);
    const made = createArtifact(root, { profile: "second-shift", title: "Brief", kind: "markdown", content: "# Brief" });
    assert.equal(made.profile, "second-shift");
    assert.equal(listArtifacts(root, "second-shift").length, 1);
    const updated = updateArtifact(root, made.id, { profile: "second-shift", content: "# Brief v2" });
    assert.equal(updated.version, 2);
    assert.equal(updated.profile, "second-shift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact profile gate: createArtifact stays permissive - an artifact may name a profile removed later", () => {
  const root = fresh();
  try {
    const made = createArtifact(root, { profile: "trading", title: "Note", kind: "markdown", content: "# Note" });
    assert.equal(made.profile, "trading");
    assert.equal(listArtifacts(root, "trading").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

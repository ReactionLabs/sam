import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { noteProfileBlocker, saveNote } from "./notes.js";
import { listActions } from "./actions.js";

// The profile gate for the note creation doors: every other
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `notes save --profile`
// and `notes patch --profile` passed the raw profile into
// saveNote / patchNote as the actor, which checks only the
// name's shape - a soft save minting a real memory record at
// scope profile:<bogus> that recall for any real profile
// never surfaces, and a hard save or patch minting a ONE-gate
// proposal under an actor that does not exist.
// noteProfileBlocker is now the ONE source carrying the
// refusal text: both CLI doors throw it before creating
// anything. saveNote / patchNote themselves stay permissive
// by design (a profile removed after a note names it leaves
// the record with its stored scope, and internal callers name
// a profile by construction), so they are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-note-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function memoryCount(root: string): number {
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try { return store.list().length; } finally { store.close(); }
}

test("note profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(noteProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(noteProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      noteProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in note detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      noteProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in note detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      noteProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in note detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note profile gate: the CLI doors' check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = noteProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // Both CLI doors throw this text before calling saveNote /
    // patchNote; pin that the check alone leaves no memory
    // record and no gate proposal behind.
    assert.equal(memoryCount(root), 0);
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note profile gate: a registered profile passes the check and the note is stored bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(noteProfileBlocker(root, "second-shift"), null);
    const r = saveNote(root, { actor: "second-shift", content: "The samples shipped Tuesday" });
    assert.equal(r.status, "saved");
    if (r.status === "saved") assert.equal(r.record.scope, "profile:second-shift");
    assert.equal(memoryCount(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note profile gate: saveNote stays permissive - a note may name a profile removed later", () => {
  const root = fresh();
  try {
    const r = saveNote(root, { actor: "trading", content: "The stack froze on Tuesday" });
    assert.equal(r.status, "saved");
    if (r.status === "saved") assert.equal(r.record.scope, "profile:trading");
    assert.equal(memoryCount(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

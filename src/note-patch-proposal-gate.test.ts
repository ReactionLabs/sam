import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { MemoryStore, notePatchBlocker } from "./memory.js";
import { patchNote, validatePatchTarget } from "./notes.js";

// The proposal-time execution gate for a note's supersedes
// target: the note doors (patchNote / saveNote) always
// pre-validated the target, but proposeAction itself checked
// nothing, so a note proposal written straight through the
// gate naming a missing, archived, or other-scope record
// carded cleanly and could only fail on approval.
// notePatchBlocker in memory.ts is the ONE source: the gate,
// validatePatchTarget, and the executor all throw its texts.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-note-patch-gate-")); }

function seed(root: string, scope: string, content = "the old text"): string {
  const store = new MemoryStore(join(root, ".sam", "missions.db"));
  try { return store.add({ kind: "observation", content, source: "test", scope }).id; }
  finally { store.close(); }
}

test("note patch gate: a missing target refuses at proposal in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    const blocker = notePatchBlocker(null, "ghost-id", "core");
    assert.equal(blocker, "Cannot patch: record ghost-id no longer exists");
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "note", title: "Patch", detail: "replacement", supersedes: "ghost-id" }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note patch gate: the refusal is byte-identical at the gate, at the note door, and at execution", async () => {
  const root = fresh();
  try {
    const id = seed(root, "core");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.archive(id), true); } finally { store.close(); }
    let gated = "";
    try { proposeAction(root, { actor: "sam", kind: "note", title: "Patch", detail: "replacement", supersedes: id }); } catch (e) { gated = e instanceof Error ? e.message : String(e); }
    let doored = "";
    try { validatePatchTarget(root, "sam", id); } catch (e) { doored = e instanceof Error ? e.message : String(e); }
    assert.equal(gated, "Cannot patch: record " + id + " is already archived");
    assert.equal(doored, gated);
    // Execution rides the same source: a record archived between
    // a valid proposal and approval fails with the same text.
    const liveId = seed(root, "core", "a second old text");
    const a = proposeAction(root, { actor: "sam", kind: "note", title: "Patch", detail: "replacement", supersedes: liveId });
    const store2 = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store2.archive(liveId), true); } finally { store2.close(); }
    const done = await decideAction(root, a.id, true);
    assert.equal(done.status, "failed");
    assert.equal(done.result, "Cannot patch: record " + liveId + " is already archived");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note patch gate: another profile's record refuses at proposal; its own scope proposes and executes", async () => {
  const root = fresh();
  try {
    const id = seed(root, "profile:trading");
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "note", title: "Patch", detail: "replacement", supersedes: id }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, "Cannot patch: record " + id + " is not in this profile's scope");
    assert.equal(listActions(root).length, 0);
    const a = proposeAction(root, { actor: "trading", kind: "note", title: "Patch", detail: "the corrected text", supersedes: id });
    const done = await decideAction(root, a.id, true);
    assert.equal(done.status, "done");
    assert.match(done.result ?? "", /superseding record archived/);
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try {
      assert.ok(store.get(id)?.archived_at);
      assert.equal(store.list(undefined, ["profile:trading"]).filter(r => r.content === "the corrected text").length, 1);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note patch gate: a note naming no supersedes target is not read against the store", () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "sam", kind: "note", title: "Plain note", detail: "just a note" });
    assert.equal(a.status, "pending");
    assert.equal(a.supersedes, null);
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note patch gate: patchNote still routes through the gate and lands the patch on approval", async () => {
  const root = fresh();
  try {
    const id = seed(root, "core", "the fact before");
    const r = patchNote(root, { actor: "sam", id, content: "the fact after" });
    assert.equal(r.supersedes, id);
    const done = await decideAction(root, r.proposal.id, true);
    assert.equal(done.status, "done");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.ok(store.get(id)?.archived_at); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note patch gate: the blocker is null only for a live record at the proposer's scope", () => {
  const base = { id: "x", mission_id: null, kind: "observation" as const, content: "c", source: "t", source_hash: "h", created_at: "2026-01-01T00:00:00.000Z", archived_at: null, scope: "core", aliases: [] };
  assert.equal(notePatchBlocker(base, "x", "core"), null);
  assert.equal(notePatchBlocker({ ...base, archived_at: "2026-01-02T00:00:00.000Z" }, "x", "core"), "Cannot patch: record x is already archived");
  assert.equal(notePatchBlocker({ ...base, scope: "profile:trading" }, "x", "core"), "Cannot patch: record x is not in this profile's scope");
});

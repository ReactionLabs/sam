import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, foldedMemoryScope, isMemoryScope, memoryScopeBlocker, memoryScopeForms } from "./memory.js";
import { readActivity } from "./activity.js";

// The memory scope gate: the scope is a form name
// (memoryScopeForms in memory.ts: core, profile:<name>,
// link:<id>) that every memory write names into
// MemoryStore.add, the ONE seam every write rides
// (episode flush, consolidation flush, saved notes,
// approved note actions, the operator CLI memory door).
// add refused a bad scope with the bare "Invalid memory
// scope" - echoing no value, naming none of the forms,
// and offering no fold correction, so a folded scope
// dead-ended. memoryScopeBlocker in memory.ts is now
// the ONE source carrying the refusal text. Stored
// scopes are unchanged: read back as stored, never
// re-validated.

const LINK_ID = "123e4567-e89b-42d3-a456-426614174000";

test("memory scope gate: every exact scope form reads no blocker, and the forms registry names the three forms", () => {
  assert.equal(memoryScopeBlocker("core"), null);
  assert.equal(memoryScopeBlocker("profile:dip"), null);
  assert.equal(memoryScopeBlocker("profile:second-shift"), null);
  assert.equal(memoryScopeBlocker("link:" + LINK_ID), null);
  assert.deepEqual([...memoryScopeForms], ["core", "profile:<name>", "link:<id>"]);
  for (const form of ["core", "profile:dip", "link:" + LINK_ID]) assert.equal(isMemoryScope(form), true, form);
});

test("memory scope gate: an unknown scope echoes the value and names the forms, no correction", () => {
  assert.equal(
    memoryScopeBlocker("nowhere"),
    "Invalid memory scope \"nowhere\". Scopes: core, profile:<name>, link:<id>",
  );
  assert.equal(foldedMemoryScope("nowhere"), null);
  assert.equal(foldedMemoryScope("profile:!!!"), null);
});

test("memory scope gate: a folded scope is refused with the correction", () => {
  assert.match(memoryScopeBlocker("Core")!, /Did you mean "core"\?$/);
  assert.match(memoryScopeBlocker("PROFILE:DIP")!, /Did you mean "profile:dip"\?$/);
  assert.match(memoryScopeBlocker("Profile:Second Shift")!, /Did you mean "profile:second-shift"\?$/);
  assert.match(memoryScopeBlocker("profile_second-shift")!, /Did you mean "profile:second-shift"\?$/);
  assert.equal(memoryScopeBlocker("link:" + LINK_ID.toUpperCase()), null);
  assert.match(memoryScopeBlocker("link_" + LINK_ID)!, new RegExp("Did you mean \"link:" + LINK_ID + "\"\\?$"));
  assert.equal(foldedMemoryScope("Core"), "core");
});

test("memory scope gate: a non-string or empty value refuses naming the forms, no correction", () => {
  assert.match(memoryScopeBlocker(42)!, /^Invalid memory scope "42"\. Scopes:/);
  assert.doesNotMatch(memoryScopeBlocker(42)!, /Did you mean/);
  assert.match(memoryScopeBlocker("")!, /^Invalid memory scope ""\. Scopes:/);
  assert.doesNotMatch(memoryScopeBlocker("")!, /Did you mean/);
  assert.match(memoryScopeBlocker(undefined)!, /^Invalid memory scope "undefined"\. Scopes:/);
  assert.doesNotMatch(memoryScopeBlocker(undefined)!, /Did you mean/);
});

test("memory scope gate: the add seam refuses a folded scope before any write, and an exact scope writes", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-scope-gate-"));
  try {
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try {
      assert.throws(
        () => store.add({ kind: "observation", content: "x", source: "test", scope: "Core" }),
        /^Error: Invalid memory scope "Core"\. Scopes: core, profile:<name>, link:<id>\. Did you mean "core"\?$/,
      );
      assert.throws(
        () => store.add({ kind: "observation", content: "x", source: "test", scope: "nowhere" }),
        /^Error: Invalid memory scope "nowhere"\. Scopes: core, profile:<name>, link:<id>$/,
      );
      assert.equal(store.list().length, 0);
      const saved = store.add({ kind: "observation", content: "x", source: "test", scope: "profile:dip" });
      assert.equal(saved.scope, "profile:dip");
      assert.equal(store.list().length, 1);
    } finally {
      store.close();
    }
    // A validation refusal is not a store failure: no
    // memory-store-failed line is ledgered for it.
    assert.equal(readActivity(root, 50).filter(l => l.kind === "memory-store-failed").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

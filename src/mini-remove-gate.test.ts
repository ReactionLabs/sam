import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMini, miniRemoveBlocker, minis, removeMini, spawnMini } from "./minis.js";

// The mini gate for the remove door: minis are spawned by
// name, listed by name, and served through doors by name,
// but `sam minis remove <name>` rode removeMini alone and
// took an exact name ONLY: it accepted no id, carried no
// description, and an unknown or folded name silently
// returned {removed:false}, naming nothing, so at the door
// that DELETES a person's scoped SAM the owner could not
// tell a typo or a fold from a genuinely absent mini (the
// heartbeat-remove shape). miniDoorBlocker is not the
// source for this door: it is the door registry, which
// includes "sam" (the core gets a door), and the core is
// not a mini and must never read as removable. The CLI
// remove door now takes <idOrName>, resolves it through
// findMini (throwing miniRemoveBlocker, the ONE source
// over the minis registry alone, naming the registry with
// a fold correction, before anything is removed) and
// removes by the resolved name; removeMini keeps its
// boolean contract (false on a miss) for internal callers
// - the store seam stays permissive by design.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-mini-remove-gate-"));
  spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
  spawnMini(root, { name: "coach-k", person: "Kaylee", instructions: "Help Kaylee." });
  return root;
}

test("mini remove gate: an exact name reads no blocker and removes by the resolved name", () => {
  const root = fresh();
  try {
    assert.equal(miniRemoveBlocker(root, "alex"), null);
    const resolved = findMini(root, "alex");
    assert.equal(removeMini(root, resolved.name), true);
    assert.deepEqual(minis(root).map(m => m.name), ["coach-k"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: an exact id reads no blocker and removes", () => {
  const root = fresh();
  try {
    const target = findMini(root, "coach-k");
    assert.equal(miniRemoveBlocker(root, target.id), null);
    assert.equal(removeMini(root, findMini(root, target.id).name), true);
    assert.deepEqual(minis(root).map(m => m.name), ["alex"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const alex = findMini(root, "alex");
    const coach = findMini(root, "coach-k");
    const blocker = miniRemoveBlocker(root, "Coach K")!;
    assert.equal(
      blocker,
      "Mini not found: \"Coach K\". Minis: alex (" + alex.id + "), coach-k (" + coach.id + "). Did you mean \"coach-k\" (" + coach.id + ")?",
    );
    assert.throws(() => findMini(root, "Coach K"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // mini is still registered afterwards.
    assert.deepEqual(minis(root).map(m => m.name), ["alex", "coach-k"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: a separator-folded name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = miniRemoveBlocker(root, "COACH_K")!;
    assert.match(blocker, /Did you mean "coach-k" \(.+\)\?$/);
    assert.deepEqual(minis(root).map(m => m.name), ["alex", "coach-k"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: the core name sam is not a mini and reads a blocker", () => {
  const root = fresh();
  try {
    const blocker = miniRemoveBlocker(root, "sam")!;
    assert.match(blocker, /^Mini not found: "sam"\. Minis: alex \(.+\), coach-k \(.+\)$/);
    assert.throws(() => findMini(root, "sam"));
    assert.equal(minis(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: an unknown name or id names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = miniRemoveBlocker(root, "ghost")!;
    assert.match(blocker, /^Mini not found: "ghost"\. Minis: alex \(.+\), coach-k \(.+\)$/);
    assert.throws(() => findMini(root, "ghost"));
    assert.equal(minis(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-mini-remove-gate-"));
  try {
    assert.equal(miniRemoveBlocker(root, "ghost"), "Mini not found: \"ghost\". Minis: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-mini-remove-gate-"));
  try {
    spawnMini(root, { name: "coach-k", person: "Kaylee", instructions: "Help Kaylee." });
    spawnMini(root, { name: "coach.k", person: "Kay", instructions: "Help Kay." });
    const blocker = miniRemoveBlocker(root, "COACH K")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(minis(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeMini(root, "nope"), false);
    assert.equal(removeMini(root, "alex"), true);
    assert.equal(removeMini(root, "alex"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

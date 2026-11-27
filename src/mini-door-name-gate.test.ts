import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMini } from "./minis.js";
import { issueDoorKey, listDoors, miniDoorBlocker } from "./mini-door.js";

// The mini-door name gate: a door name is a registry name
// ("sam", the core, plus every registered mini) that a
// person picks at the minis door door. issueDoorKey, the
// ONE seam every door key issue rides, refused a bad name
// with the bare "Mini not found": it echoed no value, named
// none of the valid names, and offered NO fold correction,
// so a folded name ("Dip", "Second Shift") dead-ended at
// the door that ISSUES a bearer credential. miniDoorBlocker
// in mini-door.ts is now the ONE source carrying the
// refusal text; issueDoorKey throws it before any key is
// generated or any door row is written. The registry is
// dynamic per install, so a correction is offered only
// when exactly one name matches folded for case and
// separators.

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-door-name-gate-"));
  spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
  spawnMini(root, { name: "second-shift", person: "Second Shift", instructions: "Help the team." });
  return root;
}

test("mini-door name gate: the real names read no blocker", () => {
  const root = scratch();
  try {
    assert.equal(miniDoorBlocker(root, "sam"), null);
    assert.equal(miniDoorBlocker(root, "alex"), null);
    assert.equal(miniDoorBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-door name gate: on an empty install only sam reads no blocker, and the read creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-door-name-gate-empty-"));
  try {
    assert.equal(miniDoorBlocker(root, "sam"), null);
    assert.equal(miniDoorBlocker(root, "alex"), "Unknown mini \"alex\". Minis: sam");
    assert.deepEqual(listDoors(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-door name gate: an unknown name names the registry, no correction", () => {
  const root = scratch();
  try {
    assert.equal(
      miniDoorBlocker(root, "ghost"),
      "Unknown mini \"ghost\". Minis: sam, alex, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-door name gate: a folded name is refused with the correction", () => {
  const root = scratch();
  try {
    assert.match(miniDoorBlocker(root, "Alex")!, /Did you mean "alex"\?$/);
    assert.match(miniDoorBlocker(root, "ALEX")!, /Did you mean "alex"\?$/);
    assert.match(miniDoorBlocker(root, "Second Shift")!, /Did you mean "second-shift"\?$/);
    assert.match(miniDoorBlocker(root, "second_shift")!, /Did you mean "second-shift"\?$/);
    assert.match(miniDoorBlocker(root, "Sam")!, /Did you mean "sam"\?$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-door name gate: a non-string or empty value refuses with no correction", () => {
  const root = scratch();
  try {
    assert.equal(miniDoorBlocker(root, ""), "Unknown mini \"\". Minis: sam, alex, second-shift");
    assert.equal(miniDoorBlocker(root, undefined), "Unknown mini \"undefined\". Minis: sam, alex, second-shift");
    assert.equal(miniDoorBlocker(root, 42), "Unknown mini \"42\". Minis: sam, alex, second-shift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-door name gate: the seam throws the ONE source and issues nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => issueDoorKey(root, "Alex"), /Unknown mini "Alex"\. Minis: sam, alex, second-shift\. Did you mean "alex"\?/);
    assert.throws(() => issueDoorKey(root, "ghost"), /Unknown mini "ghost"\. Minis: sam, alex, second-shift$/);
    // Nothing was issued by the refusals.
    assert.deepEqual(listDoors(root), []);
    // The canonical names still work through the same seam.
    assert.match(issueDoorKey(root, "alex"), /^[0-9a-f]{64}$/);
    assert.match(issueDoorKey(root, "sam"), /^[0-9a-f]{64}$/);
    assert.equal(listDoors(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

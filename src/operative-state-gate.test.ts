import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperativeRegistry, operativeStates, operativeStateBlocker, type OperativeState } from "./operatives.js";

// The operative-state gate: the operative state is a
// registry name (operativeStates in operatives.ts:
// available, paused, offline) that a person types at
// the CLI `operative state` door. The ONE seam every
// state change rides, OperativeRegistry.setState,
// refused a bad state with the bare "Invalid operative
// state" - echoing no value, naming none of the three
// states, and offering no fold correction, so a folded
// name ("Available", "off-line") dead-ended.
// operativeStateBlocker in operatives.ts is now the
// ONE source carrying the refusal text; the CLI door
// throws it before opening the registry and setState
// throws it before its UPDATE. Stored-state readers
// stay permissive by design (a stored operative's
// state is read back as stored).

test("operative state gate: every exact state reads no blocker", () => {
  for (const state of operativeStates) assert.equal(operativeStateBlocker(state), null, state);
  assert.equal(operativeStates.length, 3);
});

test("operative state gate: an unknown state names the states, no correction", () => {
  assert.equal(
    operativeStateBlocker("busy"),
    "Invalid operative state \"busy\". States: available, paused, offline",
  );
});

test("operative state gate: a folded name is refused with the correction", () => {
  assert.match(operativeStateBlocker("Available")!, /Did you mean "available"\?$/);
  assert.match(operativeStateBlocker("off-line")!, /Did you mean "offline"\?$/);
  assert.match(operativeStateBlocker("off_line")!, /Did you mean "offline"\?$/);
  assert.match(operativeStateBlocker("PAUSED")!, /Did you mean "paused"\?$/);
});

test("operative state gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(operativeStateBlocker(42), "Invalid operative state \"42\". States: available, paused, offline");
  assert.equal(operativeStateBlocker(""), "Invalid operative state \"\". States: available, paused, offline");
});

test("operative state gate: the store seam throws the ONE source and changes no state", () => {
  const dir = mkdtempSync(join(tmpdir(), "operative-state-"));
  try {
    const reg = new OperativeRegistry(join(dir, "registry.sqlite"));
    const worker = reg.register({ name: "worker", adapter: "local", capabilities: ["code"] });
    assert.throws(
      () => reg.setState(worker.id, "Available" as OperativeState),
      /Invalid operative state "Available"\. States: available, paused, offline\. Did you mean "available"\?$/,
    );
    assert.equal(reg.list().find(o => o.id === worker.id)!.state, "offline");
    assert.equal(reg.setState(worker.id, "available"), true);
    assert.equal(reg.list().find(o => o.id === worker.id)!.state, "available");
    reg.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

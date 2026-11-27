import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionStore, missionCodeBlocker, normalizeMissionCode } from "./storage.js";

// The mission code gate: a mission is a registry entry (the
// missions this install created, OP-0001, OP-0002, ...) that
// a person picks by code at the mission doors. Every throwing
// door - MissionStore.transition inside the store, and the
// CLI's missionOrThrow / `mission inspect` / `task add` /
// `task list` - improvised the same bare "Mission not found:
// X", naming no registry and offering NO fold correction, so
// a folded code ("op-1", "OP1", a bare "1") dead-ended.
// missionCodeBlocker in storage.ts is now the ONE source
// carrying the refusal text; the doors throw it before
// anything is touched. The registry is dynamic per install,
// so a correction is offered only when exactly one code
// matches folded for case and separators with the numeric
// part's leading zeros stripped (the registry's own
// alphabet: canonical codes are zero-padded).

function scratch(): { root: string; store: MissionStore } {
  const root = mkdtempSync(join(tmpdir(), "sam-mission-code-gate-"));
  const store = new MissionStore(join(root, "missions.db"));
  store.create("First mission");
  store.create("Second mission");
  return { root, store };
}

test("mission code gate: the fold strips case, separators, the OP prefix, and leading zeros", () => {
  assert.equal(normalizeMissionCode("OP-0001"), "1");
  assert.equal(normalizeMissionCode("op-1"), "1");
  assert.equal(normalizeMissionCode("OP1"), "1");
  assert.equal(normalizeMissionCode("op_0001"), "1");
  assert.equal(normalizeMissionCode("1"), "1");
  assert.equal(normalizeMissionCode("OP-0042"), "42");
  assert.equal(normalizeMissionCode("ghost"), "ghost");
});

test("mission code gate: exact codes and ids read no blocker", () => {
  const { root, store } = scratch();
  try {
    const missions = store.list();
    assert.deepEqual(missions.map(m => m.code).sort(), ["OP-0001", "OP-0002"]);
    assert.equal(missionCodeBlocker(missions, "OP-0001"), null);
    assert.equal(missionCodeBlocker(missions, "OP-0002"), null);
    assert.equal(missionCodeBlocker(missions, missions[0]!.id), null);
    // get stays permissive: it resolves code or id as before.
    assert.equal(store.get("OP-0001")!.objective, "First mission");
    assert.equal(store.get(missions.find(m => m.code === "OP-0002")!.id)!.code, "OP-0002");
    assert.equal(store.get("OP-9999"), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("mission code gate: on an empty install every code refuses naming none created", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-mission-code-gate-empty-"));
  const store = new MissionStore(join(root, "missions.db"));
  try {
    assert.equal(missionCodeBlocker(store.list(), "OP-0001"), "Mission not found: \"OP-0001\". Missions: none created");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("mission code gate: an unknown code names the registry, no correction", () => {
  const { root, store } = scratch();
  try {
    assert.equal(
      missionCodeBlocker(store.list(), "OP-9999"),
      "Mission not found: \"OP-9999\". Missions: OP-0001, OP-0002",
    );
    assert.equal(
      missionCodeBlocker(store.list(), "ghost"),
      "Mission not found: \"ghost\". Missions: OP-0001, OP-0002",
    );
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("mission code gate: a folded code is refused with the correction", () => {
  const { root, store } = scratch();
  try {
    const missions = store.list();
    assert.match(missionCodeBlocker(missions, "op-1")!, /Did you mean "OP-0001"\?$/);
    assert.match(missionCodeBlocker(missions, "OP1")!, /Did you mean "OP-0001"\?$/);
    assert.match(missionCodeBlocker(missions, "op_0002")!, /Did you mean "OP-0002"\?$/);
    assert.match(missionCodeBlocker(missions, "1")!, /Did you mean "OP-0001"\?$/);
    assert.match(missionCodeBlocker(missions, "op 2")!, /Did you mean "OP-0002"\?$/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("mission code gate: a non-string or empty value refuses with no correction", () => {
  const { root, store } = scratch();
  try {
    const missions = store.list();
    assert.equal(missionCodeBlocker(missions, ""), "Mission not found: \"\". Missions: OP-0001, OP-0002");
    assert.equal(missionCodeBlocker(missions, undefined), "Mission not found: \"undefined\". Missions: OP-0001, OP-0002");
    assert.equal(missionCodeBlocker(missions, 42), "Mission not found: \"42\". Missions: OP-0001, OP-0002");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("mission code gate: the store seam throws the ONE source and touches nothing", () => {
  const { root, store } = scratch();
  try {
    assert.throws(() => store.transition("op-1", "RECON"), /Mission not found: "op-1"\. Missions: OP-0001, OP-0002\. Did you mean "OP-0001"\?/);
    assert.throws(() => store.transition("OP-9999", "RECON"), /Mission not found: "OP-9999"\. Missions: OP-0001, OP-0002$/);
    // Nothing was transitioned by the refusals.
    assert.deepEqual(store.list().map(m => m.status), ["DRAFT", "DRAFT"]);
    // The canonical code still works through the same seam.
    assert.equal(store.transition("OP-0001", "RECON").status, "RECON");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

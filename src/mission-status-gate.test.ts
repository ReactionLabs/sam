import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missionStatuses, missionStatusBlocker, type MissionStatus } from "./kernel.js";
import { MissionStore } from "./storage.js";

// The mission-status gate: the mission status is a registry
// name (missionStatuses in kernel.ts: DRAFT, RECON,
// PLANNING, READY, RUNNING, WAITING_APPROVAL, PAUSING,
// PAUSED, VERIFYING, COMPLETED, FAILED, CANCELLED) that a
// person types at the CLI `mission transition` door. Two
// doors improvised two different refusals for the same
// registry - the CLI's bare "Invalid status: X" and
// MissionStore.transition's "Unknown status: X" - neither
// naming the statuses and neither offering a fold
// correction, so a folded name ("running", "waiting
// approval") dead-ended. missionStatusBlocker in kernel.ts
// is now the ONE source carrying the refusal text; the CLI
// door throws it before opening the store and
// MissionStore.transition throws it before its transaction.
// Stored-status readers stay permissive by design (a stored
// mission's status is read back as stored).

test("mission status gate: every exact status reads no blocker", () => {
  for (const status of missionStatuses) assert.equal(missionStatusBlocker(status), null, status);
  assert.equal(missionStatuses.length, 12);
});

test("mission status gate: an unknown status names the statuses, no correction", () => {
  assert.equal(
    missionStatusBlocker("ARCHIVED"),
    "Invalid status \"ARCHIVED\". Statuses: DRAFT, RECON, PLANNING, READY, RUNNING, WAITING_APPROVAL, PAUSING, PAUSED, VERIFYING, COMPLETED, FAILED, CANCELLED",
  );
});

test("mission status gate: a folded name is refused with the correction", () => {
  assert.match(missionStatusBlocker("running")!, /Did you mean "RUNNING"\?$/);
  assert.match(missionStatusBlocker("waiting approval")!, /Did you mean "WAITING_APPROVAL"\?$/);
  assert.match(missionStatusBlocker("waiting_approval")!, /Did you mean "WAITING_APPROVAL"\?$/);
  assert.match(missionStatusBlocker("Waiting-Approval")!, /Did you mean "WAITING_APPROVAL"\?$/);
});

test("mission status gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(missionStatusBlocker(42), "Invalid status \"42\". Statuses: DRAFT, RECON, PLANNING, READY, RUNNING, WAITING_APPROVAL, PAUSING, PAUSED, VERIFYING, COMPLETED, FAILED, CANCELLED");
  assert.equal(missionStatusBlocker(""), "Invalid status \"\". Statuses: DRAFT, RECON, PLANNING, READY, RUNNING, WAITING_APPROVAL, PAUSING, PAUSED, VERIFYING, COMPLETED, FAILED, CANCELLED");
});

test("mission status gate: the store seam throws the ONE source and touches no mission", () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-status-"));
  const store = new MissionStore(join(dir, "missions.db"));
  try {
    const mission = store.create("gate check");
    assert.throws(
      () => store.transition(mission.code, "running" as MissionStatus),
      /Invalid status "running"\. Statuses: DRAFT, RECON, PLANNING, READY, RUNNING, WAITING_APPROVAL, PAUSING, PAUSED, VERIFYING, COMPLETED, FAILED, CANCELLED\. Did you mean "RUNNING"\?$/,
    );
    assert.equal(store.get(mission.code)!.status, "DRAFT");
    assert.equal(store.transition(mission.code, "RECON").status, "RECON");
  } finally { store.close(); }
});

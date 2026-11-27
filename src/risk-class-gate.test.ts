import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./sqlite.js";
import { MissionStore } from "./storage.js";
import { ApprovalStore, riskClasses, riskClassBlocker, type RiskClass } from "./approvals.js";

// The risk-class gate: the approval risk class is a
// registry name (riskClasses in approvals.ts: LOCAL_WRITE,
// EXTERNAL_WRITE, DESTRUCTIVE, PRODUCTION, FINANCIAL,
// CREDENTIAL) that a person types at the CLI `approval
// request` door. The ONE seam every request rides,
// ApprovalStore.request, refused a bad class with the bare
// "Unknown risk class" - echoing no value, naming none of
// the six classes, and offering no fold correction, so a
// folded name ("financial", "local write") dead-ended.
// riskClassBlocker in approvals.ts is now the ONE source
// carrying the refusal text; the CLI door throws it before
// opening the database and ApprovalStore.request throws
// it before its INSERT. Stored-risk readers stay
// permissive by design (a stored approval's risk is read
// back as stored).

test("risk class gate: every exact class reads no blocker", () => {
  for (const risk of riskClasses) assert.equal(riskClassBlocker(risk), null, risk);
  assert.equal(riskClasses.length, 6);
});

test("risk class gate: an unknown class names the classes, no correction", () => {
  assert.equal(
    riskClassBlocker("NETWORK"),
    "Unknown risk class \"NETWORK\". Risk classes: LOCAL_WRITE, EXTERNAL_WRITE, DESTRUCTIVE, PRODUCTION, FINANCIAL, CREDENTIAL",
  );
});

test("risk class gate: a folded name is refused with the correction", () => {
  assert.match(riskClassBlocker("financial")!, /Did you mean "FINANCIAL"\?$/);
  assert.match(riskClassBlocker("local write")!, /Did you mean "LOCAL_WRITE"\?$/);
  assert.match(riskClassBlocker("local_write")!, /Did you mean "LOCAL_WRITE"\?$/);
  assert.match(riskClassBlocker("External-Write")!, /Did you mean "EXTERNAL_WRITE"\?$/);
});

test("risk class gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(riskClassBlocker(42), "Unknown risk class \"42\". Risk classes: LOCAL_WRITE, EXTERNAL_WRITE, DESTRUCTIVE, PRODUCTION, FINANCIAL, CREDENTIAL");
  assert.equal(riskClassBlocker(""), "Unknown risk class \"\". Risk classes: LOCAL_WRITE, EXTERNAL_WRITE, DESTRUCTIVE, PRODUCTION, FINANCIAL, CREDENTIAL");
});

test("risk class gate: the store seam throws the ONE source and records no approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "risk-class-"));
  try {
    const path = join(dir, "mission.db"), missions = new MissionStore(path), db = openDatabase(path), approvals = new ApprovalStore(db);
    const mission = missions.create("gate check");
    assert.throws(
      () => approvals.request(mission.id, "financial" as RiskClass, { tool: "x" }, 1000, 500),
      /Unknown risk class "financial"\. Risk classes: LOCAL_WRITE, EXTERNAL_WRITE, DESTRUCTIVE, PRODUCTION, FINANCIAL, CREDENTIAL\. Did you mean "FINANCIAL"\?$/,
    );
    assert.equal(approvals.list(mission.id).length, 0);
    const ok = approvals.request(mission.id, "FINANCIAL", { tool: "x" }, 1000, 500);
    assert.equal(ok.risk, "FINANCIAL");
    assert.equal(approvals.list(mission.id).length, 1);
    db.close(); missions.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

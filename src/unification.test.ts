import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./sqlite.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROPOSED_CUT, unificationReport } from "./unification.js";
import { ApprovalStore } from "./approvals.js";
import { MissionStore } from "./storage.js";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "sam-unification-"));
  mkdirSync(join(dir, ".sam"), { recursive: true });
  return dir;
}

test("unification audit: an empty install reads dormant on both legacy stores", () => {
  const dir = scratch();
  try {
    const report = unificationReport(dir);
    assert.equal(report.liveGate.store, "actions");
    assert.equal(report.liveGate.total, 0);
    assert.equal(report.legacyGate.dbPresent, false);
    assert.equal(report.legacyGate.approvalsTablePresent, false);
    assert.equal(report.legacyGate.missions, 0);
    assert.equal(report.legacyGate.approvals, 0);
    assert.equal(report.legacyGate.cliOnly, true);
    assert.equal(report.legacyGate.decideDoor, false);
    assert.equal(report.legacySchedules.present, false);
    assert.equal(report.legacySchedules.count, 0);
    assert.equal(report.legacySchedules.executed, false);
    assert.equal(report.liveJobs.heartbeatJobs, 0);
    assert.equal(report.liveJobs.backgroundTasks, 0);
    assert.equal(report.verdict, "awaiting-owner-ruling");
    assert.equal(report.proposedCut, PROPOSED_CUT);
    assert.ok(PROPOSED_CUT.some(step => /ApprovalStore/.test(step)));
    assert.ok(PROPOSED_CUT.some(step => /schedules\.json/.test(step)));
    // The audit is read-only: it must not have created the legacy db.
    assert.equal(existsSync(join(dir, ".sam", "missions.db")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unification audit: counts the live gate from the actions store", () => {
  const dir = scratch();
  try {
    const actions = [
      { id: "1", actor: "sam", kind: "note", title: "a", detail: "d", status: "done", createdAt: "2026-11-10T00:00:00.000Z", decidedAt: null, result: null, chatId: null, supersedes: null, risk: null, decidedBy: null },
      { id: "2", actor: "sam", kind: "law", title: "b", detail: "d", status: "pending", createdAt: "2026-11-10T00:00:00.000Z", decidedAt: null, result: null, chatId: null, supersedes: null, risk: null, decidedBy: null },
      { id: "3", actor: "sam", kind: "law", title: "c", detail: "d", status: "rejected", createdAt: "2026-11-10T00:00:00.000Z", decidedAt: null, result: null, chatId: null, supersedes: null, risk: null, decidedBy: null },
    ];
    writeFileSync(join(dir, ".sam", "actions.json"), JSON.stringify(actions));
    const report = unificationReport(dir);
    assert.equal(report.liveGate.total, 3);
    assert.equal(report.liveGate.pending, 1);
    assert.equal(report.liveGate.done, 1);
    assert.equal(report.liveGate.rejected, 1);
    assert.equal(report.liveGate.failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unification audit: a missions db without an approvals table stays table-less after the read", () => {
  const dir = scratch();
  try {
    const dbPath = join(dir, ".sam", "missions.db");
    const missions = new MissionStore(dbPath);
    missions.close();
    const report = unificationReport(dir);
    assert.equal(report.legacyGate.dbPresent, true);
    assert.equal(report.legacyGate.approvalsTablePresent, false);
    assert.equal(report.legacyGate.approvals, 0);
    // Read-only proof: opening the audit must not run the legacy
    // store's constructor, so the table still does not exist.
    const db = openDatabase(dbPath, { readonly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
      assert.equal(names.includes("approvals"), false);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unification audit: legacy approvals are counted by status when the table exists", () => {
  const dir = scratch();
  try {
    const dbPath = join(dir, ".sam", "missions.db");
    const missions = new MissionStore(dbPath);
    const mission = missions.create("Audit fixture");
    const db = openDatabase(dbPath);
    const approvals = new ApprovalStore(db);
    const action = { tool: "demo", args: { title: "x" } };
    const first = approvals.request(mission.id, "EXTERNAL_WRITE", action, 1000, 5000);
    approvals.request(mission.id, "LOCAL_WRITE", action, 1000, 5000);
    approvals.decide(first.id, "owner", true, 1100);
    db.close();
    missions.close();
    const report = unificationReport(dir);
    assert.equal(report.legacyGate.approvalsTablePresent, true);
    assert.equal(report.legacyGate.missions, 1);
    assert.equal(report.legacyGate.approvals, 2);
    assert.equal(report.legacyGate.approvalsByStatus.APPROVED, 1);
    assert.equal(report.legacyGate.approvalsByStatus.PENDING, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unification audit: the legacy schedule store is counted and never reads as executed", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, ".sam", "schedules.json"), JSON.stringify([
      { id: "a", name: "one", minutes: 60, enabled: true, lastRun: null },
      { id: "b", name: "two", minutes: 30, enabled: true, lastRun: null },
    ]));
    const report = unificationReport(dir);
    assert.equal(report.legacySchedules.present, true);
    assert.equal(report.legacySchedules.count, 2);
    assert.equal(report.legacySchedules.executed, false);
    // A malformed store reads as present-but-uncountable, never as zero.
    writeFileSync(join(dir, ".sam", "schedules.json"), "{not json");
    const broken = unificationReport(dir);
    assert.equal(broken.legacySchedules.present, true);
    assert.equal(broken.legacySchedules.count, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one gate guard: no live surface imports the legacy ApprovalStore", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Tests run from dist/, so these read the compiled live surfaces.
  for (const surface of ["agent-turn.js", "own-tools.js", "connector-chat.js", "heartbeat.js", "background.js", "dashboard.js"]) {
    const source = readFileSync(join(here, surface), "utf8");
    assert.doesNotMatch(source, /ApprovalStore/, surface + " must not consume the legacy approvals ledger");
    assert.doesNotMatch(source, /approvals\.js/, surface + " must not import approvals.js");
  }
});

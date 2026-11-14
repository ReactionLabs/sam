import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTeamMember, listTeamMembers, listTeamRuns, removeTeamMember, runStandingTeam,
  teamStatus, updateTeamMember, updateTeamRun,
  type StandingMember, type TeamRunRecord,
} from "./team-runtime.js";
import { OperativeRegistry } from "./operatives.js";

// State convergence (UNIFICATION item 4, thirty-fifth store):
// the standing-team registries migrated from whole-file
// team-members.json / team-runs.json rewrites to one-row-per-
// record SQLite (.sam/team.db, two tables). These tests pin
// the migration contract: legacy files import independently
// in order with every field intact, are renamed (never
// deleted), a malformed file imports nothing and stays put, a
// pure read creates nothing, single-row mutations cannot lose
// each other, and a removal / a finished run over migrated
// legacy records persists in the DB.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-team-store-")); }

function legacyMember(name: string, extra: Partial<StandingMember> = {}): StandingMember {
  return {
    name, role: "builder", capabilities: ["build"], tools: ["sam_memory_list"],
    model: "builder-model", budget: { maxCalls: 4 }, ...extra,
  };
}
function legacyRun(id: string, extra: Partial<TeamRunRecord> = {}): TeamRunRecord {
  return {
    id, lead: "sam", task: "Build the widget", status: "done", worker: "ada", reviewer: "cy",
    workerModel: "builder-model", reviewerModel: "reviewer-model", rounds: 1, calls: 2,
    budget: { maxRounds: 3, maxCalls: 8 }, verdict: "approve", result: "Built.",
    createdAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:05:00.000Z", chatId: null, ...extra,
  };
}

test("team store: legacy team-members.json and team-runs.json import independently in order, fields intact, files renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const ada = legacyMember("ada");
    const cy = legacyMember("cy", { role: "reviewer", capabilities: ["review"], tools: [], model: "reviewer-model" });
    const run1 = legacyRun("run-1");
    const run2 = legacyRun("run-2", { status: "blocked", verdict: "request-changes", result: null, finishedAt: null });
    writeFileSync(join(root, ".sam", "team-members.json"), JSON.stringify([ada, cy], null, 2));
    writeFileSync(join(root, ".sam", "team-runs.json"), JSON.stringify([run1, run2], null, 2));
    assert.deepEqual(listTeamMembers(root), [ada, cy]);
    assert.deepEqual(listTeamRuns(root), [run1, run2]);
    assert.equal(existsSync(join(root, ".sam", "team.db")), true);
    assert.equal(existsSync(join(root, ".sam", "team-members.json")), false);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json")), false);
    assert.equal(existsSync(join(root, ".sam", "team-members.json.migrated")), true);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json.migrated")), true);
    const keptMembers = JSON.parse(readFileSync(join(root, ".sam", "team-members.json.migrated"), "utf8")) as unknown[];
    assert.equal(keptMembers.length, 2);
    // New members ride the DB and never recreate the JSON files.
    addTeamMember(root, { name: "bea", role: "researcher", model: "research-model" });
    assert.deepEqual(listTeamMembers(root).map(m => m.name), ["ada", "cy", "bea"]);
    assert.equal(existsSync(join(root, ".sam", "team-members.json")), false);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team store: a malformed or non-array legacy file imports nothing and is left in place (each file independent)", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "team-members.json"), "{ not json");
    writeFileSync(join(root, ".sam", "team-runs.json"), JSON.stringify({ nope: true }));
    assert.deepEqual(listTeamMembers(root), []);
    assert.deepEqual(listTeamRuns(root), []);
    assert.equal(existsSync(join(root, ".sam", "team-members.json")), true);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json")), true);
    assert.equal(existsSync(join(root, ".sam", "team-members.json.migrated")), false);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json.migrated")), false);
    // A healthy members file beside a malformed runs file still imports.
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "team-members.json"), JSON.stringify([legacyMember("ada")]));
      writeFileSync(join(root2, ".sam", "team-runs.json"), "not json at all");
      assert.deepEqual(listTeamMembers(root2).map(m => m.name), ["ada"]);
      assert.deepEqual(listTeamRuns(root2), []);
      assert.equal(existsSync(join(root2, ".sam", "team-members.json.migrated")), true);
      assert.equal(existsSync(join(root2, ".sam", "team-runs.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listTeamMembers(root), []);
    assert.deepEqual(listTeamRuns(root), []);
    assert.deepEqual(teamStatus(root), { members: [], runs: [], messages: [] });
    assert.equal(updateTeamMember(root, "nope", { model: "x" }), null);
    assert.equal(updateTeamRun(root, "nope", { status: "done" }), null);
    assert.equal(removeTeamMember(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team store: interleaved member adds and single-row updates all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    addTeamMember(root, { name: "ada", role: "builder", model: "builder-model", tools: ["sam_memory_list"] });
    addTeamMember(root, { name: "cy", role: "reviewer", model: "reviewer-model" });
    const patched = updateTeamMember(root, "ada", { model: "builder-model-v2" });
    assert.equal(patched?.model, "builder-model-v2");
    assert.equal(patched?.name, "ada");
    assert.equal(updateTeamMember(root, "ghost", { model: "x" }), null);
    // The key cannot be patched away.
    assert.equal(updateTeamMember(root, "ada", { name: "mallory" } as Partial<StandingMember>)?.name, "ada");
    const members = listTeamMembers(root);
    assert.deepEqual(members.map(m => m.name), ["ada", "cy"]);
    assert.equal(members[0].model, "builder-model-v2");
    assert.equal(members[1].model, "reviewer-model");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team store: a removal over a migrated legacy member persists, and a standing run's finish is a single-row update", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "team-members.json"), JSON.stringify([
      legacyMember("ada"),
      legacyMember("bea", { role: "researcher", capabilities: ["research"] }),
      legacyMember("cy", { role: "reviewer", capabilities: ["review"], tools: [], model: "reviewer-model" }),
    ], null, 2));
    assert.equal(removeTeamMember(root, "bea"), true);
    assert.deepEqual(listTeamMembers(root).map(m => m.name), ["ada", "cy"]);
    assert.equal(removeTeamMember(root, "bea"), false);
    assert.equal(existsSync(join(root, ".sam", "team-members.json")), false);
    assert.equal(existsSync(join(root, ".sam", "team.db")), true);
    // A full standing run rides the DB: creation inserts, the
    // finish updates exactly its row, and a later patch sticks.
    // (A real legacy install's members carry operative
    // registrations from their addTeamMember calls; register
    // them here as that install would have.)
    const reg = new OperativeRegistry(join(root, ".sam", "missions.db"));
    try {
      reg.register({ name: "ada", adapter: "team", capabilities: ["build"], maxConcurrency: 1 });
      reg.register({ name: "cy", adapter: "team", capabilities: ["review"], maxConcurrency: 1 });
    } finally { reg.close(); }
    const run = await runStandingTeam(root, "Build the widget", {
      complete: async (input) => input.member.role === "reviewer" ? "VERDICT: approve\nGood." : "Built the widget.",
    });
    assert.equal(run.status, "done");
    const runs = listTeamRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].status, "done");
    assert.equal(runs[0].verdict, "approve");
    const patched = updateTeamRun(root, run.id, { result: "Built, confirmed." });
    assert.equal(patched?.result, "Built, confirmed.");
    assert.equal(listTeamRuns(root)[0].result, "Built, confirmed.");
    assert.equal(updateTeamRun(root, "ghost", { status: "failed" }), null);
    assert.equal(existsSync(join(root, ".sam", "team-runs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

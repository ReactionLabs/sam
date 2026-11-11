import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curateSkills, curatorFindings, readCuratorState, renderSkillMarkdown, runSkillCurator, type CuratorFinding, type CuratorState } from "./skill-author.js";
import { readActivity } from "./activity.js";

// State convergence (UNIFICATION item 4, twenty-second store): the
// skill curator's findings state migrated from whole-file
// skill-curator.json rewrites (every consolidation tick, every CLI
// curator run) to a one-row SQLite singleton. These tests pin the
// migration contract: a legacy file imports with every field
// intact, is renamed (never deleted), a malformed file imports
// nothing and stays put, a pure read creates nothing, the
// changed-set hash persists through the DB so a standing finding
// set ledgers exactly once, and a run over a migrated legacy
// state whose hash already matches stays unchanged.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-curator-store-")); }

const FINDING: CuratorFinding = {
  id: "duplicate-content:web-one+web-two",
  kind: "duplicate-content",
  skills: ["web-one", "web-two"],
  detail: "Skills \"web-one\" and \"web-two\" carry identical instructions under different names.",
  suggestedPatch: "Keep one canonical skill and remove or merge the other.",
};
const BODY_A = "First gather the evidence from the source system. Then compare it against the previous record. Then write down only the differences, each with its number attached so the reader can check it.";
function hashOf(findings: CuratorFinding[]): string {
  return createHash("sha256").update(findings.map(f => f.id).join(",")).digest("hex");
}
function placeSkill(root: string, dir: string, name: string, description: string, body: string): void {
  const target = join(root, ".agents/skills", dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), renderSkillMarkdown({ name, description, instructions: body }));
}
function placeDuplicatePair(root: string): void {
  placeSkill(root, "web-one", "web-one", "Check the public web for current facts and sources", BODY_A);
  placeSkill(root, "web-two", "web-two", "Morning bakery run checklist for the corner shop", BODY_A);
}

test("skill curator store: a legacy skill-curator.json imports intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy: CuratorState = { lastRun: "2026-11-11T23:01:17.960Z", hash: hashOf([FINDING]), findings: [FINDING] };
    writeFileSync(join(root, ".sam", "skill-curator.json"), JSON.stringify(legacy, null, 2));
    assert.deepEqual(readCuratorState(root), legacy);
    assert.deepEqual(curatorFindings(root), [FINDING]);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.db")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "skill-curator.json.migrated"), "utf8")) as CuratorState;
    assert.deepEqual(kept, legacy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-curator.json"), "{ not json");
    assert.deepEqual(curatorFindings(root), []);
    assert.equal(readCuratorState(root), null);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json.migrated")), false);
    writeFileSync(join(root, ".sam", "skill-curator.json"), JSON.stringify([FINDING]));
    assert.deepEqual(curatorFindings(root), []);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json.migrated")), false);
    const run = runSkillCurator(root);
    assert.deepEqual(run.findings, []);
    const state = readCuratorState(root);
    assert.equal(state?.hash, hashOf([]));
    assert.deepEqual(state?.findings, []);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(curatorFindings(root), []);
    assert.equal(readCuratorState(root), null);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.db")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator store: interleaved runs persist the changed-set hash (a standing set ledgers once)", () => {
  const root = fresh();
  try {
    placeDuplicatePair(root);
    const first = runSkillCurator(root);
    assert.equal(first.changed, true);
    assert.equal(first.findings.length, 1);
    const second = runSkillCurator(root);
    assert.equal(second.changed, false);
    assert.deepEqual(curatorFindings(root), first.findings);
    assert.equal(readCuratorState(root)?.hash, hashOf(first.findings));
    assert.equal(readActivity(root, 10, { kind: "skill-curator" }).length, 1);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator store: a run over a migrated legacy state with a matching hash stays unchanged", () => {
  const root = fresh();
  try {
    placeDuplicatePair(root);
    const real = curateSkills(root);
    assert.equal(real.length, 1);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy: CuratorState = { lastRun: "2026-11-11T23:01:17.960Z", hash: hashOf(real), findings: real };
    writeFileSync(join(root, ".sam", "skill-curator.json"), JSON.stringify(legacy, null, 2));
    const run = runSkillCurator(root);
    assert.equal(run.changed, false);
    assert.equal(run.findings.length, 1);
    assert.equal(readActivity(root, 10, { kind: "skill-curator" }).length, 0);
    const state = readCuratorState(root);
    assert.equal(state?.hash, legacy.hash);
    assert.notEqual(state?.lastRun, legacy.lastRun);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-curator.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

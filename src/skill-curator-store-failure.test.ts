import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  curatorFindings, isSkillCuratorStoreLedgered, readCuratorState,
  renderSkillMarkdown, runSkillCurator, skillCuratorStoreFailureSummary,
  type CuratorFinding, type CuratorState,
} from "./skill-author.js";
import { consolidatePreferences } from "./heartbeat.js";
import { classifyDefect } from "./self-work.js";

// Skill curator store failure visibility (gap found
// 2026-11-15, hourly run 23:04): the skill curator store
// (.sam/skill-curator.db) is the curator's findings state
// (one row: lastRun, the changed-set hash, findings) -
// curatorFindings rides status.ts (dashboard status, CLI
// overview) and the CLI skills views; runSkillCurator
// rides every heartbeat consolidation tick, the CLI
// curator verb, and the sam-curator script job - and
// every touch opened it raw: a dead skill-curator.db
// threw into whichever catch wrapped the call, countable
// only where consolidation's own catch named the
// sub-step. Each touch now ledgers ONE
// skill-curator-store-failed line (phase read / write)
// and rethrows exactly, tagged; every caller's handling
// is unchanged (consolidation still ledgers its own
// consolidate-failed:curator line - one line at each
// seam) and reads still fail closed (never folded as no
// findings, which would hide standing findings dressed
// as a clean library, or reset the hash so a standing
// set re-ledgers every tick).
function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-skill-curator-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

const FINDING: CuratorFinding = {
  id: "duplicate-content:zorblax-one+zorblax-two",
  kind: "duplicate-content",
  skills: ["zorblax-one", "zorblax-two"],
  detail: "Skills \"zorblax-one\" and \"zorblax-two\" carry identical instructions under different names.",
  suggestedPatch: "Keep one canonical zorblax skill and remove the other.",
};
const BODY_A = "First gather the evidence from the source system. Then compare it against the previous record. Then write down only the differences, each with its number attached so the reader can check it.";

function seed(root: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const legacy: CuratorState = { lastRun: "2026-11-11T23:01:17.960Z", hash: "seedhash", findings: [FINDING] };
  writeFileSync(join(root, ".sam", "skill-curator.json"), JSON.stringify(legacy, null, 2));
  assert.deepEqual(curatorFindings(root), [FINDING]);
}

function placeDuplicatePair(root: string): void {
  for (const [dir, name, description] of [
    ["web-one", "web-one", "Check the public web for current facts and sources"],
    ["web-two", "web-two", "Morning bakery run checklist for the corner shop"],
  ] as const) {
    const target = join(root, ".agents/skills", dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), renderSkillMarkdown({ name, description, instructions: BODY_A }));
  }
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-curator-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "skill-curator.db"), { force: true });
  mkdirSync(join(root, ".sam", "skill-curator.db"), { recursive: true });
}

test("skill-curator-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(skillCuratorStoreFailureSummary("read", "unable to open\n  database   file"), "Skill curator store read failed: unable to open database file");
  assert.equal(skillCuratorStoreFailureSummary("write", "disk gone"), "Skill curator store write failed: disk gone");
  assert.equal(skillCuratorStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "skill-curator-store-failed", summary: skillCuratorStoreFailureSummary(phase, "boom") }),
      { key: "skill-curator-store-failed:" + phase, label: "skill curator store failures (" + phase + " step)" },
    );
  }
});

test("skill-curator-store-failed: a healthy run, read-back, and unchanged re-run ledger no failure line", () => {
  const { base, sam } = fresh();
  try {
    placeDuplicatePair(sam);
    const first = runSkillCurator(sam);
    assert.equal(first.changed, true);
    assert.equal(first.findings.length, 1);
    const second = runSkillCurator(sam);
    assert.equal(second.changed, false);
    assert.deepEqual(curatorFindings(sam), first.findings);
    assert.equal(readCuratorState(sam)?.findings.length, 1);
    assert.equal(readActivity(sam, 10, { kind: "skill-curator" }).length, 1, "the changed set ledgers its curator line exactly once");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: an absent store reads as no state, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.equal(readCuratorState(sam), null);
    assert.deepEqual(curatorFindings(sam), []);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    seed(sam);
    const db = openDatabase(join(sam, ".sam", "skill-curator.db"));
    try { db.prepare("UPDATE skill_curator SET data = ? WHERE id = 1").run("{ not json"); } finally { db.close(); }
    assert.equal(readCuratorState(sam), null, "the torn row reads as no state, never fatal");
    assert.deepEqual(curatorFindings(sam), []);
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: a malformed legacy file imports nothing and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "skill-curator.json"), "{ not json");
    assert.deepEqual(curatorFindings(sam), []);
    assert.equal(readCuratorState(sam), null);
    assert.equal(failedLines(sam).length, 0, "a forgiving import is not a store failure");
    assert.equal(existsSync(join(sam, ".sam", "skill-curator.json")), true, "the malformed file is left in place");
    assert.equal(existsSync(join(sam, ".sam", "skill-curator.json.migrated")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no finding content", () => {
  const { base, sam } = fresh();
  try {
    seed(sam);
    plantDeadStore(sam);

    assert.throws(() => readCuratorState(sam), (e: unknown) => isSkillCuratorStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Skill curator store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-curator-store-failed:read", label: "skill curator store failures (read step)" });

    assert.throws(() => curatorFindings(sam), (e: unknown) => isSkillCuratorStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "each separate read touch ledgers exactly one line");

    assert.throws(() => runSkillCurator(sam), (e: unknown) => isSkillCuratorStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 3, "the run dies at its inner prior-state read with exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Skill curator store read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no finding record ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: a failing persist ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    const first = runSkillCurator(sam);
    assert.deepEqual(first.findings, []);
    const raw = openDatabase(join(sam, ".sam", "skill-curator.db"));
    try {
      raw.prepare("DELETE FROM skill_curator WHERE id = 1").run();
      raw.exec("CREATE TRIGGER planted_curator_insert_fail BEFORE INSERT ON skill_curator BEGIN SELECT RAISE(ABORT, 'planted curator write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => runSkillCurator(sam), (e: unknown) => isSkillCuratorStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the persist touch ledgers exactly one line (its prior-state read stayed healthy)");
    assert.ok(lines[0].summary.startsWith("Skill curator store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted curator write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-curator-store-failed:write", label: "skill curator store failures (write step)" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-curator-store-failed: a dead store hit through consolidation ledgers one line at each seam, each exactly once", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam", "skill-curator.db"), { recursive: true });
    const result = consolidatePreferences(sam);
    assert.equal(result.curatorFailed, true);
    assert.deepEqual(result.curator, []);
    const storeLines = failedLines(sam);
    assert.equal(storeLines.length, 1, "the store seam ledgers its own line");
    assert.ok(storeLines[0].summary.startsWith("Skill curator store read failed: "), storeLines[0].summary);
    const subStepLines = readActivity(sam, 100, { kind: "consolidate-failed" });
    assert.equal(subStepLines.length, 1, "the consolidation sub-step seam keeps its own line, unchanged");
    assert.equal(classifyDefect(subStepLines[0])?.key, "consolidate-failed:curator");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

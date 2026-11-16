import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  isSkillAllowlistsStoreLedgered, setSkillAllowlist, skillAllowlist,
  skillAllowlists, skillAllowlistsStoreFailureSummary, skillsForProfile,
  updateSkillAllowlist,
} from "./skills.js";
import { classifyDefect } from "./self-work.js";

// Skill allowlists store failure visibility (gap found
// 2026-11-16, hourly run 00:04): the skill allowlists
// store (.sam/skill-allowlists.db) is the per-profile
// skill fence registry - skillAllowlists rides status.ts
// and self-audit, skillAllowlist rides every chat turn's
// catalog and skill reads plus the CLI skills views, and
// setSkillAllowlist / updateSkillAllowlist are the
// owner's fence-setting doors - and every touch opened
// it raw: a dead store threw with the seam unnamed, and a
// reader folding it as no allowlists would silently
// unrestrict every fenced profile. Each touch now
// ledgers ONE skill-allowlists-store-failed line (phase
// read / write) and rethrows exactly, tagged; reads still
// fail closed and validation errors ledger nothing.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-allowlists-fail-")); }

function skill(root: string, name: string, description: string) {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\nSteps for " + name + ".\n");
}

function seed(root: string): void {
  skill(root, "alpha", "Alpha playbook");
  skill(root, "beta", "Beta playbook");
  assert.deepEqual(setSkillAllowlist(root, "trading", ["alpha"]), ["alpha"]);
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-allowlists-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "skill-allowlists.db"), { force: true });
  mkdirSync(join(root, ".sam", "skill-allowlists.db"), { recursive: true });
}

test("skill-allowlists-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(skillAllowlistsStoreFailureSummary("read", "unable to open\n  database   file"), "Skill allowlists store read failed: unable to open database file");
  assert.equal(skillAllowlistsStoreFailureSummary("write", "disk gone"), "Skill allowlists store write failed: disk gone");
  assert.equal(skillAllowlistsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "skill-allowlists-store-failed", summary: skillAllowlistsStoreFailureSummary(phase, "boom") }),
      { key: "skill-allowlists-store-failed:" + phase, label: "skill allowlists store failures (" + phase + " step)" },
    );
  }
});

test("skill-allowlists-store-failed: healthy set, read-back, update, and clear ledger no failure line", () => {
  const root = fresh();
  try {
    seed(root);
    assert.deepEqual(skillAllowlist(root, "trading"), ["alpha"]);
    assert.deepEqual(skillAllowlists(root), { trading: ["alpha"] });
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha"]);
    assert.deepEqual(updateSkillAllowlist(root, "trading", ["alpha", "beta"]), ["alpha", "beta"]);
    assert.equal(setSkillAllowlist(root, "trading", null), null);
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: an absent store reads as no allowlists, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.equal(updateSkillAllowlist(root, "trading", ["alpha"]), null);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const root = fresh();
  try {
    seed(root);
    const db = openDatabase(join(root, ".sam", "skill-allowlists.db"));
    try { db.prepare("UPDATE skill_allowlists SET data = ? WHERE profile = ?").run("{ not json", "trading"); } finally { db.close(); }
    assert.equal(skillAllowlist(root, "trading"), null, "the torn row reads as no entry, never fatal");
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: a malformed legacy file imports nothing and ledgers nothing", () => {
  const root = fresh();
  try {
    skill(root, "alpha", "Alpha playbook");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-allowlists.json"), "{ not json");
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.equal(failedLines(root).length, 0, "a forgiving import is not a store failure");
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), true, "the malformed file is left in place");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: validation errors ledger nothing", () => {
  const root = fresh();
  try {
    seed(root);
    assert.throws(() => setSkillAllowlist(root, "Trading", ["alpha"]), /Invalid profile/);
    assert.throws(() => setSkillAllowlist(root, "trading", ["gamma"]), /Unknown skill\(s\): gamma/);
    assert.throws(() => updateSkillAllowlist(root, "Trading", ["alpha"]), /Invalid profile/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no fence content", () => {
  const root = fresh();
  try {
    seed(root);
    plantDeadStore(root);

    assert.throws(() => skillAllowlists(root), (e: unknown) => isSkillAllowlistsStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Skill allowlists store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-allowlists-store-failed:read", label: "skill allowlists store failures (read step)" });

    assert.throws(() => skillAllowlist(root, "trading"), (e: unknown) => isSkillAllowlistsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "each separate read touch ledgers exactly one line");

    assert.throws(() => skillsForProfile(root, "trading"), (e: unknown) => isSkillAllowlistsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "a turn-path read rides the same touch and ledgers its own line, never folded as unrestricted");

    assert.throws(() => updateSkillAllowlist(root, "trading", ["alpha"]), (e: unknown) => isSkillAllowlistsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "update dies at its inner existence read with exactly one line, never two for one touch");
    assert.ok(lines[3].summary.startsWith("Skill allowlists store read failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("alpha"), "no allowlist record ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("trading"), "no profile name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-allowlists-store-failed: a failing write ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seed(root);
    const raw = openDatabase(join(root, ".sam", "skill-allowlists.db"));
    try {
      raw.exec("CREATE TRIGGER planted_allowlist_insert_fail BEFORE INSERT ON skill_allowlists BEGIN SELECT RAISE(ABORT, 'planted allowlist write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => setSkillAllowlist(root, "researcher", ["beta"]), (e: unknown) => isSkillAllowlistsStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the write touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Skill allowlists store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted allowlist write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-allowlists-store-failed:write", label: "skill allowlists store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

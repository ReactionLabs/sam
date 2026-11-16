import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  authoredSkills, isSkillAuthorsStoreLedgered, skillAuthorsStoreFailureSummary,
  updateAuthoredSkill, validateSkillDraft, writeAuthoredSkill,
  type AuthoredSkill,
} from "./skill-author.js";
import { classifyDefect } from "./self-work.js";

// Skill authors store failure visibility (gap found
// 2026-11-15, hourly run 22:04): the skill authors store
// (.sam/skill-authors.db) is the authored-skill
// provenance registry - authoredSkills rides status.ts
// (dashboard status, CLI overview), the CLI skills
// authored verb, and the skill curator's orphan check;
// the row writes ride writeAuthoredSkill (the ONE
// gate's approved skill-author executor and the
// operator CLI author verb) and updateAuthoredSkill -
// and every touch opened it raw: a dead
// skill-authors.db threw into whichever catch wrapped
// the call, none naming the store. Each touch now
// ledgers ONE skill-authors-store-failed line (phase
// read / write) and rethrows exactly, tagged; every
// caller's handling is unchanged and reads still fail
// closed (never folded as no authored skills, which
// would silently empty the provenance registry dressed
// as a fresh install and orphan SAM's own skills from
// the one registry that lets SAM patch them).
function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-skill-authors-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

const DESC = "A test skill for the authors store failure checks";
const BODY = "Step one: read the input carefully. Step two: do the work. Step three: verify the result before reporting it.";

function legacyRecord(name: string, version = 1): AuthoredSkill {
  return { name, source: "sam-authored", actor: "sam", version, createdAt: "2026-11-10T05:22:00.000Z", updatedAt: "2026-11-10T05:22:00.000Z" };
}

function seed(root: string, records: AuthoredSkill[]): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "skill-authors.json"), JSON.stringify(records, null, 2));
  assert.deepEqual(authoredSkills(root).map(s => s.name), records.map(s => s.name));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-authors-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "skill-authors.db"), { force: true });
  mkdirSync(join(root, ".sam", "skill-authors.db"), { recursive: true });
}

test("skill-authors-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(skillAuthorsStoreFailureSummary("read", "unable to open\n  database   file"), "Skill authors store read failed: unable to open database file");
  assert.equal(skillAuthorsStoreFailureSummary("write", "disk gone"), "Skill authors store write failed: disk gone");
  assert.equal(skillAuthorsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "skill-authors-store-failed", summary: skillAuthorsStoreFailureSummary(phase, "boom") }),
      { key: "skill-authors-store-failed:" + phase, label: "skill authors store failures (" + phase + " step)" },
    );
  }
});

test("skill-authors-store-failed: a healthy author, read, patch, and update round trip ledgers no failure line", () => {
  const { base, sam } = fresh();
  try {
    const made = writeAuthoredSkill(sam, { name: "alpha-notes", description: DESC, instructions: BODY }, { actor: "sam" });
    assert.equal(made.version, 1);
    assert.deepEqual(authoredSkills(sam).map(s => s.name), ["alpha-notes"]);
    const patched = writeAuthoredSkill(sam, { name: "alpha-notes", description: DESC, instructions: BODY + " Extra step." }, { actor: "sam" });
    assert.equal(patched.version, 2);
    const updated = updateAuthoredSkill(sam, "alpha-notes", { version: 7 });
    assert.equal(updated?.version, 7);
    assert.equal(authoredSkills(sam)[0].version, 7);
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: an absent store reads as no authored skills, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(authoredSkills(sam), []);
    assert.equal(updateAuthoredSkill(sam, "nope", { version: 9 }), null);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacyRecord("alpha-notes")]);
    const db = openDatabase(join(sam, ".sam", "skill-authors.db"));
    try { db.prepare("INSERT INTO skill_authors (name, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.deepEqual(authoredSkills(sam).map(s => s.name), ["alpha-notes"], "the torn row is skipped, the real record still reads");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no authored content", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacyRecord("zorblax-notes")]);
    plantDeadStore(sam);

    assert.throws(() => authoredSkills(sam), (e: unknown) => isSkillAuthorsStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Skill authors store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-authors-store-failed:read", label: "skill authors store failures (read step)" });

    assert.throws(() => updateAuthoredSkill(sam, "zorblax-notes", { version: 9 }), (e: unknown) => isSkillAuthorsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Skill authors store read failed: "), lines[1].summary);

    assert.throws(() => writeAuthoredSkill(sam, { name: "zorblax-notes", description: DESC, instructions: BODY }, { actor: "sam" }), (e: unknown) => isSkillAuthorsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 3, "the author door dies at its find touch with exactly one line");
    assert.ok(lines[2].summary.startsWith("Skill authors store read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no authored record ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: validation errors are not store failures and ledger nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.throws(() => validateSkillDraft({ name: "Bad Name!", description: DESC, instructions: BODY }), (e: unknown) => /Invalid skill name/.test((e as Error).message) && !isSkillAuthorsStoreLedgered(e));
    assert.throws(() => writeAuthoredSkill(sam, { name: "alpha-notes", description: DESC, instructions: "too short" }, { actor: "sam" }), (e: unknown) => /Invalid skill instructions/.test((e as Error).message) && !isSkillAuthorsStoreLedgered(e));
    assert.equal(updateAuthoredSkill(sam, "", { version: 9 }), null);
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "skill-authors.db")), false, "no validation refusal created the store");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacyRecord("alpha-notes")]);
    const raw = openDatabase(join(sam, ".sam", "skill-authors.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON skill_authors BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => writeAuthoredSkill(sam, { name: "beta-checks", description: DESC, instructions: BODY }, { actor: "sam" }), (e: unknown) => isSkillAuthorsStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the upsert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Skill authors store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-authors-store-failed:write", label: "skill authors store failures (write step)" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-authors-store-failed: a failing update touch ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacyRecord("zorblax-notes")]);
    const raw = openDatabase(join(sam, ".sam", "skill-authors.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON skill_authors BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateAuthoredSkill(sam, "zorblax-notes", { version: 9 }), (e: unknown) => isSkillAuthorsStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Skill authors store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no authored record ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

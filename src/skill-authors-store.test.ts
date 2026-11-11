import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredSkills, updateAuthoredSkill, writeAuthoredSkill, type AuthoredSkill } from "./skill-author.js";

// State convergence (UNIFICATION item 4, twenty-first store): the
// authored-skill provenance registry migrated from whole-file
// skill-authors.json rewrites to one-row-per-skill SQLite. These tests
// pin the migration contract: legacy files import in order with every
// field intact, are renamed (never deleted), a malformed file imports
// nothing and stays put, a pure read creates nothing, single-row
// mutations cannot lose each other, and a patch (version bump) over a
// migrated legacy record persists in the DB.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-authors-store-")); }

function legacyRecord(name: string, version = 1): AuthoredSkill {
  return { name, source: "sam-authored", actor: "sam", version, createdAt: "2026-11-10T05:22:00.000Z", updatedAt: "2026-11-10T05:22:00.000Z" };
}
const DESC = "A test skill for the authors store migration checks";
const BODY = "Step one: read the input carefully. Step two: do the work. Step three: verify the result before reporting it.";

test("skill authors store: a legacy skill-authors.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyRecord("alpha-notes");
    const second = legacyRecord("beta-checks", 3);
    writeFileSync(join(root, ".sam", "skill-authors.json"), JSON.stringify([first, second], null, 2));
    const items = authoredSkills(root);
    assert.deepEqual(items.map(s => s.name), [first.name, second.name]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.db")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "skill-authors.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    const made = writeAuthoredSkill(root, { name: "gamma-flow", description: DESC, instructions: BODY }, { actor: "sam" });
    assert.equal(made.version, 1);
    assert.deepEqual(authoredSkills(root).map(s => s.name), [first.name, second.name, "gamma-flow"]);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill authors store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-authors.json"), "{ not json");
    assert.deepEqual(authoredSkills(root), []);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json.migrated")), false);
    writeFileSync(join(root, ".sam", "skill-authors.json"), JSON.stringify({ name: "x" }));
    assert.deepEqual(authoredSkills(root), []);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json.migrated")), false);
    const made = writeAuthoredSkill(root, { name: "gamma-flow", description: DESC, instructions: BODY }, { actor: "sam" });
    assert.equal(made.version, 1);
    assert.deepEqual(authoredSkills(root).map(s => s.name), ["gamma-flow"]);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill authors store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(authoredSkills(root), []);
    assert.equal(updateAuthoredSkill(root, "nope", { version: 9 }), null);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.db")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill authors store: interleaved author and update all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    writeAuthoredSkill(root, { name: "alpha-notes", description: DESC, instructions: BODY }, { actor: "sam" });
    writeAuthoredSkill(root, { name: "beta-checks", description: DESC, instructions: BODY }, { actor: "sam" });
    const patched = updateAuthoredSkill(root, "alpha-notes", { version: 7, name: "renamed" });
    assert.equal(patched?.version, 7);
    assert.equal(patched?.name, "alpha-notes");
    assert.equal(updateAuthoredSkill(root, "ghost", { version: 1 }), null);
    const items = authoredSkills(root);
    assert.deepEqual(items.map(s => s.name), ["alpha-notes", "beta-checks"]);
    assert.equal(items[0].version, 7);
    assert.equal(items[1].version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill authors store: a patch over a migrated legacy record persists its version bump in the DB", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = legacyRecord("alpha-notes", 2);
    writeFileSync(join(root, ".sam", "skill-authors.json"), JSON.stringify([legacy], null, 2));
    assert.deepEqual(authoredSkills(root).map(s => s.name), [legacy.name]);
    const patched = writeAuthoredSkill(root, { name: "alpha-notes", description: DESC, instructions: BODY + " Extra step." }, { actor: "sam" });
    assert.equal(patched.version, 3);
    assert.equal(patched.createdAt, legacy.createdAt);
    assert.deepEqual(authoredSkills(root).map(s => [s.name, s.version]), [["alpha-notes", 3]]);
    writeAuthoredSkill(root, { name: "beta-checks", description: DESC, instructions: BODY }, { actor: "sam" });
    assert.deepEqual(authoredSkills(root).map(s => [s.name, s.version]), [["alpha-notes", 3], ["beta-checks", 1]]);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-authors.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

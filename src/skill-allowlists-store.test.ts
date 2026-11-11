import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillForProfile, setSkillAllowlist, skillAllowlist, skillAllowlists, skillsForProfile, updateSkillAllowlist } from "./skills.js";

// State convergence (UNIFICATION item 4, eighteenth store): the
// per-profile skill allowlist registry migrated from whole-file
// skill-allowlists.json rewrites to one-row-per-profile SQLite.
// These tests pin the migration contract: legacy files import in
// order with every entry intact, are renamed (never deleted), a
// malformed / non-object file imports nothing and stays put, a
// pure read creates nothing, single-row mutations cannot lose
// each other, and the fence over a migrated legacy entry persists
// (the fence shape).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-allowlists-store-")); }

function skill(root: string, name: string, description: string) {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\nSteps for " + name + ".\n");
}

test("skill allowlists store: a legacy skill-allowlists.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    skill(root, "alpha", "Alpha playbook");
    skill(root, "beta", "Beta playbook");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-allowlists.json"), JSON.stringify({ trading: ["alpha"], researcher: [] }, null, 2));
    const all = skillAllowlists(root);
    assert.deepEqual(Object.keys(all), ["trading", "researcher"]);
    assert.deepEqual(all.trading, ["alpha"]);
    assert.deepEqual(all.researcher, []);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.db")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "skill-allowlists.json.migrated"), "utf8")) as Record<string, string[]>;
    assert.deepEqual(kept, { trading: ["alpha"], researcher: [] });
    // The fence rides the migrated rows immediately.
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha"]);
    assert.deepEqual(skillsForProfile(root, "researcher"), []);
    assert.throws(() => readSkillForProfile(root, "trading", "beta"), /not on profile trading's allowlist/);
    const added = setSkillAllowlist(root, "second-shift", ["beta"]);
    assert.deepEqual(added, ["beta"]);
    assert.deepEqual(Object.keys(skillAllowlists(root)), ["trading", "researcher", "second-shift"]);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlists store: a malformed or non-object legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    skill(root, "alpha", "Alpha playbook");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-allowlists.json"), "{ not json");
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json.migrated")), false);
    writeFileSync(join(root, ".sam", "skill-allowlists.json"), JSON.stringify(["trading"]));
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json.migrated")), false);
    // A fresh set over the unimportable file still lands in the DB.
    setSkillAllowlist(root, "trading", ["alpha"]);
    assert.deepEqual(skillAllowlist(root, "trading"), ["alpha"]);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlists store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(skillAllowlists(root), {});
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.equal(updateSkillAllowlist(root, "trading", ["alpha"]), null);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.db")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlists store: interleaved set, update, and clear all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    skill(root, "alpha", "Alpha playbook");
    skill(root, "beta", "Beta playbook");
    setSkillAllowlist(root, "trading", ["alpha"]);
    setSkillAllowlist(root, "researcher", ["beta"]);
    const patched = updateSkillAllowlist(root, "trading", ["alpha", "beta"]);
    assert.deepEqual(patched, ["alpha", "beta"]);
    assert.deepEqual(skillAllowlist(root, "researcher"), ["beta"]);
    assert.equal(updateSkillAllowlist(root, "ghost", ["alpha"]), null);
    assert.throws(() => updateSkillAllowlist(root, "trading", ["gamma"]), /Unknown skill\(s\): gamma/);
    assert.throws(() => setSkillAllowlist(root, "Trading", ["alpha"]), /Invalid profile/);
    setSkillAllowlist(root, "researcher", null);
    assert.equal(skillAllowlist(root, "researcher"), null);
    assert.deepEqual(skillAllowlist(root, "trading"), ["alpha", "beta"]);
    assert.deepEqual(Object.keys(skillAllowlists(root)), ["trading"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlists store: a fence set over a migrated legacy entry persists, and clearing it restores unrestricted", () => {
  const root = fresh();
  try {
    skill(root, "alpha", "Alpha playbook");
    skill(root, "beta", "Beta playbook");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-allowlists.json"), JSON.stringify({ trading: ["alpha"] }, null, 2));
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha"]);
    const widened = updateSkillAllowlist(root, "trading", ["beta"]);
    assert.deepEqual(widened, ["beta"]);
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["beta"]);
    assert.match(readSkillForProfile(root, "trading", "beta").instructions, /Steps for beta/);
    setSkillAllowlist(root, "trading", null);
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha", "beta"]);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-allowlists.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

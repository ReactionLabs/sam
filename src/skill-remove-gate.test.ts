import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstalledSkill, installedSkills, removeInstalledSkill, skillRemoveBlocker } from "./skill-registry.js";

// The skill gate for the remove door: registry-installed
// skills are installed by exact name and listed by that
// name, and every sibling registry's remove door
// (channels, heartbeats, vault, minis, team members,
// contacts) reads its registry through a fold-corrected
// ONE source, but `sam skills remove <name>` rode
// removeInstalledSkill alone - its description said only
// that hand-placed skills are never touched - so an
// unknown name, or a folded one ("AlphaSkill" or
// "alpha_skill" for the installed alpha-skill), silently
// returned {removed:false}, naming nothing, and at the
// door that deletes a registry-installed skill's files
// AND its provenance record the owner could not tell a
// fold or a typo from a genuinely absent skill. The CLI
// remove door now resolves through findInstalledSkill
// (throwing skillRemoveBlocker, the ONE source naming
// the registry with a fold correction, before anything
// is removed) and removes by the resolved name;
// removeInstalledSkill keeps its boolean contract (false
// on a miss) for internal callers - the store seam stays
// permissive by design. Seeding rides the store's own
// legacy JSON import (skill-installs.json is imported on
// first open), so no network install is needed.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-skill-remove-gate-"));
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([
    { name: "alpha-skill", source: "acme/widgets", ref: "acme/widgets@alpha-skill", files: 3, installedAt: "2026-11-28T00:00:00.000Z", actor: "operator" },
    { name: "beta-skill", source: "acme/widgets", ref: "acme/widgets@beta-skill", files: 1, installedAt: "2026-11-28T00:00:00.000Z", actor: "operator" },
  ]));
  return root;
}

test("skill remove gate: an exact installed name reads no blocker and removes by the resolved name", () => {
  const root = fresh();
  try {
    assert.equal(skillRemoveBlocker(root, "alpha-skill"), null);
    const resolved = findInstalledSkill(root, "alpha-skill");
    assert.equal(resolved.name, "alpha-skill");
    assert.equal(removeInstalledSkill(root, resolved.name), true);
    assert.deepEqual(installedSkills(root).map(s => s.name), ["beta-skill"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const blocker = skillRemoveBlocker(root, "AlphaSkill")!;
    assert.equal(
      blocker,
      "Installed skill not found: \"AlphaSkill\". Registry-installed skills: alpha-skill, beta-skill. Did you mean \"alpha-skill\"?",
    );
    assert.throws(() => findInstalledSkill(root, "AlphaSkill"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // skill is still registered afterwards.
    assert.deepEqual(installedSkills(root).map(s => s.name), ["alpha-skill", "beta-skill"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: an underscore-folded name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = skillRemoveBlocker(root, "beta_skill")!;
    assert.match(blocker, /Did you mean "beta-skill"\?$/);
    assert.deepEqual(installedSkills(root).map(s => s.name), ["alpha-skill", "beta-skill"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: an unknown name names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = skillRemoveBlocker(root, "ghost")!;
    assert.equal(blocker, "Installed skill not found: \"ghost\". Registry-installed skills: alpha-skill, beta-skill");
    assert.throws(() => findInstalledSkill(root, "ghost"));
    assert.equal(installedSkills(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-skill-remove-gate-"));
  try {
    assert.equal(skillRemoveBlocker(root, "ghost"), "Installed skill not found: \"ghost\". Registry-installed skills: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-skill-remove-gate-"));
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([
      { name: "a-bc", source: "acme/widgets", ref: "acme/widgets@a-bc", files: 1, installedAt: "2026-11-28T00:00:00.000Z", actor: "operator" },
      { name: "ab-c", source: "acme/widgets", ref: "acme/widgets@ab-c", files: 1, installedAt: "2026-11-28T00:00:00.000Z", actor: "operator" },
    ]));
    const blocker = skillRemoveBlocker(root, "ABC")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(installedSkills(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeInstalledSkill(root, "nope"), false);
    assert.equal(removeInstalledSkill(root, "beta-skill"), true);
    assert.equal(removeInstalledSkill(root, "beta-skill"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

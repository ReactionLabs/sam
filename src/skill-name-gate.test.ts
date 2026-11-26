import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkill, readSkill, setSkillAllowlist, skillNameBlocker } from "./skills.js";
import { ChatStore } from "./chats.js";

// The skill-name gate for the skill doors: every other
// naming door reads its registry through a ONE source in
// its owning module before acting - but the installed
// skill name was refused by findSkill with the bare
// "Skill not found: X" (no registry, no fold correction),
// readSkill refused a folded name on its format check,
// and the allowlist door listed the registry with no
// correction. skillNameBlocker in skills.ts is now the
// ONE source carrying the refusal text: findSkill throws
// it, readSkill throws it for a malformed name that folds
// to exactly one installed skill, and the allowlist
// refusal appends the same fold correction.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-skill-name-gate-"));
  for (const [dir, name, description] of [
    ["alpha", "alpha", "Alpha skill"],
    ["git-commit", "git-commit", "Commit help"],
  ] as const) {
    const d = join(root, "skills", dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\nBody of " + name + ".\n");
  }
  const store = new ChatStore(root);
  try { store.createAgent("trading", "Trade."); } finally { store.close(); }
  return root;
}

test("skill name gate: every installed skill reads no blocker", () => {
  const root = fresh();
  try {
    assert.equal(skillNameBlocker(root, "alpha"), null);
    assert.equal(skillNameBlocker(root, "git-commit"), null);
    assert.equal(findSkill(root, "alpha").name, "alpha");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill name gate: an unknown name names the registry", () => {
  const root = fresh();
  try {
    assert.equal(
      skillNameBlocker(root, "gamma"),
      "Skill not found: \"gamma\". Installed skills: alpha, git-commit",
    );
    assert.throws(() => findSkill(root, "gamma"), (e: unknown) => e instanceof Error && e.message === skillNameBlocker(root, "gamma"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill name gate: a folded name is refused with the correction", () => {
  const root = fresh();
  try {
    assert.equal(
      skillNameBlocker(root, "Git Commit"),
      "Skill not found: \"Git Commit\". Installed skills: alpha, git-commit. Did you mean \"git-commit\"?",
    );
    assert.equal(
      skillNameBlocker(root, "ALPHA"),
      "Skill not found: \"ALPHA\". Installed skills: alpha, git-commit. Did you mean \"alpha\"?",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill name gate: readSkill throws the ONE source for a folded malformed name, and keeps Invalid for one that folds to nothing", () => {
  const root = fresh();
  try {
    assert.throws(() => readSkill(root, "Git Commit"), (e: unknown) => e instanceof Error && e.message === skillNameBlocker(root, "Git Commit"));
    assert.throws(() => readSkill(root, "Bad Name!"), /^Error: Invalid skill name$/);
    assert.equal(readSkill(root, "git-commit").name, "git-commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill name gate: the allowlist refusal appends the same fold correction", () => {
  const root = fresh();
  try {
    assert.throws(() => setSkillAllowlist(root, "trading", ["Git Commit"]), /Unknown skill\(s\): Git Commit\. Installed skills: alpha, git-commit\. Did you mean "git-commit"\?/);
    assert.throws(() => setSkillAllowlist(root, "trading", ["gamma"]), /Unknown skill\(s\): gamma\. Installed skills: alpha, git-commit$/);
    assert.deepEqual(setSkillAllowlist(root, "trading", ["alpha"]), ["alpha"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

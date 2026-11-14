import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  recordSkillCatalogFailure, skillCatalogFailureSummary, skillCatalogForPrompt,
} from "./own-tools.js";
import { classifyDefect } from "./self-work.js";

// Skill catalog failure visibility (gap found 2026-11-14,
// hourly run 05:04): skillCatalogForPrompt wrapped its whole
// discovery touch in one bare catch returning "" - the exact
// string an install with NO skills returns - so a dead
// discovery stripped the entire catalog (auto-selection
// directive and installed names) from every turn's system
// prompt, indistinguishable from an empty library, with no
// line anywhere. The failed touch now ledgers ONE
// skill-catalog-failed line and still returns "" exactly as
// before; an empty library returns "" with no line.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skillcatalog-fail-"));
}

function seedSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n" + body);
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-catalog-failed" });
}

test("skill-catalog-failed: summary shape collapses and caps the reason, and self-work classifies by phase", () => {
  const summary = skillCatalogFailureSummary("dip", "unable to open\n  database   file");
  assert.equal(summary, "Skill catalog assemble failed for dip: unable to open database file");
  const long = skillCatalogFailureSummary("sam", "x".repeat(500));
  assert.equal(long.length, 200);
  const root = scratch();
  try {
    recordSkillCatalogFailure(root, "dip", new Error("allowlist store is a directory"));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "dip");
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-catalog-failed:assemble", label: "skill catalog failures (assemble step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-catalog-failed: a dead allowlist store returns the empty catalog with exactly one line naming the actor", () => {
  const root = scratch();
  try {
    seedSkill(root, "agent-reach", "Reach the public web", "SECRET-BODY-TEXT");
    // Plant a directory where the allowlist database belongs:
    // every open of that path throws, the dead-store shape.
    mkdirSync(join(root, ".sam", "skill-allowlists.db"), { recursive: true });
    const line = skillCatalogForPrompt(root, "dip");
    assert.equal(line, "", "a failed discovery reads exactly as an empty catalog does, as before");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed assembly");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Skill catalog assemble failed for dip: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("agent-reach"), "no skill name enters the failure line");
    assert.ok(!lines[0].summary.includes("SECRET-BODY-TEXT"), "no skill content enters the failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-catalog-failed: an empty library and a healthy catalog both ledger nothing", () => {
  const root = scratch();
  try {
    assert.equal(skillCatalogForPrompt(root), "");
    assert.equal(skillCatalogForPrompt(root, "dip"), "");
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    seedSkill(root, "agent-reach", "Reach the public web", "Step one: run the reach check.");
    const line = skillCatalogForPrompt(root, "dip");
    assert.match(line, /agent-reach: Reach the public web/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

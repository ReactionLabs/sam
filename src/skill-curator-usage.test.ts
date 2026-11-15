import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curateSkills, renderSkillMarkdown, runSkillCurator, SKILL_STALE_DAYS, SKILL_TRACKING_MIN_DAYS } from "./skill-author.js";
import { readActivity } from "./activity.js";

// Curator usage staleness (gap found 2026-11-15): the Phase B
// curator stayed silent about usage because SAM had no skill-use
// tracking; skill-use.ts now records every model sam_read_skill,
// so the curator can flag unused and stale skills - fenced by
// the tracking ledger's own age so a young install's silence is
// never dressed as neglect.

function freshRoot(): string { return mkdtempSync(join(tmpdir(), "sam-curator-usage-")); }
const BODY = "First gather the evidence from the source system. Then compare it against the previous record. Then write down only the differences, each with its number attached so the reader can check it.";
const NOW = new Date("2026-12-20T12:00:00Z");

function placeSkill(root: string, name: string, description: string): void {
  const target = join(root, ".agents/skills", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), renderSkillMarkdown({ name, description, instructions: BODY }));
}
function writeUseLedger(root: string, entries: Array<{ at: string; skill: string }>): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "skill-use.jsonl"), entries.map(e => JSON.stringify({ at: e.at, actor: "sam", chatId: null, skill: e.skill })).join("\n") + "\n");
}
function daysAgo(days: number): string { return new Date(NOW.getTime() - days * 86_400_000).toISOString(); }

test("curator usage: no ledger and a young ledger both stay silent", () => {
  const root = freshRoot();
  try {
    placeSkill(root, "web-check", "Check the public web for current facts and sources");
    // No ledger at all: nothing to judge from.
    assert.deepEqual(curateSkills(root, NOW).filter(f => f.kind === "unused-skill" || f.kind === "stale-skill"), []);
    // Ledger exists but spans less than the tracking minimum:
    // silence inside the window proves nothing.
    writeUseLedger(root, [{ at: daysAgo(2), skill: "other-skill" }]);
    assert.deepEqual(curateSkills(root, NOW).filter(f => f.kind === "unused-skill" || f.kind === "stale-skill"), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("curator usage: a never-loaded skill is flagged once tracking is old enough", () => {
  const root = freshRoot();
  try {
    placeSkill(root, "web-check", "Check the public web for current facts and sources");
    placeSkill(root, "ledger-tally", "Total the ledger entries for the day and cross-check receipts");
    writeUseLedger(root, [{ at: daysAgo(SKILL_TRACKING_MIN_DAYS + 6), skill: "ledger-tally" }, { at: daysAgo(1), skill: "ledger-tally" }]);
    const findings = curateSkills(root, NOW);
    const unused = findings.filter(f => f.kind === "unused-skill");
    assert.equal(unused.length, 1);
    assert.deepEqual(unused[0].skills, ["web-check"]);
    assert.match(unused[0].detail, /no recorded use since skill-use tracking began/);
    assert.ok(unused[0].suggestedPatch.length > 10);
    assert.equal(findings.filter(f => f.kind === "stale-skill").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("curator usage: a skill past the stale window is flagged stale, a recent one is not", () => {
  const root = freshRoot();
  try {
    placeSkill(root, "old-faithful", "Walk the garden beds in order and note which rows were watered");
    placeSkill(root, "fresh-hand", "Tune the instrument to the reference pitch and adjust each string");
    writeUseLedger(root, [
      { at: daysAgo(SKILL_STALE_DAYS + 20), skill: "old-faithful" },
      { at: daysAgo(SKILL_STALE_DAYS + 10), skill: "old-faithful" },
      { at: daysAgo(3), skill: "fresh-hand" },
    ]);
    const findings = curateSkills(root, NOW);
    const stale = findings.filter(f => f.kind === "stale-skill");
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0].skills, ["old-faithful"]);
    assert.match(stale[0].detail, /past the 30-day staleness window/);
    assert.equal(findings.filter(f => f.kind === "unused-skill").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("curator usage: findings persist through runSkillCurator and ledger once per changed set", () => {
  const root = freshRoot();
  try {
    placeSkill(root, "web-check", "Check the public web for current facts and sources");
    writeUseLedger(root, [{ at: daysAgo(40), skill: "someone-else" }]);
    // runSkillCurator uses the real clock; the ledger's tracking
    // start is relative to NOW above, so re-plant it relative to
    // the real now for this persistence check.
    const realStart = new Date(Date.now() - 40 * 86_400_000).toISOString();
    writeUseLedger(root, [{ at: realStart, skill: "someone-else" }]);
    const first = runSkillCurator(root);
    assert.equal(first.changed, true);
    assert.ok(first.findings.some(f => f.kind === "unused-skill" && f.skills[0] === "web-check"));
    const second = runSkillCurator(root);
    assert.equal(second.changed, false);
    assert.equal(readActivity(root, 10, { kind: "skill-curator" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

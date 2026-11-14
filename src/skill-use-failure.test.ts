import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { lastSkillByChat, recentSkillUse, recordSkillUse, skillUseEntries, skillUseFailureSummary, skillUseReadFailureSummary } from "./skill-use.js";
import { classifyDefect, rankDefects } from "./self-work.js";
import { executeOwnTool } from "./own-tools.js";

// Skill-use failure visibility (gap found 2026-11-13, hourly run
// 13:04): recordSkillUse appended unguarded and its only caller
// swallowed both visibility writes in one try, so a dead
// skill-use.jsonl froze the rail/header/status picture with no
// trace anywhere - and the paired success activity line died with
// it. The recorder now follows the house contract: visibility
// never breaks the read, and each failed write ledgers exactly
// one skill-use-failed line; the success line rides only a
// record that landed.
function scratch() {
  return mkdtempSync(join(tmpdir(), "sam-skilluse-fail-"));
}

// Plant a directory where a ledger file belongs: every append to
// that path throws EISDIR, the dead-ledger shape.
function plantDir(root: string, name: string) {
  mkdirSync(join(root, ".sam"), { recursive: true });
  mkdirSync(join(root, ".sam", name));
}

const CHAT = "abcd1234-0000-4000-8000-000000000000";

test("skill-use-failed: a dead ledger ledgers one line per failed write and never throws", () => {
  const root = scratch();
  try {
    plantDir(root, "skill-use.jsonl");
    assert.equal(recordSkillUse(root, { actor: "dip", chatId: CHAT, skill: "agent-reach" }), false,
      "a failed record reports not-landed instead of throwing");
    assert.equal(recordSkillUse(root, { actor: "dip", chatId: CHAT, skill: "agent-reach" }), false,
      "a persistent failure recurs per write - that recurrence is the countable signal");
    const lines = readActivity(root, 100, { kind: "skill-use-failed" });
    assert.equal(lines.length, 2, "exactly one line per failed write");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Skill use record failed for skill agent-reach in chat abcd1234: "), lines[0].summary);
    assert.equal(readActivity(root, 100, { kind: "skill-use" }).length, 0, "no success line was written for the dead writes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use-failed: a healthy write records and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.equal(recordSkillUse(root, { actor: "dip", chatId: CHAT, skill: "agent-reach" }), true);
    assert.equal(recordSkillUse(root, { actor: "dip", chatId: null, skill: "webclaw" }), true);
    assert.equal(skillUseEntries(root).length, 2);
    assert.equal(readActivity(root, 100, { kind: "skill-use-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use-failed: the own-tools read still succeeds on a dead ledger, with no success line", () => {
  const root = scratch();
  try {
    // A real installed skill the model can read through the tool.
    const skillDir = join(root, "skills", "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha playbook for testing skill reads\n---\nDo alpha things.\n");
    plantDir(root, "skill-use.jsonl");
    const read = executeOwnTool(root, "dip", "sam_read_skill", { name: "alpha" }, CHAT) as { name?: string; error?: string };
    assert.equal(read.name, "alpha", "visibility never breaks the read");
    assert.equal(read.error, undefined);
    assert.equal(readActivity(root, 100, { kind: "skill-use" }).length, 0,
      "no success activity line rides a record that did not land");
    const failed = readActivity(root, 100, { kind: "skill-use-failed" });
    assert.equal(failed.length, 1, "exactly one failure line for the dead write");
    assert.ok(failed[0].summary.startsWith("Skill use record failed for skill alpha in chat abcd1234: "), failed[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use-failed: the own-tools read on a healthy ledger writes both records", () => {
  const root = scratch();
  try {
    const skillDir = join(root, "skills", "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha playbook for testing skill reads\n---\nDo alpha things.\n");
    const read = executeOwnTool(root, "dip", "sam_read_skill", { name: "alpha" }, CHAT) as { name?: string };
    assert.equal(read.name, "alpha");
    assert.equal(skillUseEntries(root).length, 1);
    assert.equal(readActivity(root, 100, { kind: "skill-use" }).length, 1);
    assert.equal(readActivity(root, 100, { kind: "skill-use-failed" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use failure summaries collapse and cap the verbatim reason", () => {
  const s = skillUseFailureSummary("agent-reach", CHAT, "EISDIR: illegal operation\n  on a directory");
  assert.ok(!s.includes("\n"), "the reason is one line");
  const capped = skillUseFailureSummary("agent-reach", CHAT, "x".repeat(500));
  assert.ok(capped.length <= 200, "the summary is capped at 200");
  const noChat = skillUseFailureSummary("agent-reach", null, "boom");
  assert.equal(noChat, "Skill use record failed for skill agent-reach: boom");
});

test("skill-use-failed: a dead read ledgers one line and rethrows, never folds to a false empty", () => {
  const root = scratch();
  try {
    plantDir(root, "skill-use.jsonl");
    assert.throws(() => skillUseEntries(root), /EISDIR/, "the read rethrows exactly instead of folding to []");
    const lines = readActivity(root, 100, { kind: "skill-use-failed" });
    assert.equal(lines.length, 1, "exactly one read line for the dead read");
    assert.equal(lines[0].actor, "sam", "the reader is the system");
    assert.ok(lines[0].summary.startsWith("Skill use read failed: "), lines[0].summary);
    assert.throws(() => recentSkillUse(root), /EISDIR/);
    assert.throws(() => lastSkillByChat(root), /EISDIR/);
    assert.equal(readActivity(root, 100, { kind: "skill-use-failed" }).length, 3,
      "each reader surface ledgers its own one line - no surface dies raw");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use-failed: an absent ledger still reads empty and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(skillUseEntries(root), []);
    assert.deepEqual(recentSkillUse(root), []);
    assert.equal(lastSkillByChat(root).size, 0);
    assert.equal(readActivity(root, 100, { kind: "skill-use-failed" }).length, 0, "a fresh install genuinely used no skills");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill-use read failure summaries collapse and cap the verbatim reason", () => {
  const s = skillUseReadFailureSummary("EISDIR: illegal operation\n  on a directory");
  assert.ok(!s.includes("\n"), "the reason is one line");
  assert.equal(s, "Skill use read failed: EISDIR: illegal operation on a directory");
  const capped = skillUseReadFailureSummary("x".repeat(500));
  assert.ok(capped.length <= 200, "the summary is capped at 200");
});

test("skill-use-failed kind classifies to its own defect class and ranks", () => {
  const line = { at: "2026-11-13T18:00:00.000Z", actor: "dip", kind: "skill-use-failed", summary: "boom" };
  assert.deepEqual(classifyDefect(line), { key: "skill-use-failed", label: "skill-use ledger failures" });
  const root = scratch();
  try {
    recordActivity(root, "dip", "skill-use-failed", "Skill use record failed for skill agent-reach in chat abcd1234: EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "skill-use-failed")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

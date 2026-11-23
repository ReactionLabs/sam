import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillUseFailedSummary, skillUseFailedHistoryScorecardText, skillUseFailureSummary, skillUseReadFailureSummary } from "./skill-use.js";
import { recordActivity } from "./activity.js";
import { usageFailureSummary } from "./usage.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill use failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the skill-use
// ledger ledgers every failed touch as a skill-use-failed
// line through the TWO writers skillUseFailureSummary (a
// failed record, naming the skill and the optional chat
// prefix) and skillUseReadFailureSummary (a failed ledger
// read, no skill), ridden by recordSkillUseFailure /
// recordSkillUseReadFailure - but the class was never folded,
// so how often a skill read went unrecorded, or the ledger
// read died and froze the rail, header, and status as truth,
// was invisible in aggregate. Every failure line is by
// construction a skill-use touch that did not complete, so
// the verdict is attention when any failure was ever recorded
// or any line is unparseable, else clear. The scorecard text
// is a script job's stdout and is P3-diffed on its facts, so
// it is ONE line carrying counts only: no stamp, no actor, no
// operation name, no skill name, no chat prefix, and no
// verbatim reason - the summaries carry skills, chats, and
// reasons, and the fold consumes and never prints them. The
// scorecard path is a pure read - it creates nothing, sends
// nothing, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-use-failed-history-"));
}

const BARE = "Skill use failed history: clear, 0 failed, 0 distinct operations, 0 distinct skills, 0 distinct chats, 0 total";

test("skill use failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillUseFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillUseFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill use scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill use failed history scorecard: the writers' failures fold to counts with distinct operations, skills, and chats as numbers only, and no skill, chat, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = skillUseFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "skill-use-failed", skillUseFailureSummary("agent-reach", "6b222963abcdef", "unable to open database file sekrit"));
    recordActivity(dir, "sam", "skill-use-failed", skillUseFailureSummary("agent-reach", "aa11bb22ccdd", "disk full"));
    recordActivity(dir, "sam", "skill-use-failed", skillUseFailureSummary("other-skill", null, "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "skill-use-failed", skillUseReadFailureSummary("database is locked"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = skillUseFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill use failed history: attention, 4 failed, 2 distinct operations, 2 distinct skills, 2 distinct chats, 4 total");
    assert.equal(text.includes("agent-reach"), false, "no skill name surfaces");
    assert.equal(text.includes("6b222963"), false, "no chat prefix surfaces");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill use failed history scorecard: the writers' own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = skillUseFailureSummary("agent-reach", "6b222963abcdef", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseSkillUseFailedSummary(capped), { what: "record", skill: "agent-reach", chat: "6b222963" });
    recordActivity(dir, "sam", "skill-use-failed", capped);
    const text = skillUseFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill use failed history: attention, 1 failed, 1 distinct operations, 1 distinct skills, 1 distinct chats, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill use failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an overlong chat segment count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill-use-failed", skillUseReadFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "skill-use-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "skill-use-failed", usageFailureSummary("mock", "boom sekrit"));
    recordActivity(dir, "sam", "skill-use-failed", "Skill use read failed:   ");
    recordActivity(dir, "sam", "skill-use-failed", "Skill use record failed for skill agent-reach in chat 6b222963x: boom sekrit");
    const text = skillUseFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill use failed history: attention, 1 failed, 1 distinct operations, 0 distinct skills, 0 distinct chats, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill use failed parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    skillUseFailureSummary("agent-reach", "6b222963abcdef", "EPERM: operation not permitted"),
    "Skill use record failed for skill agent-reach in chat 6b222963: EPERM: operation not permitted",
  );
  assert.equal(
    skillUseFailureSummary("agent-reach", null, "EPERM: operation not permitted"),
    "Skill use record failed for skill agent-reach: EPERM: operation not permitted",
  );
  assert.equal(
    skillUseReadFailureSummary("EPERM: operation not permitted"),
    "Skill use read failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseSkillUseFailedSummary(skillUseFailureSummary("agent-reach", "6b222963abcdef", "boom")), { what: "record", skill: "agent-reach", chat: "6b222963" });
  assert.deepEqual(parseSkillUseFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), { what: "record", skill: "agent-reach", chat: null });
  assert.deepEqual(parseSkillUseFailedSummary(skillUseReadFailureSummary("boom")), { what: "read", skill: null, chat: null });
  assert.equal(parseSkillUseFailedSummary(""), null);
  assert.equal(parseSkillUseFailedSummary("Skill use read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseSkillUseFailedSummary("Skill use read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseSkillUseFailedSummary("Skill use record failed for skill : boom"), null, "a record with no skill does not parse");
  assert.equal(parseSkillUseFailedSummary("Skill use record failed for skill agent-reach:"), null, "a record with no reason does not parse");
  assert.equal(parseSkillUseFailedSummary("Skill use record failed for skill agent-reach in chat 6b222963x: boom"), null, "a chat segment longer than the writer's 8-char slice does not parse");
  assert.equal(parseSkillUseFailedSummary("Skill use write failed: boom"), null, "a shape the seams never write does not parse");
  assert.equal(parseSkillUseFailedSummary(usageFailureSummary("mock", "boom")), null, "a usage-failed line never parses as a skill-use-failed line");
  assert.deepEqual(parseSkillUseFailedSummary("Skill use read failed: boom: with colon"), { what: "read", skill: null, chat: null }, "a reason carrying a colon still parses from the fixed head");
});

test("skill use failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-use-failed-history"), "sam-skill-use-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-use-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "use-failed-history"], "the argv rides skills use-failed-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSkillUseSummary, skillUseLedgerSummary, skillUseScorecardText } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill-use daily-measurement wiring (2026-11-18, the
// measured-proof series): every sam_read_skill the model
// makes ledgers one skill-use line carrying the skill's
// name and the chat prefix, but no daily surface ever
// counted the uses, so skill auto-selection going silent
// or a one-skill habit was invisible in aggregate. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it carries counts only: no stamp, no
// actor, no skill name, and no chat id - a skill name is a
// library identifier and a chat prefix identifies a
// conversation, and neither belongs in a trending surface;
// an unmatched shape counts as a use and contributes no
// skill or chat count, never printed. The scorecard path
// is a pure read - it creates nothing, spends no model
// call, and reads no skill; every state here is built
// through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-use-scorecard-"));
}

test("skill-use scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillUseScorecardText(dir);
    assert.match(text, /^Skill uses: clear$/m);
    assert.match(text, /^Uses: 0$/m);
    assert.match(text, /^Distinct skills: 0$/m);
    assert.match(text, /^Distinct chats: 0$/m);
    assert.match(text, /^Uses with no chat: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillUseScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill-use scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill-use scorecard: uses fold to counts, a malformed line flips the verdict, and no skill or chat leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "skill-use", skillUseLedgerSummary("sekrit-skill", "abcdef0123456789"));
    recordActivity(dir, "dip", "skill-use", skillUseLedgerSummary("sekrit-skill", "abcdef0123456789"));
    recordActivity(dir, "sam", "skill-use", skillUseLedgerSummary("other-skill", "1234567890abcdef"));
    recordActivity(dir, "dip", "skill-use", skillUseLedgerSummary("third-skill", null));
    const clean = skillUseScorecardText(dir);
    assert.match(clean, /^Skill uses: clear$/m);
    assert.match(clean, /^Uses: 4$/m);
    assert.match(clean, /^Distinct skills: 3$/m);
    assert.match(clean, /^Distinct chats: 2$/m);
    assert.match(clean, /^Uses with no chat: 1$/m);
    recordActivity(dir, "sam", "skill-use", "Some wholly novel skill shape mentioning sekrit-skill");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = skillUseScorecardText(dir);
    assert.match(text, /^Skill uses: attention$/m);
    assert.match(text, /^Uses: 5$/m);
    assert.match(text, /^Distinct skills: 3$/m);
    assert.match(text, /^Distinct chats: 2$/m);
    assert.equal(text.includes("sekrit"), false, "no skill name surfaces");
    assert.equal(text.includes("other-skill"), false, "no skill name surfaces");
    assert.equal(text.includes("abcdef01"), false, "no chat id surfaces");
    assert.equal(text.includes("novel skill"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill-use parse: the seam's own lines parse, and only the fixed shape parses", () => {
  assert.deepEqual(parseSkillUseSummary(skillUseLedgerSummary("agent-reach", "045f35e8abcdef")), { skill: "agent-reach", chat: "045f35e8" });
  assert.deepEqual(parseSkillUseSummary(skillUseLedgerSummary("agent-reach", null)), { skill: "agent-reach", chat: null });
  assert.equal(skillUseLedgerSummary("agent-reach", "045f35e8abcdef"), "Used skill agent-reach in chat 045f35e8", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(skillUseLedgerSummary("agent-reach", null), "Used skill agent-reach", "the writer's no-chat shape is byte-identical to the historical inline shape");
  assert.equal(parseSkillUseSummary(""), null);
  assert.equal(parseSkillUseSummary("Some wholly novel skill shape"), null);
  assert.equal(parseSkillUseSummary("Used skill"), null);
});

test("skill-use scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-uses"), "sam-skill-uses is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-uses");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "use-scorecard"], "the argv rides skills use-scorecard");
});

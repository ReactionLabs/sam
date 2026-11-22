import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSkillAllowlistClearedSummary, parseSkillAllowlistSetSummary, skillAllowlistClearedLedgerSummary, skillAllowlistHistoryScorecardText, skillAllowlistSetLedgerSummary } from "./skills.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill allowlist history daily-measurement wiring
// (2026-11-21, the measured-proof series): every per-profile
// skill fence change through setSkillAllowlist ledgers one
// "skill-allowlist" line - a set naming the profile and the
// listed skills, or a clear back to unrestricted - but neither
// shape was ever folded, so how many profiles were ever fenced
// or unfenced over an install's life was invisible in
// aggregate; the allowlists store holds only current fences
// (one row per profile, overwritten in place), so a cleared
// fence leaves no surface but these lines (the
// provider-registry precedent). Sets and clears are owner
// acts, not failures, so the verdict is attention only when a
// line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no
// profile name, no skill name, and no verbatim summary. The
// scorecard path is a pure read - it creates nothing, sets
// nothing, clears nothing, and opens no store; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-allowlist-history-"));
}

const BARE = "Skill allowlist history: clear, 0 set, with skills 0 / empty 0, 0 cleared, 0 distinct profiles, 0 total";

test("skill allowlist history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillAllowlistHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillAllowlistHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill allowlist scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill allowlist history scorecard: recorded sets and clears fold to counts with distinct profiles as a number only", () => {
  const dir = scratch();
  try {
    const clean = skillAllowlistHistoryScorecardText(dir);
    recordActivity(dir, "sekritprofile", "skill-allowlist", skillAllowlistSetLedgerSummary("sekritprofile", ["sekrit-skill", "other-skill"]));
    recordActivity(dir, "sekritprofile", "skill-allowlist", skillAllowlistSetLedgerSummary("sekritprofile", []));
    recordActivity(dir, "otherprofile", "skill-allowlist", skillAllowlistSetLedgerSummary("otherprofile", ["third-skill"]));
    recordActivity(dir, "sekritprofile", "skill-allowlist", skillAllowlistClearedLedgerSummary("sekritprofile"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = skillAllowlistHistoryScorecardText(dir);
    assert.equal(text, "Skill allowlist history: clear, 3 set, with skills 2 / empty 1, 1 cleared, 2 distinct profiles, 4 total");
    assert.equal(text.includes("sekrit"), false, "no profile or skill name surfaces");
    assert.equal(text.includes("other-skill"), false, "no skill name surfaces");
    assert.equal(text.includes("third-skill"), false, "no skill name surfaces");
    assert.notEqual(text, clean, "the first recorded set changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill allowlist history scorecard: an unmatched shape is attention, counts toward the total and the unparseable count, and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekritprofile", "skill-allowlist", skillAllowlistSetLedgerSummary("sekritprofile", ["sekrit-skill"]));
    recordActivity(dir, "sekritprofile", "skill-allowlist", "A sekrit fence quietly moved");
    const text = skillAllowlistHistoryScorecardText(dir);
    assert.equal(text, "Skill allowlist history: attention, 1 set, with skills 1 / empty 0, 0 cleared, 1 distinct profiles, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill allowlist parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(skillAllowlistSetLedgerSummary("dip", ["alpha", "beta-two"]), "Skill allowlist set for profile dip: alpha, beta-two");
  assert.deepEqual(parseSkillAllowlistSetSummary(skillAllowlistSetLedgerSummary("dip", ["alpha", "beta-two"])), { profile: "dip", names: ["alpha", "beta-two"] });
  assert.equal(skillAllowlistSetLedgerSummary("dip", []), "Skill allowlist set for profile dip: (none - no skills)");
  assert.deepEqual(parseSkillAllowlistSetSummary(skillAllowlistSetLedgerSummary("dip", [])), { profile: "dip", names: [] });
  assert.equal(parseSkillAllowlistSetSummary(""), null);
  assert.equal(parseSkillAllowlistSetSummary("Skill allowlist set for profile dip: alpha beta"), null, "a space inside the list does not parse");
  assert.equal(parseSkillAllowlistSetSummary("Skill allowlist set for profile dip: alpha, beta tonight"), null, "a line with trailing free text does not parse");
  assert.equal(skillAllowlistClearedLedgerSummary("dip"), "Skill allowlist cleared for profile dip (unrestricted)");
  assert.deepEqual(parseSkillAllowlistClearedSummary(skillAllowlistClearedLedgerSummary("dip")), { profile: "dip" });
  assert.equal(parseSkillAllowlistClearedSummary(""), null);
  assert.equal(parseSkillAllowlistClearedSummary("Skill allowlist cleared for profile dip"), null, "a clear line without its fixed tail does not parse");
  assert.equal(parseSkillAllowlistClearedSummary(skillAllowlistSetLedgerSummary("dip", ["alpha"])), null, "a set line is not a clear line");
  assert.equal(parseSkillAllowlistSetSummary(skillAllowlistClearedLedgerSummary("dip")), null, "a clear line is not a set line");
});

test("skill allowlist history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-allowlist-history"), "sam-skill-allowlist-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-allowlist-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "allowlist-history"], "the argv rides skills allowlist-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTeamMemberAddedSummary, parseTeamMemberRemovedSummary, teamMemberAddedLedgerSummary, teamMemberHistoryScorecardText, teamMemberRemovedLedgerSummary } from "./team-runtime.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The team member history daily-measurement wiring
// (2026-11-21, the measured-proof series): every standing-
// team membership change ledgers one "team-member" line -
// an add ("Added <name> as <role>[ on <model>]") or a
// removal ("Removed team member <name>") - but neither
// shape was ever folded, so how often the standing team
// gained or lost a member was invisible in aggregate; the
// team store holds only current members, so a removed
// member and every past roster leave no surface but these
// ledger lines. A membership change is an owner's act, not
// a failure, so the verdict is attention only when a line
// is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// member name, no role, no model, and no verbatim summary.
// The scorecard path is a pure read - it creates nothing,
// adds and removes no member, and opens no store; every
// state here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-team-member-history-"));
}

const BARE = "Team member history: clear, 0 added, 0 removed, 0 distinct members, 0 total";

test("team member history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = teamMemberHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = teamMemberHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held team member scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team member history scorecard: recorded membership changes fold to counts with distinct members as a number only", () => {
  const dir = scratch();
  try {
    const clean = teamMemberHistoryScorecardText(dir);
    recordActivity(dir, "sekritactor", "team-member", teamMemberAddedLedgerSummary("ada", "builder", null));
    recordActivity(dir, "sekritactor", "team-member", teamMemberAddedLedgerSummary("cy", "researcher", "MiniMax-M2.5"));
    recordActivity(dir, "sekritactor", "team-member", teamMemberRemovedLedgerSummary("ada"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = teamMemberHistoryScorecardText(dir);
    assert.equal(text, "Team member history: clear, 2 added, 1 removed, 2 distinct members, 3 total");
    assert.equal(text.includes("sekrit"), false, "no actor surfaces");
    assert.equal(text.includes("ada"), false, "no member name surfaces");
    assert.notEqual(text, clean, "the first recorded membership change changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team member history scorecard: an unmatched shape is attention, counts toward the total and the unparseable count, and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekritactor", "team-member", teamMemberAddedLedgerSummary("ada", "builder", null));
    recordActivity(dir, "sekritactor", "team-member", "A sekrit member quietly joined");
    const text = teamMemberHistoryScorecardText(dir);
    assert.equal(text, "Team member history: attention, 1 added, 0 removed, 1 distinct members, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team member parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(teamMemberAddedLedgerSummary("ada", "builder", null), "Added ada as builder");
  assert.deepEqual(parseTeamMemberAddedSummary(teamMemberAddedLedgerSummary("ada", "builder", null)), { name: "ada", role: "builder", model: null });
  assert.equal(teamMemberAddedLedgerSummary("cy", "researcher", "MiniMax-M2.5"), "Added cy as researcher on MiniMax-M2.5");
  assert.deepEqual(parseTeamMemberAddedSummary(teamMemberAddedLedgerSummary("cy", "researcher", "MiniMax-M2.5")), { name: "cy", role: "researcher", model: "MiniMax-M2.5" });
  assert.equal(teamMemberRemovedLedgerSummary("ada"), "Removed team member ada");
  assert.deepEqual(parseTeamMemberRemovedSummary(teamMemberRemovedLedgerSummary("ada")), { name: "ada" });
  assert.equal(parseTeamMemberAddedSummary(""), null);
  assert.equal(parseTeamMemberAddedSummary("Added Ada as builder"), null, "an uppercase member name does not parse");
  assert.equal(parseTeamMemberAddedSummary("Added ada as manager"), null, "an unknown role does not parse");
  assert.equal(parseTeamMemberAddedSummary("Added ada as builder tonight"), null, "a line with trailing free text does not parse");
  assert.equal(parseTeamMemberRemovedSummary(""), null);
  assert.equal(parseTeamMemberRemovedSummary(teamMemberAddedLedgerSummary("ada", "builder", null)), null, "an added line is not a removed line");
  assert.equal(parseTeamMemberAddedSummary(teamMemberRemovedLedgerSummary("ada")), null, "a removed line is not an added line");
});

test("team member history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-team-member-history"), "sam-team-member-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-team-member-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-3), ["team", "member", "history"], "the argv rides team member history");
});

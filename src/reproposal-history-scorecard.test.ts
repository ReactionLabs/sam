import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReproposalSummary, reproposalHistoryScorecardText, reproposalLedgerSummary } from "./actions.js";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The reproposal history daily-measurement wiring
// (2026-11-24, the measured-proof series): the ONE gate
// ledgers every corrected re-proposal as a "reproposal"
// line through the ONE writer (reproposalLedgerSummary,
// fixed shape "Corrected re-proposal for failed <kind>:
// <title> -> profile <fix>") - and while the corrected
// card folds as an ordinary pending card in the gate
// folds, no surface folds this kind: how often a heartbeat
// card died on an unknown profile and was silently
// re-aimed at the one unambiguous correction was invisible
// in aggregate. The new card's proposal line names only
// kind and title, and the failed line is written before
// the corrected profile joins the failed record's result,
// so this ledger line is the only witness of the
// correction itself. Every reproposal line is by
// construction a card that was unexecutable as written,
// so the verdict is attention when any correction was
// ever recorded or any line is unparseable, else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no title, no profile
// name, and no verbatim summary. The scorecard path is a
// pure read - it creates nothing, spends no model call,
// and proposes nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-reproposal-history-"));
}

const BARE = "Reproposal history: clear, 0 corrected, 0 distinct profiles, kinds none, 0 total";

test("reproposal history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = reproposalHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = reproposalHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held reproposal scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reproposal history scorecard: the writer's corrections fold to counts with the distinct-profile count, and no title or profile name surfaces", () => {
  const dir = scratch();
  try {
    const clean = reproposalHistoryScorecardText(dir);
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Morning stack check", "second-shift"));
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Evening stack check", "trading"));
    recordActivity(dir, "sam", "proposal", "heartbeat: Morning stack check");
    const text = reproposalHistoryScorecardText(dir);
    assert.equal(text, "Reproposal history: attention, 2 corrected, 2 distinct profiles, kinds heartbeat 2, 2 total");
    assert.equal(text.includes("second-shift"), false, "no profile name surfaces");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.equal(text.includes("stack check"), false, "no title surfaces");
    assert.notEqual(text, clean, "the first recorded correction changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reproposal history scorecard: an unmatched shape and a cross-kind shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Morning stack check", "second-shift"));
    recordActivity(dir, "sam", "reproposal", "Some wholly novel ledger shape naming sekrit_profile");
    recordActivity(dir, "sam", "reproposal", "heartbeat: Morning stack check - a failed line");
    recordActivity(dir, "sam", "reproposal", "Corrected re-proposal for failed heartbeat: No fix named");
    const text = reproposalHistoryScorecardText(dir);
    assert.equal(text, "Reproposal history: attention, 1 corrected, 1 distinct profiles, kinds heartbeat 1, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reproposal history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    reproposalLedgerSummary("heartbeat", "Morning stack check", "second-shift"),
    "Corrected re-proposal for failed heartbeat: Morning stack check -> profile second-shift",
  );
  assert.deepEqual(parseReproposalSummary(reproposalLedgerSummary("heartbeat", "Morning stack check", "second-shift")), { kind: "heartbeat", profile: "second-shift" });
  assert.deepEqual(parseReproposalSummary("Corrected re-proposal for failed mystery: T -> profile sam"), { kind: "other", profile: "sam" });
  assert.equal(parseReproposalSummary(""), null);
  assert.equal(parseReproposalSummary("Corrected re-proposal for failed heartbeat: T -> profile "), null, "a line with no profile does not parse");
  assert.equal(parseReproposalSummary("Corrected re-proposal for failed heartbeat: T"), null, "a line without the profile tail does not parse");
  assert.equal(parseReproposalSummary("Corrected re-proposal for failed heartbeat: T -> profile Second Shift"), null, "a profile outside the registry alphabet does not parse");
  assert.equal(parseReproposalSummary("heartbeat: T - a failed line"), null, "a failed line never parses as a reproposal line");
});

test("reproposal history scorecard: repeat corrections to one profile raise the corrected count only, and a corrected state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Morning stack check", "second-shift"));
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Morning stack check again", "second-shift"));
    recordActivity(dir, "sam", "reproposal", reproposalLedgerSummary("heartbeat", "Morning stack check once more", "second-shift"));
    const text = reproposalHistoryScorecardText(dir);
    assert.equal(text, "Reproposal history: attention, 3 corrected, 1 distinct profiles, kinds heartbeat 3, 3 total");
    assert.equal(reproposalHistoryScorecardText(dir), text, "a corrected state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reproposal history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-reproposal-history"), "sam-reproposal-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-reproposal-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "reproposal-history"], "the argv rides actions reproposal-history");
});

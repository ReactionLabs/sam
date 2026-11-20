import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  approvedLedgerSummary,
  decisionScorecardText,
  parseDecisionSummary,
  rejectedLedgerSummary,
} from "./actions.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The gate decision daily-measurement wiring (2026-11-20,
// the measured-proof series): every decision through the
// ONE gate has ledgered as an approved, auto-approved, or
// rejected line since the gate landed - "<kind>: <title>",
// "<kind>: <title> - <result>", and the auto form's
// trailing "[<by>]" via stamp, from the two applyDecision
// seams - but the classes were never folded: the proposal
// scorecard reads the gate's inflow, the gate scorecard
// reads the action store, and the failure scorecard folds
// the ledger's failed lines, yet the decision lines
// themselves, the outflow record of everything the owner
// and the approvals engine have ever decided, had no
// trending surface, so the decision mix over time was
// invisible in aggregate. Deciding is the gate working as
// designed, so the verdict is attention only when a line
// is unparseable. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no title, and
// no result - the summary carries the proposal's title and
// its execution result, which the fold counts and never
// prints. Kinds are validated against the fixed
// ACTION_KINDS enum; an unknown kind folds to "other",
// never printed as free text, and an auto via folds to the
// fixed smart / off / other buckets. The scorecard path is
// a pure read - it creates nothing and decides nothing;
// every state here is built through the ledger's own
// public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-decision-scorecard-"));
}

test("decision scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = decisionScorecardText(dir);
    assert.equal(text, "Gate decisions: clear, 0 total, owner-approved 0 / auto-approved 0 / rejected 0, kinds none, auto via none");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = decisionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held decision scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("decision scorecard: the classes fold to counts per decision, kind, and via, and no title or result surfaces", () => {
  const dir = scratch();
  try {
    const clean = decisionScorecardText(dir);
    recordActivity(dir, "owner", "approved", approvedLedgerSummary("note", "Sekrit plan title", "Memory note saved (sekrit-id)", "owner"));
    recordActivity(dir, "sam", "auto-approved", approvedLedgerSummary("skill", "Install sekrit skill", "Installed skill(s): sekrit", "auto:smart"));
    recordActivity(dir, "owner", "rejected", rejectedLedgerSummary("law", "Sekrit law title"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = decisionScorecardText(dir);
    assert.equal(text, "Gate decisions: clear, 3 total, owner-approved 1 / auto-approved 1 / rejected 1, kinds note 1 / law 1 / skill 1, auto via smart 1");
    assert.equal(text.includes("Sekrit"), false, "no title surfaces");
    assert.equal(text.includes("sekrit"), false, "no result surfaces");
    assert.notEqual(text, clean, "the first recorded decision changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("decision scorecard: an unknown kind and via fold to other, and an unmatched shape is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "auto-approved", approvedLedgerSummary("teleport", "Beam the sekrit plans up", "Beamed", "auto:warp"));
    recordActivity(dir, "owner", "approved", "Some wholly novel decision shape mentioning sekrit-title");
    const text = decisionScorecardText(dir);
    assert.equal(text, "Gate decisions: attention, 2 total, owner-approved 1 / auto-approved 1 / rejected 0, kinds other 1, auto via other 1, 1 unparseable");
    assert.equal(text.includes("teleport"), false, "an unknown kind is never printed as free text");
    assert.equal(text.includes("warp"), false, "an unknown via is never printed as free text");
    assert.equal(text.includes("sekrit"), false, "no title surfaces");
    assert.equal(text.includes("novel decision"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("decision parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    approvedLedgerSummary("note", "Full-agent program authorized", "Memory note saved (abc)", "owner"),
    "note: Full-agent program authorized - Memory note saved (abc)",
  );
  assert.equal(
    approvedLedgerSummary("skill", "Install webclaw skill", "Installed skill(s): webclaw", "auto:smart"),
    "skill: Install webclaw skill - Installed skill(s): webclaw [auto:smart]",
  );
  assert.equal(rejectedLedgerSummary("law", "Correction: Never duplicate"), "law: Correction: Never duplicate");
  assert.deepEqual(parseDecisionSummary(approvedLedgerSummary("note", "T", "R", "owner"), "approved"), { kind: "note", via: null });
  assert.deepEqual(parseDecisionSummary(approvedLedgerSummary("skill", "T", "R", "auto:smart"), "auto-approved"), { kind: "skill", via: "smart" });
  assert.deepEqual(parseDecisionSummary(approvedLedgerSummary("skill", "T", "R", "auto:off"), "auto-approved"), { kind: "skill", via: "off" });
  assert.deepEqual(parseDecisionSummary(rejectedLedgerSummary("heartbeat", "T"), "rejected"), { kind: "heartbeat", via: null });
  assert.deepEqual(parseDecisionSummary("teleport: Beam up", "approved"), { kind: "other", via: null }, "an unknown kind folds to other");
  assert.equal(parseDecisionSummary("", "approved"), null);
  assert.equal(parseDecisionSummary("note:", "approved"), null, "a line with no title does not parse");
  assert.equal(parseDecisionSummary("Note: Capital kind", "approved"), null, "a capitalized kind does not parse");
  assert.equal(parseDecisionSummary("note: Approved sideways", "rejected")?.kind, "note", "the kind prefix leads the line");
});

test("decision scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-gate-decisions"), "sam-gate-decisions is allowlisted");
  const argv = scriptArgv("/some/root", "sam-gate-decisions");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "decide-scorecard"], "the argv rides actions decide-scorecard");
});

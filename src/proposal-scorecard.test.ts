import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseProposalSummary,
  proposalLedgerSummary,
  proposalScorecardText,
} from "./actions.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The proposal daily-measurement wiring (2026-11-20, the
// measured-proof series): every proposal through the ONE
// gate has ledgered as a proposal line since the gate
// landed - "Proposed <kind>: <title>" from the single
// proposeAction seam - but the class was never folded: the
// gate scorecard reads the action store and the failure
// scorecard folds the ledger's failed lines, yet the
// proposal lines themselves, the inflow record of
// everything SAM has ever asked the owner to approve, had
// no trending surface, so the proposal mix over time was
// invisible in aggregate. Proposing is the gate working as
// designed, so the verdict is attention only when a line
// is unparseable. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no title - the
// summary carries the proposal's title, which the fold
// counts and never prints. Kinds are validated against the
// fixed ACTION_KINDS enum; an unknown kind folds to
// "other", never printed as free text. The scorecard path
// is a pure read - it creates nothing and proposes
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-proposal-scorecard-"));
}

test("proposal scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = proposalScorecardText(dir);
    assert.equal(text, "Proposals: clear, 0 total, kinds none");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = proposalScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held proposal scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proposal scorecard: the class folds to counts per kind, and no title surfaces", () => {
  const dir = scratch();
  try {
    const clean = proposalScorecardText(dir);
    recordActivity(dir, "sam", "proposal", proposalLedgerSummary("note", "Sekrit plan title"));
    recordActivity(dir, "dip", "proposal", proposalLedgerSummary("note", "Another hidden title"));
    recordActivity(dir, "sam", "proposal", proposalLedgerSummary("heartbeat", "Morning watch title"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = proposalScorecardText(dir);
    assert.equal(text, "Proposals: clear, 3 total, kinds note 2 / heartbeat 1");
    assert.equal(text.includes("Sekrit"), false, "no title surfaces");
    assert.equal(text.includes("hidden title"), false, "no title surfaces");
    assert.equal(text.includes("Morning watch"), false, "no title surfaces");
    assert.notEqual(text, clean, "the first recorded proposal changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proposal scorecard: an unknown kind folds to other, and an unmatched shape is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "proposal", "Proposed teleport: Beam the sekrit plans up");
    recordActivity(dir, "sam", "proposal", "Some wholly novel proposal shape mentioning sekrit-title");
    const text = proposalScorecardText(dir);
    assert.equal(text, "Proposals: attention, 2 total, kinds other 1, 1 unparseable");
    assert.equal(text.includes("teleport"), false, "an unknown kind is never printed as free text");
    assert.equal(text.includes("sekrit"), false, "no title surfaces");
    assert.equal(text.includes("novel proposal"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proposal parse: the seam's own writer line is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    proposalLedgerSummary("note", "Full-agent program authorized"),
    "Proposed note: Full-agent program authorized",
  );
  assert.deepEqual(parseProposalSummary(proposalLedgerSummary("heartbeat", "Stack watch")), { kind: "heartbeat" });
  assert.deepEqual(parseProposalSummary(proposalLedgerSummary("skill-author", "Draft a skill")), { kind: "skill-author" });
  assert.deepEqual(parseProposalSummary("Proposed teleport: Beam up"), { kind: "other" }, "an unknown kind folds to other");
  assert.equal(parseProposalSummary(""), null);
  assert.equal(parseProposalSummary("Proposed note:"), null, "a line with no title does not parse");
  assert.equal(parseProposalSummary("Proposed : No kind"), null, "a line with no kind does not parse");
  assert.equal(parseProposalSummary("Proposed Note: Capital kind"), null, "a capitalized kind does not parse");
  assert.equal(parseProposalSummary("note: Proposed sideways"), null, "the verb must lead the line");
});

test("proposal scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-proposals"), "sam-proposals is allowlisted");
  const argv = scriptArgv("/some/root", "sam-proposals");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "propose-scorecard"], "the argv rides actions propose-scorecard");
});

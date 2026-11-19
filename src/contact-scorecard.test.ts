import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { contactAddedLedgerSummary, contactRemovedLedgerSummary, contactScorecardText, contactUpdatedLedgerSummary, parseContactSummary } from "./contacts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The contact daily-measurement wiring (2026-11-19, the
// measured-proof series): contact changes have ledgered as
// "contact" lines since the Address Book landed - one line
// per add, update, or remove, in the three fixed shapes the
// store writes - but the class was never folded, so how the
// owner's people file actually moves, and how many of the
// touched contacts carry the one hard rule (no drafts), was
// invisible in aggregate. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no slug,
// no verbatim summary - changes fold into the fixed shapes
// the store writes (through its ONE writers) and an
// unmatched shape counts toward the total and the
// unparseable count, never printed. The verdict is
// attention only on an unparseable line: contact changes
// are the healthy case. The scorecard path is a pure read -
// it creates nothing, spends no model call, and touches no
// contact; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-contact-scorecard-"));
}

test("contact scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = contactScorecardText(dir);
    assert.equal(text, "Contacts: clear, 0 added, 0 updated, 0 removed, 0 no-drafts, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = contactScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held contact scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact scorecard: changes fold to counts, stay clear, and leak no slug or content", () => {
  const dir = scratch();
  try {
    const clean = contactScorecardText(dir);
    recordActivity(dir, "owner", "contact", contactAddedLedgerSummary("sekrit-person", false));
    recordActivity(dir, "owner", "contact", contactAddedLedgerSummary("other-person", true));
    recordActivity(dir, "owner", "contact", contactAddedLedgerSummary("third-person", false));
    recordActivity(dir, "owner", "contact", contactUpdatedLedgerSummary("sekrit-person", true));
    recordActivity(dir, "owner", "contact", contactUpdatedLedgerSummary("other-person", false));
    recordActivity(dir, "owner", "contact", contactUpdatedLedgerSummary("third-person", false));
    recordActivity(dir, "owner", "contact", contactUpdatedLedgerSummary("sekrit-person", false));
    recordActivity(dir, "owner", "contact", contactRemovedLedgerSummary("other-person"));
    recordActivity(dir, "owner", "contact", contactRemovedLedgerSummary("third-person"));
    recordActivity(dir, "owner", "contact", contactRemovedLedgerSummary("sekrit-person"));
    recordActivity(dir, "sam", "contact-failed", "Contact write failed: some store reason mentioning sekrit-person");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = contactScorecardText(dir);
    assert.equal(text, "Contacts: clear, 3 added, 4 updated, 3 removed, 2 no-drafts, 10 total");
    assert.equal(text.includes("sekrit-person"), false, "no slug surfaces");
    assert.equal(text.includes("other-person"), false, "no slug surfaces");
    assert.equal(text.includes("third-person"), false, "no slug surfaces");
    assert.notEqual(text, clean, "the first contact change changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact scorecard: an unmatched shape flips the verdict to attention and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "contact", contactAddedLedgerSummary("sekrit-person", true));
    recordActivity(dir, "owner", "contact", "Some wholly novel contact shape mentioning sekrit-person");
    const text = contactScorecardText(dir);
    assert.equal(text, "Contacts: attention, 1 added, 0 updated, 0 removed, 1 no-drafts, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no slug surfaces");
    assert.equal(text.includes("novel contact"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact parse: the seam's own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(contactAddedLedgerSummary("abcd-person", false), "Added contact abcd-person", "the added writer is byte-identical to the shape the store has always ledgered");
  assert.equal(contactAddedLedgerSummary("abcd-person", true), "Added contact abcd-person (no drafts)", "the added writer is byte-identical to the shape the store has always ledgered");
  assert.equal(contactUpdatedLedgerSummary("abcd-person", false), "Updated contact abcd-person", "the updated writer is byte-identical to the shape the store has always ledgered");
  assert.equal(contactUpdatedLedgerSummary("abcd-person", true), "Updated contact abcd-person (no drafts)", "the updated writer is byte-identical to the shape the store has always ledgered");
  assert.equal(contactRemovedLedgerSummary("abcd-person"), "Removed contact abcd-person", "the removed writer is byte-identical to the shape the store has always ledgered");
  assert.deepEqual(parseContactSummary(contactAddedLedgerSummary("abcd-person", false)), { action: "added", noDraft: false });
  assert.deepEqual(parseContactSummary(contactAddedLedgerSummary("abcd-person", true)), { action: "added", noDraft: true });
  assert.deepEqual(parseContactSummary(contactUpdatedLedgerSummary("abcd-person", false)), { action: "updated", noDraft: false });
  assert.deepEqual(parseContactSummary(contactUpdatedLedgerSummary("abcd-person", true)), { action: "updated", noDraft: true });
  assert.deepEqual(parseContactSummary(contactRemovedLedgerSummary("abcd-person")), { action: "removed", noDraft: false });
  assert.deepEqual(parseContactSummary("Added contact 2e67eb98 (no drafts)"), { action: "added", noDraft: true }, "a live-shaped line parses");
  assert.equal(parseContactSummary(""), null);
  assert.equal(parseContactSummary("Removed contact abcd-person (no drafts)"), null, "a remove never carries the suffix");
  assert.equal(parseContactSummary("Added contact"), null);
  assert.equal(parseContactSummary("Some wholly novel contact shape"), null);
});

test("contact scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-contacts"), "sam-contacts is allowlisted");
  const argv = scriptArgv("/some/root", "sam-contacts");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["contacts", "scorecard"], "the argv rides contacts scorecard");
});

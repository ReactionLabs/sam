import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { addressBookFailedHistoryScorecardText, addressBookFailureSummary, parseAddressBookFailedSummary } from "./contacts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The address book failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the quiet Address
// Book render ledgers every failure as an address-book-failed
// line through the ONE writer addressBookFailureSummary - but
// the class was never folded, so how often the people file's
// human-readable face failed to render (leaving the directory
// stale against the store, which stays the truth) was
// invisible in aggregate. Every failure line is by
// construction a render that did not complete, so the verdict
// is attention when any failure was ever recorded or any line
// is unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, and no
// verbatim reason - the summaries carry reasons, which the
// fold consumes and never prints. The writer's shape has no
// phase (the render is the only Address Book write that can
// fail quietly), so the fold carries no distinct count. The
// scorecard path is a pure read - it creates nothing, sends
// nothing, retries nothing, renders no Address Book, and
// touches no contact; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-address-book-failed-history-"));
}

const BARE = "Address Book failed history: clear, 0 failed, 0 total";

test("address book failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = addressBookFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = addressBookFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held address book scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("address book failed history scorecard: the writer's failures fold to counts, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = addressBookFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "address-book-failed", addressBookFailureSummary("EISDIR: illegal operation on a directory, open sekrit-path"));
    recordActivity(dir, "sam", "address-book-failed", addressBookFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = addressBookFailedHistoryScorecardText(dir);
    assert.equal(text, "Address Book failed history: attention, 2 failed, 2 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("address book failed history scorecard: the writer's own 200-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = addressBookFailureSummary("x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "address-book-failed", capped);
    assert.deepEqual(parseAddressBookFailedSummary(capped), { matched: true });
    const text = addressBookFailedHistoryScorecardText(dir);
    assert.equal(text, "Address Book failed history: attention, 1 failed, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("address book failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "address-book-failed", addressBookFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "address-book-failed", "Some wholly novel address book shape naming sekrit_person");
    recordActivity(dir, "sam", "address-book-failed", "Contact write failed: boom sekrit");
    recordActivity(dir, "sam", "address-book-failed", "Address Book write failed:   ");
    const text = addressBookFailedHistoryScorecardText(dir);
    assert.equal(text, "Address Book failed history: attention, 1 failed, 4 total, 3 unparseable");
    assert.equal(text.includes("novel address book"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("address book failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    addressBookFailureSummary("EPERM: operation not permitted"),
    "Address Book write failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseAddressBookFailedSummary(addressBookFailureSummary("boom")), { matched: true });
  assert.equal(parseAddressBookFailedSummary(""), null);
  assert.equal(parseAddressBookFailedSummary("Address Book write failed:"), null, "a line with no reason does not parse");
  assert.equal(parseAddressBookFailedSummary("Address Book write failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseAddressBookFailedSummary("Address Book read failed: boom"), null, "a head the seam never writes does not parse");
  assert.equal(parseAddressBookFailedSummary("Contact write failed: boom"), null, "a contact-failed line never parses as an address-book line");
  assert.deepEqual(parseAddressBookFailedSummary("Address Book write failed: boom: with colon"), { matched: true }, "a reason carrying a colon still parses from the fixed head");
});

test("address book failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-address-book-failed-history"), "sam-address-book-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-address-book-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["contacts", "failed-history"], "the argv rides contacts failed-history");
});

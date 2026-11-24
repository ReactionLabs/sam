import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contactFailedHistoryScorecardText, contactFailureSummary, parseContactFailedSummary } from "./contacts.js";
import { recordActivity } from "./activity.js";
import { doorFailureSummary } from "./mini-door.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The contact failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the contact
// store's touches ledger every failure as a contact-failed
// line through the ONE writer (contactFailureSummary, fixed
// shape "Contact <phase> failed: <reason>", capped 200;
// phases read / write, ridden by recordContactFailure from
// the store seams, actor sam) - and while self-work labels
// single lines and the Address Book render failures carry
// their own fold, no surface folds this kind, so which phase
// of the store holding the per-person permission notes (the
// noDraft hard rule among them) failed was invisible in
// aggregate. Every failure line is by construction a store
// touch that did not complete, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no reason, and no
// verbatim summary - the summaries carry reasons, and the
// fold consumes and never prints them, and no contact
// record (a note is the owner's words about a person) ever
// surfaces. The scorecard path is a pure read - it creates
// nothing, updates nothing, and reads no contact record;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-contact-failed-history-"));
}

const BARE = "Contact failed history: clear, 0 failed, 0 read, 0 write, 0 total";

test("contact failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = contactFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = contactFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held contact scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = contactFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "contact-failed", contactFailureSummary("read", "unable to open sekrit store"));
    recordActivity(dir, "sam", "contact-failed", contactFailureSummary("write", "disk full"));
    recordActivity(dir, "sam", "contact-failed", contactFailureSummary("write", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = contactFailedHistoryScorecardText(dir);
    assert.equal(text, "Contact failed history: attention, 3 failed, 1 read, 2 write, 3 total");
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

test("contact failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = contactFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseContactFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "contact-failed", capped);
    recordActivity(dir, "sam", "contact-failed", contactFailureSummary("read", "boom"));
    const text = contactFailedHistoryScorecardText(dir);
    assert.equal(text, "Contact failed history: attention, 2 failed, 1 read, 1 write, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "contact-failed", contactFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "contact-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "contact-failed", doorFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "contact-failed", "Contact read failed:   ");
    recordActivity(dir, "sam", "contact-failed", "Contact resolve failed: boom");
    const text = contactFailedHistoryScorecardText(dir);
    assert.equal(text, "Contact failed history: attention, 1 failed, 1 read, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contact failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(contactFailureSummary("read", "database is locked"), "Contact read failed: database is locked");
  assert.equal(contactFailureSummary("write", "disk gone"), "Contact write failed: disk gone");
  assert.deepEqual(parseContactFailedSummary(contactFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseContactFailedSummary(contactFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseContactFailedSummary(""), null);
  assert.equal(parseContactFailedSummary("Contact read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseContactFailedSummary("Contact read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseContactFailedSummary("Contact resolve failed: boom"), null, "a phase the store never writes does not parse");
  assert.equal(parseContactFailedSummary(doorFailureSummary("read", "boom")), null, "a door-failed line never parses as a contact-failed line");
  assert.deepEqual(parseContactFailedSummary("Contact write failed: boom: with colon"), { phase: "write" }, "a reason carrying a colon still parses from the fixed head");
});

test("contact failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-contact-failed-history"), "sam-contact-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-contact-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "contact-failed-history"], "the argv rides observe contact-failed-history");
});

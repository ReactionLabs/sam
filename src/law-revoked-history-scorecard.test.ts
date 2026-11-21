import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { lawRevokedHistoryScorecardText, lawRevokedLedgerSummary, parseLawRevokedSummary } from "./preferences.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The law revocation history daily-measurement wiring
// (2026-11-21, the measured-proof series): every dashboard
// law revocation ledgers exactly one law-revoked line
// (profile plus the revoked statement) and the preference
// store shows only each record's CURRENT status, so a
// revocation whose law was later re-stated survives nowhere
// else - but the class was never folded, so how many laws
// were ever revoked, across how many profiles, was invisible.
// This family has no failure class of its own, so the verdict
// is attention only when a line is unparseable, the
// setup-history precedent. The class counts dashboard-door
// revocations only (the CLI revoke verb rides the store
// directly and ledgers nothing). The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no profile, no
// statement - the statement is the owner's own words and
// never surfaces. The scorecard path is a pure read - it
// creates nothing and revokes nothing; every state here is
// built through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-law-revoked-history-"));
}

const BARE = "Law revoked history: clear, 0 revoked, 0 distinct profiles, 0 total";

test("law revoked history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = lawRevokedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = lawRevokedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held revocation scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("law revoked history scorecard: recorded revocations fold to counts with the distinct-profile count as a number only", () => {
  const dir = scratch();
  try {
    const clean = lawRevokedHistoryScorecardText(dir);
    recordActivity(dir, "owner", "law-revoked", lawRevokedLedgerSummary("sam", "sekrit law one"));
    recordActivity(dir, "owner", "law-revoked", lawRevokedLedgerSummary("trading", "sekrit law two"));
    recordActivity(dir, "owner", "law-revoked", lawRevokedLedgerSummary("sam", "sekrit law three"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = lawRevokedHistoryScorecardText(dir);
    assert.equal(text, "Law revoked history: clear, 3 revoked, 2 distinct profiles, 3 total");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.equal(text.includes("sekrit"), false, "no statement surfaces");
    assert.notEqual(text, clean, "the first recorded revocation changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("law revoked history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "law-revoked", lawRevokedLedgerSummary("sam", "a real law"));
    recordActivity(dir, "owner", "law-revoked", "NoProfileSeparator sekrit text");
    recordActivity(dir, "owner", "law-revoked", "sam: ");
    const text = lawRevokedHistoryScorecardText(dir);
    assert.equal(text, "Law revoked history: attention, 1 revoked, 1 distinct profiles, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("law revoked parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(lawRevokedLedgerSummary("sam", "Always check the ledger first"), "sam: Always check the ledger first");
  assert.deepEqual(parseLawRevokedSummary(lawRevokedLedgerSummary("second-shift", "Never send without approval")), { profile: "second-shift" });
  assert.deepEqual(parseLawRevokedSummary(lawRevokedLedgerSummary("sam", "Rule: with a colon inside")), { profile: "sam" });
  assert.equal(parseLawRevokedSummary(""), null);
  assert.equal(parseLawRevokedSummary("sam:"), null, "a line missing the separator space and statement does not parse");
  assert.equal(parseLawRevokedSummary("sam: "), null, "an empty statement does not parse");
  assert.equal(parseLawRevokedSummary("sam:   "), null, "a whitespace-only statement does not parse");
  assert.equal(parseLawRevokedSummary("Second Shift: some law"), null, "a display name is not a profile shape");
  assert.equal(parseLawRevokedSummary("9sam: some law"), null, "a profile starting with a digit does not parse");
});

test("law revoked history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-law-revoked-history"), "sam-law-revoked-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-law-revoked-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["preferences", "revoked-history"], "the argv rides preferences revoked-history");
});

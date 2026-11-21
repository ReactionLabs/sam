import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { pairingHistoryScorecardText, pairingIssuedLedgerSummary, pairingLockoutLedgerSummary, pairingRedeemedLedgerSummary, parsePairingIssuedSummary, parsePairingLockoutSummary, parsePairingRedeemedSummary } from "./pairing.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The pairing history daily-measurement wiring (2026-11-21,
// the measured-proof series): every pairing lifecycle event
// has ledgered as a pairing-issued / pairing-redeemed /
// pairing-lockout line since pairing landed - until now as
// inline concatenation at the seams, with no ONE writer and
// no fold, so how many codes were ever issued, how many
// redemptions ever landed an owner, and whether the
// anti-brute-force lockout has EVER tripped was invisible in
// aggregate (pairingStatus reads only the current store).
// A lockout means someone burned the failure budget against
// a channel, so the verdict is attention only when any
// lockout was ever recorded or a line is unparseable. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no channel name, no user id - the
// summaries carry channel names, stamps, and the paired
// user's id, which the fold consumes and never prints. The
// scorecard path is a pure read - it creates nothing and
// issues and redeems nothing; every state here is built
// through the ledger's own public door (recordActivity)
// with the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-pairing-history-"));
}

test("pairing history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = pairingHistoryScorecardText(dir);
    assert.equal(text, "Pairing history: clear, 0 issued, 0 redeemed, 0 lockouts, 0 distinct channels, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = pairingHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held pairing scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing history scorecard: the history folds to counts and distinct channels, and no channel or user surfaces", () => {
  const dir = scratch();
  try {
    const clean = pairingHistoryScorecardText(dir);
    recordActivity(dir, "trading", "pairing-issued", pairingIssuedLedgerSummary("Sekrit Channel", "2026-11-21T06:00:00.000Z"));
    recordActivity(dir, "trading", "pairing-issued", pairingIssuedLedgerSummary("Sekrit Channel", "2026-11-21T07:00:00.000Z"));
    recordActivity(dir, "trading", "pairing-redeemed", pairingRedeemedLedgerSummary(424242, "Sekrit Channel"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = pairingHistoryScorecardText(dir);
    assert.equal(text, "Pairing history: clear, 2 issued, 1 redeemed, 0 lockouts, 1 distinct channels, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("424242"), false, "no user id surfaces");
    assert.notEqual(text, clean, "the first recorded pairing changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing history scorecard: a lockout is attention, counted, with no channel name or stamp printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "trading", "pairing-issued", pairingIssuedLedgerSummary("Sekrit Channel", "2026-11-21T06:00:00.000Z"));
    recordActivity(dir, "researcher", "pairing-lockout", pairingLockoutLedgerSummary("Other Sekrit", "2026-11-21T06:15:00.000Z"));
    const text = pairingHistoryScorecardText(dir);
    assert.equal(text, "Pairing history: attention, 1 issued, 0 redeemed, 1 lockouts, 2 distinct channels, 2 total");
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("2026-11-21"), false, "no stamp surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "trading", "pairing-issued", pairingIssuedLedgerSummary("Dip Telegram", "2026-11-21T06:00:00.000Z"));
    recordActivity(dir, "trading", "pairing-redeemed", "Some wholly novel pairing shape naming sekrit_evidence");
    const text = pairingHistoryScorecardText(dir);
    assert.equal(text, "Pairing history: attention, 1 issued, 0 redeemed, 0 lockouts, 1 distinct channels, 2 total, 1 unparseable");
    assert.equal(text.includes("novel pairing"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(pairingIssuedLedgerSummary("Dip Telegram", "2026-11-21T06:00:00.000Z"), "Pairing code issued for channel Dip Telegram (expires 2026-11-21T06:00:00.000Z)");
  assert.equal(pairingRedeemedLedgerSummary(424242, "Dip Telegram"), "Paired telegram user 424242 as an owner of channel Dip Telegram");
  assert.equal(pairingLockoutLedgerSummary("Dip Telegram", "2026-11-21T06:15:00.000Z"), "Pairing locked for channel Dip Telegram until 2026-11-21T06:15:00.000Z after repeated failed attempts");
  assert.deepEqual(parsePairingIssuedSummary(pairingIssuedLedgerSummary("Dip Telegram", "2026-11-21T06:00:00.000Z")), { channel: "Dip Telegram" });
  assert.deepEqual(parsePairingRedeemedSummary(pairingRedeemedLedgerSummary(424242, "Dip Telegram")), { channel: "Dip Telegram" });
  assert.deepEqual(parsePairingLockoutSummary(pairingLockoutLedgerSummary("Dip Telegram", "2026-11-21T06:15:00.000Z")), { channel: "Dip Telegram" });
  assert.equal(parsePairingIssuedSummary(""), null);
  assert.equal(parsePairingIssuedSummary("Pairing code issued for channel Dip Telegram (expires soon)"), null, "an unparseable expiry does not parse");
  assert.equal(parsePairingIssuedSummary("Pairing code issued for channel Dip Telegram"), null, "a truncated line does not parse");
  assert.equal(parsePairingRedeemedSummary("Paired telegram user 0 as an owner of channel Dip Telegram"), null, "a zero user id does not parse");
  assert.equal(parsePairingRedeemedSummary("Paired telegram user -5 as an owner of channel Dip Telegram"), null, "a negative user id does not parse");
  assert.equal(parsePairingLockoutSummary("Pairing locked for channel Dip Telegram until later after repeated failed attempts"), null, "an unparseable lockout stamp does not parse");
  assert.equal(parsePairingLockoutSummary("Pairing locked for channel Dip Telegram until 2026-11-21T06:15:00.000Z"), null, "a truncated line does not parse");
});

test("pairing history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-pairing-history"), "sam-pairing-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-pairing-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "pairing-history"], "the argv rides channels pairing-history");
});

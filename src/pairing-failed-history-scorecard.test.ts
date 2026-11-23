import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingFailureSummary, pairingFailedHistoryScorecardText, parsePairingFailedSummary } from "./pairing.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The pairing failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the pairing
// store's touches ledger every failure as a pairing-failed
// line through the ONE writer (pairingFailureSummary, fixed
// shape: "Pairing <phase> failed: <reason>", phases read /
// redeem / issue, ridden by recordPairingFailure from the
// store's read door, the redeem path, and the issue path,
// actor sam) - but the class was never folded, so how often
// the store that holds the pairing codes and the 5-failure
// lockout guards failed a touch was invisible in aggregate
// (the pairing history scorecard folds only the lifecycle
// lines). Every failure line is by construction a pairing
// touch that did not complete its store work, so the
// verdict is attention when any failure was ever recorded
// or any line is unparseable, else clear. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no reason, and no verbatim summary - the summaries carry
// reasons, and the fold consumes and never prints them,
// and no pairing record ever surfaces (none enters the
// writer's line either). The scorecard path is a pure
// read - it creates nothing, issues nothing, and redeems
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-pairing-failed-history-"));
}

const BARE = "Pairing failed history: clear, 0 failed, 0 read, 0 redeem, 0 issue, 0 total";

test("pairing failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = pairingFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = pairingFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held pairing scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = pairingFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("read", "EISDIR: illegal operation sekrit"));
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("read", "disk full"));
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("redeem", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("issue", "EACCES: permission denied"));
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("issue", "database is locked"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = pairingFailedHistoryScorecardText(dir);
    assert.equal(text, "Pairing failed history: attention, 5 failed, 2 read, 1 redeem, 2 issue, 5 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
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

test("pairing failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = pairingFailureSummary("redeem", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parsePairingFailedSummary(capped), { phase: "redeem" });
    recordActivity(dir, "sam", "pairing-failed", capped);
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("read", "boom"));
    const text = pairingFailedHistoryScorecardText(dir);
    assert.equal(text, "Pairing failed history: attention, 2 failed, 1 read, 1 redeem, 0 issue, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "pairing-failed", pairingFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "pairing-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "pairing-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "pairing-failed", "Pairing read failed:   ");
    recordActivity(dir, "sam", "pairing-failed", "Pairing delete failed: boom");
    const text = pairingFailedHistoryScorecardText(dir);
    assert.equal(text, "Pairing failed history: attention, 1 failed, 1 read, 0 redeem, 0 issue, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairing failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(pairingFailureSummary("read", "database is locked"), "Pairing read failed: database is locked");
  assert.equal(pairingFailureSummary("redeem", "disk gone"), "Pairing redeem failed: disk gone");
  assert.equal(pairingFailureSummary("issue", "disk gone"), "Pairing issue failed: disk gone");
  assert.deepEqual(parsePairingFailedSummary(pairingFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parsePairingFailedSummary(pairingFailureSummary("redeem", "boom")), { phase: "redeem" });
  assert.deepEqual(parsePairingFailedSummary(pairingFailureSummary("issue", "boom")), { phase: "issue" });
  assert.equal(parsePairingFailedSummary(""), null);
  assert.equal(parsePairingFailedSummary("Pairing read failed:"), null, "a line with no reason does not parse");
  assert.equal(parsePairingFailedSummary("Pairing read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parsePairingFailedSummary("Pairing delete failed: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parsePairingFailedSummary("Pairing code issued for channel Dip Telegram (expires 2026-11-21T06:00:00.000Z)"), null, "a pairing-issued line never parses as a pairing-failed line");
  assert.equal(parsePairingFailedSummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as a pairing-failed line");
  assert.deepEqual(parsePairingFailedSummary("Pairing read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("pairing failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-pairing-failed-history"), "sam-pairing-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-pairing-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "pairing-failed-history"], "the argv rides channels pairing-failed-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { deliverySuppressedHistoryScorecardText, heartbeatSuppressedLedgerSummary, parseDeliverySuppressedSummary } from "./heartbeat.js";
import { loopSuppressedLedgerSummary } from "./loop-revisit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The delivery suppressed history daily-measurement wiring
// (2026-11-22, the measured-proof series): channel updates
// the S5 worthiness gate holds have ledgered as
// delivery-suppressed lines from two seams shaped alike -
// the heartbeat tick (a changed reply held) and the
// second-answer engine's channel leg - but the class was
// never folded: the outbox scorecard folds the outbox
// store's suppressed records, not these ledger lines, so
// how many updates the gate has ever held, from which
// sender, and across how many jobs was invisible in
// aggregate. A hold is the gate working as designed, not
// an alarm, so the verdict is attention only when a line
// is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so
// it is ONE line carrying counts only: no stamp, no actor,
// no job name, no reason - the summaries carry job names
// and verbatim hold reasons, which the fold consumes and
// never prints. The scorecard path is a pure read - it
// creates nothing, sends nothing, and holds nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-delivery-suppressed-history-"));
}

const BARE = "Delivery suppressed history: clear, 0 held, heartbeat 0 / second answer 0, 0 distinct jobs, 0 total";

test("delivery suppressed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = deliverySuppressedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = deliverySuppressedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held delivery suppressed scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery suppressed history scorecard: both writers fold to counts per source, and no name or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = deliverySuppressedHistoryScorecardText(dir);
    recordActivity(dir, "trading", "delivery-suppressed", heartbeatSuppressedLedgerSummary("sekrit-job-alpha", "sekrit hold reason one"));
    recordActivity(dir, "trading", "delivery-suppressed", heartbeatSuppressedLedgerSummary("sekrit-job-alpha", "duplicate of a recent delivery"));
    recordActivity(dir, "sam", "delivery-suppressed", heartbeatSuppressedLedgerSummary("sekrit-job-beta", "law denies this topic"));
    recordActivity(dir, "sam", "delivery-suppressed", loopSuppressedLedgerSummary("sekrit loop hold reason"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = deliverySuppressedHistoryScorecardText(dir);
    assert.equal(text, "Delivery suppressed history: clear, 4 held, heartbeat 3 / second answer 1, 2 distinct jobs, 4 total");
    assert.equal(text.includes("sekrit"), false, "no job name or reason surfaces");
    assert.equal(text.includes("duplicate"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded hold changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery suppressed history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "delivery-suppressed", heartbeatSuppressedLedgerSummary("alpha", "held by law"));
    recordActivity(dir, "sam", "delivery-suppressed", "Some wholly novel suppression shape naming sekrit_evidence");
    recordActivity(dir, "sam", "delivery-suppressed", "Heartbeat 'beta' update held:");
    const text = deliverySuppressedHistoryScorecardText(dir);
    assert.equal(text, "Delivery suppressed history: attention, 1 held, heartbeat 1 / second answer 0, 1 distinct jobs, 3 total, 2 unparseable");
    assert.equal(text.includes("novel suppression"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery suppressed parse: both writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(heartbeatSuppressedLedgerSummary("stack watch", "duplicate of a recent delivery"), "Heartbeat 'stack watch' update held: duplicate of a recent delivery");
  assert.equal(loopSuppressedLedgerSummary("law denies this topic"), "Second-answer channel update held: law denies this topic");
  assert.deepEqual(parseDeliverySuppressedSummary(heartbeatSuppressedLedgerSummary("stack watch", "duplicate")), { source: "heartbeat", job: "stack watch" });
  assert.deepEqual(parseDeliverySuppressedSummary(loopSuppressedLedgerSummary("held")), { source: "second-answer", job: null });
  assert.equal(parseDeliverySuppressedSummary(""), null);
  assert.equal(parseDeliverySuppressedSummary("Heartbeat 'x' update held:"), null, "a line missing the reason does not parse");
  assert.equal(parseDeliverySuppressedSummary("Heartbeat 'x' update held: "), null, "a line with an empty reason does not parse");
  assert.equal(parseDeliverySuppressedSummary("Delivery for heartbeat 'x' failed (attempt 2 of 5): boom"), null, "a delivery-failed line never parses as a hold");
  assert.equal(parseDeliverySuppressedSummary("Email 'x' update held: boom"), null, "a source outside the fixed vocabulary does not parse");
});

test("delivery suppressed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-delivery-suppressed-history"), "sam-delivery-suppressed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-delivery-suppressed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "suppressed-history"], "the argv rides heartbeats suppressed-history");
});

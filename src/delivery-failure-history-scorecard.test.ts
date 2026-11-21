import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { deliveryFailureHistoryScorecardText, deliveryFailureSummary, parseDeliveryFailureSummary } from "./heartbeat.js";
import { loopDeliveryFailureSummary } from "./loop-revisit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The delivery failure history daily-measurement wiring
// (2026-11-21, the measured-proof series): failed channel
// deliveries have ledgered as delivery-failed lines since
// 2026-11-13 from two writers shaped alike - the heartbeat
// tick's two send paths and the second-answer engine's
// channel leg - but the class was never folded: the outbox
// scorecard folds the outbox store, not these ledger lines,
// so how many deliveries ever failed, from which sender,
// how many attempts they burned, and how many settled as
// gave-up was invisible in aggregate. Every line in this
// family is a failure, so the verdict is attention when any
// line exists or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no job name, no reason - the summaries
// carry job names and verbatim failure reasons, which the
// fold consumes and never prints. The scorecard path is a
// pure read - it creates nothing, sends nothing, and
// retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seams'
// own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-delivery-failure-history-"));
}

const BARE = "Delivery failure history: clear, 0 failed, heartbeat 0 / second answer 0, 0 settled, 0 attempts, 0 distinct jobs, 0 total";

test("delivery failure history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = deliveryFailureHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = deliveryFailureHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held delivery failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery failure history scorecard: both writers fold to counts per source with settled and attempts, and no name or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = deliveryFailureHistoryScorecardText(dir);
    recordActivity(dir, "trading", "delivery-failed", deliveryFailureSummary("sekrit-job-alpha", "fetch failed: sekrit transport reason", 1, false));
    recordActivity(dir, "trading", "delivery-failed", deliveryFailureSummary("sekrit-job-alpha", "fetch failed", 5, true));
    recordActivity(dir, "sam", "delivery-failed", deliveryFailureSummary("sekrit-job-beta", "socket hang up", 2, false));
    recordActivity(dir, "sam", "delivery-failed", loopDeliveryFailureSummary("fetch failed: sekrit loop reason", 3, false));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = deliveryFailureHistoryScorecardText(dir);
    assert.equal(text, "Delivery failure history: attention, 4 failed, heartbeat 3 / second answer 1, 1 settled, 11 attempts, 2 distinct jobs, 4 total");
    assert.equal(text.includes("sekrit"), false, "no job name or reason surfaces");
    assert.equal(text.includes("fetch failed"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery failure history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "delivery-failed", deliveryFailureSummary("alpha", "boom", 1, false));
    recordActivity(dir, "sam", "delivery-failed", "Some wholly novel delivery shape naming sekrit_evidence");
    recordActivity(dir, "sam", "delivery-failed", "Delivery for heartbeat 'beta' failed (attempt 0 of 5): zero attempts is not a shape the writers write");
    const text = deliveryFailureHistoryScorecardText(dir);
    assert.equal(text, "Delivery failure history: attention, 1 failed, heartbeat 1 / second answer 0, 0 settled, 1 attempts, 1 distinct jobs, 3 total, 2 unparseable");
    assert.equal(text.includes("novel delivery"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery failure parse: both writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(deliveryFailureSummary("stack watch", "fetch failed", 2, false), "Delivery for heartbeat 'stack watch' failed (attempt 2 of 5): fetch failed");
  assert.equal(deliveryFailureSummary("stack watch", "fetch failed", 5, true), "Delivery for heartbeat 'stack watch' failed (attempt 5 of 5): fetch failed - gave up after 5 attempts; the update will not be retried");
  assert.equal(loopDeliveryFailureSummary("fetch failed", 4, false), "Delivery for second answer failed (attempt 4 of 5): fetch failed");
  assert.deepEqual(parseDeliveryFailureSummary(deliveryFailureSummary("stack watch", "fetch failed", 2, false)), { source: "heartbeat", job: "stack watch", attempts: 2, settled: false });
  assert.deepEqual(parseDeliveryFailureSummary(deliveryFailureSummary("stack watch", "fetch failed", 5, true)), { source: "heartbeat", job: "stack watch", attempts: 5, settled: true });
  assert.deepEqual(parseDeliveryFailureSummary(loopDeliveryFailureSummary("fetch failed", 4, false)), { source: "second-answer", job: null, attempts: 4, settled: false });
  assert.deepEqual(parseDeliveryFailureSummary(loopDeliveryFailureSummary("fetch failed", 5, true)), { source: "second-answer", job: null, attempts: 5, settled: true });
  assert.equal(parseDeliveryFailureSummary(""), null);
  assert.equal(parseDeliveryFailureSummary("Delivery for heartbeat 'x' failed (attempt 2 of 5)"), null, "a line missing the reason does not parse");
  assert.equal(parseDeliveryFailureSummary("Delivery for email 'x' failed (attempt 2 of 5): boom"), null, "a source outside the fixed vocabulary does not parse");
});

test("delivery failure history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-delivery-failure-history"), "sam-delivery-failure-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-delivery-failure-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "delivery-failure-history"], "the argv rides heartbeats delivery-failure-history");
});

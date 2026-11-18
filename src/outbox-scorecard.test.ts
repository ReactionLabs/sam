import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markAttemptFailed, markDelivered, markSuppressed, outboxScorecardText, queueDelivery } from "./delivery-outbox.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The delivery-outbox daily-measurement wiring (2026-11-18,
// the measured-proof series' census tail): the worthiness
// scorecard trends the gate's verdicts, but the durable
// outbox's outcomes - pending, recovered, settled-failed -
// had no trending surface, so a delivery the gate approved
// could fail to send and sit invisible. The scorecard text
// is a script job's stdout and is P3-diffed on its facts,
// so it carries counts only: no stamp, no delivery text,
// no job name, no channel id, no reason. The scorecard
// path is a pure read - it creates nothing, sends nothing,
// retries nothing, and settles nothing; every state here
// is built through the outbox's own public doors
// (queueDelivery / markDelivered / markSuppressed /
// markAttemptFailed), never around them.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-outbox-scorecard-"));
}

function queue(root: string, marker: string) {
  return queueDelivery(root, {
    jobId: "job-" + marker,
    jobName: "job-name-" + marker,
    profile: "sam",
    channelId: "channel-" + marker,
    text: "delivery text " + marker,
  });
}

test("outbox scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = outboxScorecardText(dir);
    assert.match(text, /^Delivery outbox: clear$/m);
    assert.match(text, /^Pending: 0$/m);
    assert.match(text, /^Delivered: 0$/m);
    assert.match(text, /^Suppressed: 0$/m);
    assert.match(text, /^Failed: 0$/m);
    assert.match(text, /^Recovered: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = outboxScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held outbox scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox scorecard: a queued delivery flips the verdict and leaks no content", () => {
  const dir = scratch();
  try {
    const clean = outboxScorecardText(dir);
    queue(dir, "sekrit");
    const text = outboxScorecardText(dir);
    assert.match(text, /^Delivery outbox: attention$/m);
    assert.match(text, /^Pending: 1$/m);
    assert.equal(text.includes("sekrit"), false, "no marker from the record surfaces");
    assert.equal(text.includes("delivery text"), false, "delivery text never surfaces");
    assert.equal(text.includes("job-name"), false, "job names never surface");
    assert.equal(text.includes("channel-"), false, "channel ids never surface");
    assert.notEqual(text, clean, "the first owed delivery changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox scorecard: delivered, suppressed, recovered, and settled-failed fold to counts", () => {
  const dir = scratch();
  try {
    const delivered = queue(dir, "one");
    markDelivered(dir, delivered.id, false);
    const suppressed = queue(dir, "two");
    markSuppressed(dir, suppressed.id, "held by the worthiness gate: duplicate");
    const recovered = queue(dir, "three");
    markAttemptFailed(dir, recovered.id, "channel down reason three");
    markDelivered(dir, recovered.id, true);
    const failed = queue(dir, "four");
    for (let i = 0; i < 5; i++) markAttemptFailed(dir, failed.id, "channel down reason four");
    const text = outboxScorecardText(dir);
    assert.match(text, /^Delivery outbox: attention$/m, "a settled-failed delivery is owed attention");
    assert.match(text, /^Pending: 0$/m);
    assert.match(text, /^Delivered: 2$/m);
    assert.match(text, /^Suppressed: 1$/m);
    assert.match(text, /^Failed: 1$/m);
    assert.match(text, /^Recovered: 1$/m);
    assert.equal(text.includes("duplicate"), false, "suppression reasons never surface");
    assert.equal(text.includes("channel down"), false, "failure reasons never surface");
    const again = outboxScorecardText(dir);
    assert.equal(again, text, "the folded state is stable across reads");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox scorecard: the allowlist argv rides heartbeats outbox-scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-outbox"));
  const argv = scriptArgv("/tmp/sam-root", "sam-outbox");
  assert.ok(argv);
  assert.deepEqual(argv.slice(-2), ["heartbeats", "outbox-scorecard"]);
  assert.ok(argv.includes("/tmp/sam-root"));
});

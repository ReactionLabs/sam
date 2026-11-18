import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { bridgePollBucket, bridgePollFailureSummary, bridgePollScorecardText } from "./telegram.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The bridge-poll daily-measurement wiring (2026-11-18,
// the measured-proof series): the Telegram bridge ledgers
// every poll failure burst, coalesced, and it is the
// largest failure class in the live ledger - but no daily
// surface ever counted it, so a degrading network path to
// Telegram was invisible except as scattered ledger lines.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no channel name, no actor, no verbatim reason -
// reasons fold into fixed in-code buckets and an unmatched
// reason is "other", never printed. The scorecard path is
// a pure read - it creates nothing, spends no model call,
// and retries nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// bridge seam's own summary writer
// (bridgePollFailureSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-bridge-poll-scorecard-"));
}

test("bridge poll scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = bridgePollScorecardText(dir);
    assert.match(text, /^Bridge poll failures: clear$/m);
    assert.match(text, /^Failed poll bursts: 0$/m);
    assert.match(text, /^By reason: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = bridgePollScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held bridge-poll scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bridge poll scorecard: failed bursts flip the verdict, fold to fixed buckets, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = bridgePollScorecardText(dir);
    recordActivity(dir, "sam", "bridge-poll-failed", bridgePollFailureSummary("Sekrit Channel", new Error("fetch failed")));
    recordActivity(dir, "sam", "bridge-poll-failed", bridgePollFailureSummary("Sekrit Channel", new Error("fetch failed: read ETIMEDOUT")));
    recordActivity(dir, "sam", "bridge-poll-failed", bridgePollFailureSummary("Sekrit Channel", new Error("fetch failed: read ECONNRESET")));
    recordActivity(dir, "sam", "bridge-poll-failed", bridgePollFailureSummary("Sekrit Channel", new Error("Telegram request failed (HTTP 502)")));
    recordActivity(dir, "sam", "bridge-poll-failed", "Some wholly novel poll failure mentioning Sekrit Channel");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = bridgePollScorecardText(dir);
    assert.match(text, /^Bridge poll failures: attention$/m);
    assert.match(text, /^Failed poll bursts: 5$/m);
    assert.match(text, /^By reason: http 1, network 1, other 1, reset 1, timeout 1$/m);
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("novel poll failure"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first failed burst changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bridge poll bucket: every fixed shape classifies, and only into the fixed enum", () => {
  assert.equal(bridgePollBucket(bridgePollFailureSummary("c", new Error("fetch failed"))), "network");
  assert.equal(bridgePollBucket(bridgePollFailureSummary("c", new Error("fetch failed: read ETIMEDOUT"))), "timeout");
  assert.equal(bridgePollBucket(bridgePollFailureSummary("c", new Error("fetch failed: Connect Timeout Error (attempted addresses: 2001:67c:2b0::)"))), "timeout");
  assert.equal(bridgePollBucket(bridgePollFailureSummary("c", new Error("fetch failed: read ECONNRESET"))), "reset");
  assert.equal(bridgePollBucket(bridgePollFailureSummary("c", new Error("Telegram request failed (HTTP 504)"))), "http");
  assert.equal(bridgePollBucket(""), "other");
  assert.equal(bridgePollBucket("Some wholly novel poll failure"), "other");
});

test("bridge poll scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-bridge-polls"), "sam-bridge-polls is allowlisted");
  const argv = scriptArgv("/some/root", "sam-bridge-polls");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "poll-scorecard"], "the argv rides channels poll-scorecard");
});

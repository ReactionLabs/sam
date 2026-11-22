import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { bridgeFailedHistoryScorecardText, bridgeFailureSummary, bridgePollFailureSummary, parseBridgeFailedSummary } from "./telegram.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The bridge failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the Telegram
// bridge ledgers every thrown update handler as a
// bridge-failed line through the ONE writer
// bridgeFailureSummary - the update stays consumed, so the
// line is the only trace a lost owner message leaves - but
// the class was never folded, so how often an update died
// in the handler was invisible in aggregate (its sibling
// class, bridge-poll-failed, already has its poll
// scorecard). Every failure line is by construction an
// update whose handler threw, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no
// channel name, no update id, and no verbatim reason - the
// summaries carry channel names, update ids, and reasons,
// which the fold consumes and never prints; distinct
// channels surface as a number only. The scorecard path is
// a pure read - it creates nothing, sends nothing, retries
// no update, and touches no channel; every state here is
// built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-bridge-failed-history-"));
}

const BARE = "Bridge failed history: clear, 0 failed, 0 distinct channels, 0 total";

test("bridge failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = bridgeFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = bridgeFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held bridge scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bridge failed history scorecard: the writer's failures fold to counts with distinct channels as a number only, and no channel, update id, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = bridgeFailedHistoryScorecardText(dir);
    recordActivity(dir, "trading", "bridge-failed", bridgeFailureSummary("Dip Telegram", 4242, new Error("EISDIR: illegal operation on a directory, open sekrit-path")));
    recordActivity(dir, "trading", "bridge-failed", bridgeFailureSummary("Dip Telegram", 4243, new Error("EPERM: operation not permitted")));
    recordActivity(dir, "sam", "bridge-failed", bridgeFailureSummary("Second Channel", 77, new Error("boom")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = bridgeFailedHistoryScorecardText(dir);
    assert.equal(text, "Bridge failed history: attention, 3 failed, 2 distinct channels, 3 total");
    assert.equal(text.includes("Dip Telegram"), false, "no channel name surfaces");
    assert.equal(text.includes("Second Channel"), false, "no channel name surfaces");
    assert.equal(text.includes("4242"), false, "no update id surfaces");
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

test("bridge failed history scorecard: the writer's own 200-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = bridgeFailureSummary("Dip Telegram", 42, new Error("x".repeat(500)));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "trading", "bridge-failed", capped);
    assert.deepEqual(parseBridgeFailedSummary(capped), { channel: "Dip Telegram" });
    const text = bridgeFailedHistoryScorecardText(dir);
    assert.equal(text, "Bridge failed history: attention, 1 failed, 1 distinct channels, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bridge failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "trading", "bridge-failed", bridgeFailureSummary("Dip Telegram", 42, new Error("EPERM: operation not permitted")));
    recordActivity(dir, "trading", "bridge-failed", "Some wholly novel bridge shape naming sekrit_person");
    recordActivity(dir, "trading", "bridge-failed", bridgePollFailureSummary("Dip Telegram", new Error("fetch failed sekrit")));
    recordActivity(dir, "trading", "bridge-failed", "Telegram bridge failed on update 42 for channel Dip Telegram:   ");
    const text = bridgeFailedHistoryScorecardText(dir);
    assert.equal(text, "Bridge failed history: attention, 1 failed, 1 distinct channels, 4 total, 3 unparseable");
    assert.equal(text.includes("novel bridge"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("Dip Telegram"), false, "no channel name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bridge failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    bridgeFailureSummary("Dip Telegram", 42, new Error("EPERM: operation not permitted")),
    "Telegram bridge failed on update 42 for channel Dip Telegram: EPERM: operation not permitted",
  );
  assert.deepEqual(parseBridgeFailedSummary(bridgeFailureSummary("Dip Telegram", 42, new Error("boom"))), { channel: "Dip Telegram" });
  assert.equal(parseBridgeFailedSummary(""), null);
  assert.equal(parseBridgeFailedSummary("Telegram bridge failed on update 42 for channel Dip Telegram:"), null, "a line with no reason does not parse");
  assert.equal(parseBridgeFailedSummary("Telegram bridge failed on update 42 for channel Dip Telegram: "), null, "a line with a blank reason does not parse");
  assert.equal(parseBridgeFailedSummary("Telegram bridge failed on update abc for channel Dip Telegram: boom"), null, "a non-numeric update id does not parse");
  assert.equal(parseBridgeFailedSummary("Telegram bridge failed on update 42 for channel : boom"), null, "a blank channel does not parse");
  assert.equal(parseBridgeFailedSummary(bridgePollFailureSummary("Dip Telegram", new Error("boom"))), null, "a bridge-poll-failed line never parses as a bridge-failed line");
  assert.deepEqual(parseBridgeFailedSummary("Telegram bridge failed on update 42 for channel Dip Telegram: boom: with colon"), { channel: "Dip Telegram" }, "a reason carrying a colon still parses from the fixed head");
});

test("bridge failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-bridge-failed-history"), "sam-bridge-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-bridge-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "failed-history"], "the argv rides channels failed-history");
});

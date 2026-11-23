import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRateLimitFailedSummary, rateLimitFailedHistoryScorecardText, rateLimitFailureSummary } from "./rate-limit.js";
import { recordActivity } from "./activity.js";
import { sessionCapsFailureSummary } from "./session-caps.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The rate-limit failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the rate-limit
// episode store ledgers every failed touch as a
// rate-limit-failed line through the ONE writer
// rateLimitFailureSummary, ridden by the one seam
// recordRateLimitFailure (a failed open / read / close
// ledgers ONE line and rethrows exactly, tagged, so
// agent-turn's fallbacks stay countable) - but the class was
// never folded, so how often the grace mechanism's own store
// failed was invisible in aggregate. Every failure line is
// by construction an episode touch that did not complete, so
// the verdict is attention when any failure was ever
// recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no phase name, no chat prefix, and no
// verbatim reason - the summaries carry chat prefixes and
// reasons, and the fold consumes and never prints them. The
// scorecard path is a pure read - it creates nothing, sends
// nothing, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-rate-limit-failed-history-"));
}

const BARE = "Rate limit failed history: clear, 0 failed, 0 distinct phases, 0 distinct chats, 0 total";

test("rate limit failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = rateLimitFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = rateLimitFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held rate-limit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rate limit failed history scorecard: the writer's failures fold to counts with distinct phases and chats as numbers only, and no chat or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = rateLimitFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "rate-limit-failed", rateLimitFailureSummary("open", "unable to open database file sekrit", "chat-abcdef123456"));
    recordActivity(dir, "sam", "rate-limit-failed", rateLimitFailureSummary("open", "disk full", "chat-abcdef123456"));
    recordActivity(dir, "sam", "rate-limit-failed", rateLimitFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "rate-limit-failed", rateLimitFailureSummary("close", "database is locked", "chat-zzzz9999"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = rateLimitFailedHistoryScorecardText(dir);
    assert.equal(text, "Rate limit failed history: attention, 4 failed, 3 distinct phases, 2 distinct chats, 4 total");
    assert.equal(text.includes("chat-abc"), false, "no chat prefix surfaces");
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

test("rate limit failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = rateLimitFailureSummary("open", "x".repeat(500), "chat-abcdef123456");
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseRateLimitFailedSummary(capped), { phase: "open", chat: "chat-abc" });
    recordActivity(dir, "sam", "rate-limit-failed", capped);
    const text = rateLimitFailedHistoryScorecardText(dir);
    assert.equal(text, "Rate limit failed history: attention, 1 failed, 1 distinct phases, 1 distinct chats, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rate limit failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "rate-limit-failed", rateLimitFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "rate-limit-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "rate-limit-failed", sessionCapsFailureSummary("ledger read", "chat-abcdef123456", "boom sekrit"));
    recordActivity(dir, "sam", "rate-limit-failed", "Rate limit read failed:   ");
    const text = rateLimitFailedHistoryScorecardText(dir);
    assert.equal(text, "Rate limit failed history: attention, 1 failed, 1 distinct phases, 0 distinct chats, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rate limit failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    rateLimitFailureSummary("open", "EPERM: operation not permitted", "chat-abcdef123456"),
    "Rate limit open failed for chat chat-abc: EPERM: operation not permitted",
  );
  assert.equal(
    rateLimitFailureSummary("read", "EPERM: operation not permitted"),
    "Rate limit read failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseRateLimitFailedSummary(rateLimitFailureSummary("close", "boom")), { phase: "close", chat: null });
  assert.deepEqual(parseRateLimitFailedSummary(rateLimitFailureSummary("open", "boom", "chat-abcdef123456")), { phase: "open", chat: "chat-abc" });
  assert.equal(parseRateLimitFailedSummary(""), null);
  assert.equal(parseRateLimitFailedSummary("Rate limit read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseRateLimitFailedSummary("Rate limit read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseRateLimitFailedSummary("Rate limit write failed: boom"), null, "a phase the seams never write does not parse");
  assert.equal(parseRateLimitFailedSummary("Rate limit open failed for chat chat-abcdef: boom"), null, "a chat segment longer than the writer's 8-char slice does not parse");
  assert.equal(parseRateLimitFailedSummary(sessionCapsFailureSummary("ledger read", "chat-abcdef123456", "boom")), null, "a session-caps-failed line never parses as a rate-limit-failed line");
  assert.deepEqual(parseRateLimitFailedSummary("Rate limit read failed: boom: with colon"), { phase: "read", chat: null }, "a reason carrying a colon still parses from the fixed head");
});

test("rate limit failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-rate-limit-failed-history"), "sam-rate-limit-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-rate-limit-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "rate-limit-failed-history"], "the argv rides observe rate-limit-failed-history");
});

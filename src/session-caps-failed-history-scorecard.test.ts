import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionCapsFailedSummary, sessionCapsFailedHistoryScorecardText, sessionCapsFailureSummary } from "./session-caps.js";
import { recordActivity } from "./activity.js";
import { rateLimitFailureSummary } from "./rate-limit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The session caps failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the session caps
// ledger ledgers every failed touch as a session-caps-failed
// line through the ONE writer sessionCapsFailureSummary,
// ridden by the one seam recordSessionCapsFailure (a failed
// ledger read ledgers and rethrows fail-closed, a failed turn
// record or cap trip ledgers best-effort) - but the class was
// never folded, so how often the spend bound's own ledger
// died was invisible in aggregate. Every failure line is by
// construction a caps touch that did not complete, so the
// verdict is attention when any failure was ever recorded or
// any line is unparseable, else clear. The scorecard text is
// a script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// operation name, no chat prefix, and no verbatim reason -
// the summaries carry chat prefixes and reasons, and the
// fold consumes and never prints them. The scorecard path
// is a pure read - it creates nothing, sends nothing, and
// retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-session-caps-failed-history-"));
}

const BARE = "Session caps failed history: clear, 0 failed, 0 distinct operations, 0 distinct chats, 0 total";

test("session caps failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = sessionCapsFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = sessionCapsFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held session caps scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session caps failed history scorecard: the writer's failures fold to counts with distinct operations and chats as numbers only, and no chat or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = sessionCapsFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "session-caps-failed", sessionCapsFailureSummary("turn record", "chat-abcdef123456", "unable to open database file sekrit"));
    recordActivity(dir, "sam", "session-caps-failed", sessionCapsFailureSummary("turn record", "chat-abcdef123456", "disk full"));
    recordActivity(dir, "sam", "session-caps-failed", sessionCapsFailureSummary("ledger read", "", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "session-caps-failed", sessionCapsFailureSummary("cap trip", "chat-zzzz9999", "database is locked"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = sessionCapsFailedHistoryScorecardText(dir);
    assert.equal(text, "Session caps failed history: attention, 4 failed, 3 distinct operations, 2 distinct chats, 4 total");
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

test("session caps failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = sessionCapsFailureSummary("turn record", "chat-abcdef123456", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseSessionCapsFailedSummary(capped), { what: "turn record", chat: "chat-abc" });
    recordActivity(dir, "sam", "session-caps-failed", capped);
    const text = sessionCapsFailedHistoryScorecardText(dir);
    assert.equal(text, "Session caps failed history: attention, 1 failed, 1 distinct operations, 1 distinct chats, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session caps failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "session-caps-failed", sessionCapsFailureSummary("ledger read", "", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "session-caps-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "session-caps-failed", rateLimitFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "session-caps-failed", "Session caps ledger read failed:   ");
    const text = sessionCapsFailedHistoryScorecardText(dir);
    assert.equal(text, "Session caps failed history: attention, 1 failed, 1 distinct operations, 0 distinct chats, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session caps failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    sessionCapsFailureSummary("turn record", "chat-abcdef123456", "EPERM: operation not permitted"),
    "Session caps turn record failed for chat chat-abc: EPERM: operation not permitted",
  );
  assert.equal(
    sessionCapsFailureSummary("ledger read", "", "EPERM: operation not permitted"),
    "Session caps ledger read failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseSessionCapsFailedSummary(sessionCapsFailureSummary("ledger read", "", "boom")), { what: "ledger read", chat: null });
  assert.deepEqual(parseSessionCapsFailedSummary(sessionCapsFailureSummary("ledger read", "chat-abcdef123456", "boom")), { what: "ledger read", chat: "chat-abc" });
  assert.deepEqual(parseSessionCapsFailedSummary(sessionCapsFailureSummary("cap trip", "chat-abcdef123456", "boom")), { what: "cap trip", chat: "chat-abc" });
  assert.equal(parseSessionCapsFailedSummary(""), null);
  assert.equal(parseSessionCapsFailedSummary("Session caps ledger read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseSessionCapsFailedSummary("Session caps ledger read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseSessionCapsFailedSummary("Session caps write failed: boom"), null, "a what the seams never write does not parse");
  assert.equal(parseSessionCapsFailedSummary("Session caps turn record failed: boom"), null, "a turn record with no chat does not parse");
  assert.equal(parseSessionCapsFailedSummary("Session caps turn record failed for chat chat-abcdef: boom"), null, "a chat segment longer than the writer's 8-char slice does not parse");
  assert.equal(parseSessionCapsFailedSummary(rateLimitFailureSummary("read", "boom")), null, "a rate-limit-failed line never parses as a session-caps-failed line");
  assert.deepEqual(parseSessionCapsFailedSummary("Session caps ledger read failed: boom: with colon"), { what: "ledger read", chat: null }, "a reason carrying a colon still parses from the fixed head");
});

test("session caps failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-session-caps-failed-history"), "sam-session-caps-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-session-caps-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "session-caps-failed-history"], "the argv rides observe session-caps-failed-history");
});

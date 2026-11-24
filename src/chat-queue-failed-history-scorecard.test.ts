import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatQueueFailedHistoryScorecardText, chatQueueFailureSummary, parseChatQueueFailedSummary } from "./chat-queue-failure.js";
import { recordActivity } from "./activity.js";
import { captureGuardFailureSummary } from "./capture-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The chat queue failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the chat queue
// store's touches ledger every failure as a
// chat-queue-failed line through the ONE writer
// (chatQueueFailureSummary, fixed shape "Chat queue store
// <phase> failed: <reason>", capped 200; phases read /
// write, ridden by recordChatQueueFailure from the two
// store modules, actor sam) - and while self-work labels
// single lines and the message / intervention / reset
// scorecards fold the queue's other kinds, no surface folds
// this kind, so which phase of the queue every owner
// message is accounted in failed was invisible in
// aggregate. Every failure line is by construction a store
// touch that did not complete, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no reason, and no
// verbatim summary - the summaries carry reasons, and the
// fold consumes and never prints them, and no queue record
// (message content is the owner's words) ever surfaces.
// The scorecard path is a pure read - it creates nothing,
// updates nothing, and reads no queue record; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chat-queue-failed-history-"));
}

const BARE = "Chat queue failed history: clear, 0 failed, 0 read, 0 write, 0 total";

test("chat queue failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = chatQueueFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = chatQueueFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held chat queue scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat queue failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = chatQueueFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "chat-queue-failed", chatQueueFailureSummary("read", "unable to open sekrit database"));
    recordActivity(dir, "sam", "chat-queue-failed", chatQueueFailureSummary("write", "disk full"));
    recordActivity(dir, "sam", "chat-queue-failed", chatQueueFailureSummary("write", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = chatQueueFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat queue failed history: attention, 3 failed, 1 read, 2 write, 3 total");
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

test("chat queue failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = chatQueueFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseChatQueueFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "chat-queue-failed", capped);
    recordActivity(dir, "sam", "chat-queue-failed", chatQueueFailureSummary("read", "boom"));
    const text = chatQueueFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat queue failed history: attention, 2 failed, 1 read, 1 write, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat queue failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "chat-queue-failed", chatQueueFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "chat-queue-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "chat-queue-failed", captureGuardFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "chat-queue-failed", "Chat queue store read failed:   ");
    recordActivity(dir, "sam", "chat-queue-failed", "Chat queue store delete failed: boom");
    const text = chatQueueFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat queue failed history: attention, 1 failed, 1 read, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat queue failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(chatQueueFailureSummary("read", "database is locked"), "Chat queue store read failed: database is locked");
  assert.equal(chatQueueFailureSummary("write", "disk gone"), "Chat queue store write failed: disk gone");
  assert.deepEqual(parseChatQueueFailedSummary(chatQueueFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseChatQueueFailedSummary(chatQueueFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseChatQueueFailedSummary(""), null);
  assert.equal(parseChatQueueFailedSummary("Chat queue store read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseChatQueueFailedSummary("Chat queue store read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseChatQueueFailedSummary("Chat queue store delete failed: boom"), null, "a phase the store never writes does not parse");
  assert.equal(parseChatQueueFailedSummary(captureGuardFailureSummary("read", "boom")), null, "a capture-guard-failed line never parses as a chat-queue-failed line");
  assert.deepEqual(parseChatQueueFailedSummary("Chat queue store write failed: boom: with colon"), { phase: "write" }, "a reason carrying a colon still parses from the fixed head");
});

test("chat queue failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-chat-queue-failed-history"), "sam-chat-queue-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-chat-queue-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "chat-queue-failed-history"], "the argv rides observe chat-queue-failed-history");
});

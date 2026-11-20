import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { turnFailureNoteSummary } from "./agent-turn.js";
import { messageSteerLedgerSummary, messageStopLedgerSummary } from "./budgets.js";
import {
  messageExtrasScorecardText,
  messageResentLedgerSummary,
  messageStatusLedgerSummary,
  parseMessageResentSummary,
  parseMessageStatusSummary,
  parseMessageSteerSummary,
  parseTurnFailureNoteSummary,
} from "./chat-queue.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The message-extras daily-measurement wiring (2026-11-20,
// the measured-proof series, census-finish sprint): every
// mid-turn owner steer, every resend of a failed message,
// every runtime-answered status check, and every turn
// failure note has ledgered as a message-steer /
// message-resent / message-status / turn-failure-note line
// since each seam landed - one line per act, in the fixed
// shapes the seams write, carrying an eight-character chat
// prefix and, on the failure note, the error reason - but
// the classes were never folded, so the texture of the
// owner's message lifecycle was invisible in aggregate.
// Steering, resending, and status checks are owner acts and
// stay clear; a failure note means a turn died, so its
// presence (or a malformed line) is the attention verdict.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no chat id, no error reason - a
// fold that printed reasons would change on every new
// failure even at an identical shape. The scorecard path is
// a pure read - it creates nothing, retries nothing, and
// resends nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seams'
// own summary writers, never around either. (The
// message-failed class itself already has its own
// scorecard; this fold deliberately does not duplicate it.)

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-message-extras-"));
}

test("message extras scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = messageExtrasScorecardText(dir);
    assert.equal(text, "Message extras: clear, 0 steered (0 messages), 0 resent, 0 status checks, 0 failure notes, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = messageExtrasScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held message extras scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message extras scorecard: the live census shape folds to counts and no chat id or error reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = messageExtrasScorecardText(dir);
    recordActivity(dir, "owner", "message-steer", messageSteerLedgerSummary(1));
    recordActivity(dir, "owner", "message-steer", messageSteerLedgerSummary(1));
    recordActivity(dir, "owner", "message-resent", messageResentLedgerSummary("dffe3075-1111-4222-8333-444444444444"));
    recordActivity(dir, "owner", "message-status", messageStatusLedgerSummary("6b222963-1111-4222-8333-444444444444"));
    recordActivity(dir, "sam", "turn-failure-note", turnFailureNoteSummary("48d8efb2-1111-4222-8333-444444444444", new Error("Unsafe model output")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = messageExtrasScorecardText(dir);
    assert.equal(text, "Message extras: attention, 2 steered (2 messages), 1 resent, 1 status checks, 1 failure notes, 5 total");
    assert.equal(text.includes("dffe3075"), false, "no chat id surfaces");
    assert.equal(text.includes("48d8efb2"), false, "no chat id surfaces");
    assert.equal(text.includes("Unsafe"), false, "no error reason surfaces");
    assert.notEqual(text, clean, "the first message extra changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message extras scorecard: owner acts alone stay clear, and an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "message-steer", messageSteerLedgerSummary(3));
    recordActivity(dir, "owner", "message-resent", messageResentLedgerSummary("dffe3075-1111-4222-8333-444444444444"));
    assert.equal(messageExtrasScorecardText(dir), "Message extras: clear, 1 steered (3 messages), 1 resent, 0 status checks, 0 failure notes, 2 total");
    recordActivity(dir, "owner", "message-steer", "Some wholly novel steer shape mentioning sekrit chats");
    recordActivity(dir, "sam", "turn-failure-note", "A failure note in a novel shape");
    const text = messageExtrasScorecardText(dir);
    assert.equal(text, "Message extras: attention, 1 steered (3 messages), 1 resent, 0 status checks, 0 failure notes, 2 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message extras parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(messageSteerLedgerSummary(1), "Owner sent 1 message(s) mid-turn; folded into the running turn, the latest governs");
  assert.equal(messageSteerLedgerSummary(3), "Owner sent 3 message(s) mid-turn; folded into the running turn, the latest governs");
  assert.equal(messageStopLedgerSummary(12), "Owner said stop mid-turn after 12 calls; the turn closes with an accounting");
  assert.equal(
    messageResentLedgerSummary("dffe3075-1111-4222-8333-444444444444"),
    "Owner resent a failed message in chat dffe3075; the saved message is queued again over its original row - no second copy is saved",
  );
  assert.equal(
    messageStatusLedgerSummary("6b222963-1111-4222-8333-444444444444"),
    "Owner status check in chat 6b222963 answered by the runtime while a turn runs; the turn was not disturbed and the model was not called",
  );
  assert.equal(
    turnFailureNoteSummary("48d8efb2-1111-4222-8333-444444444444", new Error("Unsafe model output")),
    "Turn failure noted in chat 48d8efb2: the owner reads one plain sentence in the chat (the raw error never reaches the owner); error: Unsafe model output",
  );
  assert.deepEqual(parseMessageSteerSummary(messageSteerLedgerSummary(3)), { messages: 3 });
  assert.deepEqual(parseMessageResentSummary(messageResentLedgerSummary("dffe3075-1111-4222-8333-444444444444")), {});
  assert.deepEqual(parseMessageStatusSummary(messageStatusLedgerSummary("6b222963-1111-4222-8333-444444444444")), {});
  assert.deepEqual(parseTurnFailureNoteSummary(turnFailureNoteSummary("48d8efb2-1111-4222-8333-444444444444", new Error("Unsafe model output"))), {});
  assert.equal(parseMessageSteerSummary(""), null);
  assert.equal(parseMessageSteerSummary("Owner sent message(s) mid-turn"), null, "a steer line with no count does not parse");
  assert.equal(parseMessageResentSummary("Owner resent a failed message in chat dffe3075"), null, "a truncated resent line does not parse");
  assert.equal(parseMessageStatusSummary("Owner status check in chat 6b222963 answered by the runtime"), null, "a truncated status line does not parse");
  assert.equal(parseTurnFailureNoteSummary("Turn failure noted in chat 48d8efb2"), null, "a truncated failure note does not parse");
});

test("message extras scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-message-extras"), "sam-message-extras is allowlisted");
  const argv = scriptArgv("/some/root", "sam-message-extras");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "message-extras-scorecard"], "the argv rides observe message-extras-scorecard");
});

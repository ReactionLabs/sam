import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { budgetContinuedSummary, parseBudgetContinuedSummary, steerLedgerSummary, stopMidTurnLedgerSummary } from "./budgets.js";
import { interventionScorecardText, messageFoldLedgerSummary, messageResentLedgerSummary, messageStatusLedgerSummary, nevermindLedgerSummary, parseFoldSummary, parseNevermindSummary, parseResentSummary, parseStatusSummary, parseSteerSummary, parseStopSummary, stopChatLedgerSummary } from "./chat-queue.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The owner-intervention daily-measurement wiring (2026-11-20,
// the measured-proof series): the owner's interventions in a
// running or queued turn have ledgered across seven kinds
// since the burst-and-steer design landed - one line per
// steer batch, stop, nevermind, fold, status check, resend,
// and budget continuation, in the fixed shapes the seams'
// ONE writers write - but the family was never folded, so
// how often the owner reaches in, and how often the reach is
// a stop, was invisible in aggregate. A stop is the owner
// halting work, so the verdict is attention when any stop
// line exists. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, and never a chat id - the
// distinct-chat count rides the chat-carrying lines' prefixes
// internally and surfaces as a number only. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and intervenes in nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-intervention-scorecard-"));
}

test("intervention scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = interventionScorecardText(dir);
    assert.equal(text, "Owner interventions: clear, 0 interventions, steers 0 (0 messages), stops 0 (mid-turn 0 / running 0 / idle 0, 0 queued dropped), neverminds 0 (dropped 0 / empty 0), folds 0 (0 messages), status checks 0, resends 0, budget continuations 0 (peak tranche 0, 0 calls over 0 rounds), 0 distinct chats, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = interventionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held intervention scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("intervention scorecard: the family folds to counts, chats collapse in the distinct count, and no chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = interventionScorecardText(dir);
    recordActivity(dir, "sam", "message-steer", steerLedgerSummary(1));
    recordActivity(dir, "sam", "message-steer", steerLedgerSummary(3));
    recordActivity(dir, "sam", "message-stop", stopMidTurnLedgerSummary(5));
    recordActivity(dir, "sam", "message-stop", stopChatLedgerSummary("6b222963", true, 0));
    recordActivity(dir, "sam", "message-stop", stopChatLedgerSummary("95ac34b3", false, 2));
    recordActivity(dir, "sam", "message-nevermind", nevermindLedgerSummary("6b222963", true));
    recordActivity(dir, "sam", "message-nevermind", nevermindLedgerSummary("95ac34b3", false));
    recordActivity(dir, "sam", "message-fold", messageFoldLedgerSummary(3, "6b222963"));
    recordActivity(dir, "sam", "message-status", messageStatusLedgerSummary("95ac34b3"));
    recordActivity(dir, "sam", "message-resent", messageResentLedgerSummary("6b222963"));
    recordActivity(dir, "sam", "budget-continued", budgetContinuedSummary(1, Array(39).fill("tool"), 30));
    recordActivity(dir, "sam", "budget-continued", budgetContinuedSummary(2, Array(40).fill("tool"), 31));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = interventionScorecardText(dir);
    assert.equal(text, "Owner interventions: attention, 12 interventions, steers 2 (4 messages), stops 3 (mid-turn 1 / running 1 / idle 1, 2 queued dropped), neverminds 2 (dropped 1 / empty 1), folds 1 (3 messages), status checks 1, resends 1, budget continuations 2 (peak tranche 2, 79 calls over 61 rounds), 2 distinct chats, 12 total");
    assert.equal(text.includes("6b222963"), false, "no chat id surfaces");
    assert.equal(text.includes("95ac34b3"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first intervention changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("intervention scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "message-steer", steerLedgerSummary(1));
    recordActivity(dir, "sam", "message-stop", "Some wholly novel stop shape mentioning sekrit chats");
    const text = interventionScorecardText(dir);
    assert.equal(text, "Owner interventions: attention, 1 interventions, steers 1 (1 messages), stops 0 (mid-turn 0 / running 0 / idle 0, 0 queued dropped), neverminds 0 (dropped 0 / empty 0), folds 0 (0 messages), status checks 0, resends 0, budget continuations 0 (peak tranche 0, 0 calls over 0 rounds), 0 distinct chats, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel stop"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("intervention parse: the seams' own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(steerLedgerSummary(2), "Owner sent 2 message(s) mid-turn; folded into the running turn, the latest governs", "the writer is byte-identical to the shape the loops have always ledgered");
  assert.equal(stopMidTurnLedgerSummary(5), "Owner said stop mid-turn after 5 calls; the turn closes with an accounting");
  assert.equal(stopChatLedgerSummary("6b222963", true, 0), "Owner said stop in chat 6b222963; the running turn was asked to close at its next step");
  assert.equal(stopChatLedgerSummary("6b222963", false, 2), "Owner said stop in chat 6b222963 with no turn running; 2 queued message(s) dropped");
  assert.equal(nevermindLedgerSummary("6b222963", true), "Owner neverminded a queued message in chat 6b222963; the queued message was dropped before doing any work");
  assert.equal(nevermindLedgerSummary("6b222963", false), "Owner sent a nevermind in chat 6b222963 with nothing queued to drop");
  assert.equal(messageFoldLedgerSummary(3, "6b222963"), "3 owner messages folded into one turn in chat 6b222963, in arrival order; the latest governs");
  assert.equal(messageStatusLedgerSummary("6b222963"), "Owner status check in chat 6b222963 answered by the runtime while a turn runs; the turn was not disturbed and the model was not called");
  assert.equal(messageResentLedgerSummary("6b222963"), "Owner resent a failed message in chat 6b222963; the saved message is queued again over its original row - no second copy is saved");
  assert.deepEqual(parseSteerSummary(steerLedgerSummary(2)), { messages: 2 });
  assert.deepEqual(parseStopSummary(stopMidTurnLedgerSummary(5)), { form: "mid-turn", chat: null, calls: 5, dropped: 0 });
  assert.deepEqual(parseStopSummary(stopChatLedgerSummary("95ac34b3", true, 0)), { form: "running", chat: "95ac34b3", calls: null, dropped: 0 });
  assert.deepEqual(parseStopSummary(stopChatLedgerSummary("95ac34b3", false, 2)), { form: "idle", chat: "95ac34b3", calls: null, dropped: 2 });
  assert.deepEqual(parseNevermindSummary(nevermindLedgerSummary("95ac34b3", true)), { chat: "95ac34b3", dropped: true });
  assert.deepEqual(parseNevermindSummary(nevermindLedgerSummary("95ac34b3", false)), { chat: "95ac34b3", dropped: false });
  assert.deepEqual(parseFoldSummary(messageFoldLedgerSummary(3, "95ac34b3")), { chat: "95ac34b3", messages: 3 });
  assert.deepEqual(parseStatusSummary(messageStatusLedgerSummary("95ac34b3")), { chat: "95ac34b3" });
  assert.deepEqual(parseResentSummary(messageResentLedgerSummary("95ac34b3")), { chat: "95ac34b3" });
  assert.deepEqual(parseBudgetContinuedSummary(budgetContinuedSummary(1, Array(39).fill("tool"), 30)), { tranche: 1, calls: 39, rounds: 30 });
  assert.equal(parseSteerSummary(""), null);
  assert.equal(parseStopSummary("Owner said stop in chat 95ac34b3"), null, "a truncated line does not parse");
  assert.equal(parseNevermindSummary("Some wholly novel nevermind shape"), null);
  assert.equal(parseBudgetContinuedSummary("Owner turn continued past its standard budget"), null);
});

test("intervention scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-owner-interventions"), "sam-owner-interventions is allowlisted");
  const argv = scriptArgv("/some/root", "sam-owner-interventions");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "intervention-scorecard"], "the argv rides observe intervention-scorecard");
});

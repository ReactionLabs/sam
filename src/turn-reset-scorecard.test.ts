import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTurnResetSummary, turnResetLedgerSummary, turnResetScorecardText } from "./chat-queue.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-reset daily-measurement wiring (2026-11-19, the
// measured-proof series): owner Reset presses that stop a
// running turn cold have ledgered as "turn-reset" lines since
// the Reset button landed - one line per effective press, in
// the one fixed shape the reset seam writes - but the class
// was never folded, so how often the owner has had to stop a
// turn by hand, how much in-flight work those presses
// aborted, and how many queued follow-ups they cancelled was
// invisible in aggregate. Every reset line is by construction
// an owner intervention, so the verdict is attention when any
// line exists. The scorecard text is a script job's stdout and
// is P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and never a chat id - the
// distinct-chat count rides each line's chat prefix internally
// and surfaces as a number only. The scorecard path is a pure
// read - it creates nothing, spends no model call, and resets
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-reset-scorecard-"));
}

test("turn-reset scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnResetScorecardText(dir);
    assert.equal(text, "Turn resets: clear, 0 resets, 0 in-flight aborted, 0 queued cancelled, 0s total stopped runtime, 0 distinct chats, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnResetScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn-reset scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-reset scorecard: resets fold to counts, chats collapse in the distinct count, and no chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnResetScorecardText(dir);
    recordActivity(dir, "sam", "turn-reset", turnResetLedgerSummary("6b222963", 1000, 1, 1));
    recordActivity(dir, "sam", "turn-reset", turnResetLedgerSummary("95ac34b3", 43000, 1, 0));
    recordActivity(dir, "sam", "turn-reset", turnResetLedgerSummary("6b222963", 125000, 2, 3));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = turnResetScorecardText(dir);
    assert.equal(text, "Turn resets: attention, 3 resets, 4 in-flight aborted, 4 queued cancelled, 169s total stopped runtime, 2 distinct chats, 3 total");
    assert.equal(text.includes("6b222963"), false, "no chat id surfaces");
    assert.equal(text.includes("95ac34b3"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first reset changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-reset scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "turn-reset", turnResetLedgerSummary("6b222963", 1000, 1, 1));
    recordActivity(dir, "sam", "turn-reset", "Some wholly novel reset shape mentioning sekrit chats");
    const text = turnResetScorecardText(dir);
    assert.equal(text, "Turn resets: attention, 1 resets, 1 in-flight aborted, 1 queued cancelled, 1s total stopped runtime, 1 distinct chats, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel reset"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-reset parse: the seam's own writer lines parse, and only the fixed shape parses", () => {
  assert.equal(
    turnResetLedgerSummary("6b222963", 1000, 1, 1),
    "Owner reset chat 6b222963: turn stopped after 1s, claim released on the press, 1 in-flight request(s) aborted, 1 queued message(s) cancelled; nothing was deleted",
    "the writer is byte-identical to the shape the reset seam has always ledgered",
  );
  assert.equal(
    turnResetLedgerSummary("6b222963", null, 0, 2),
    "Owner reset chat 6b222963: turn stopped, claim released on the press, 0 in-flight request(s) aborted, 2 queued message(s) cancelled; nothing was deleted",
    "a press with no claim carries no duration segment",
  );
  assert.deepEqual(parseTurnResetSummary(turnResetLedgerSummary("95ac34b3", 43000, 1, 0)), { chat: "95ac34b3", stoppedSeconds: 43, aborted: 1, cancelled: 0 });
  assert.deepEqual(parseTurnResetSummary(turnResetLedgerSummary("6b222963", 125000, 2, 3)), { chat: "6b222963", stoppedSeconds: 125, aborted: 2, cancelled: 3 }, "minute-form durations parse back to seconds");
  assert.deepEqual(parseTurnResetSummary(turnResetLedgerSummary("6b222963", null, 0, 2)), { chat: "6b222963", stoppedSeconds: null, aborted: 0, cancelled: 2 });
  assert.deepEqual(
    parseTurnResetSummary("Owner reset chat 95ac34b3: turn stopped after 43s, claim released on the press, 1 in-flight request(s) aborted, 0 queued message(s) cancelled; nothing was deleted"),
    { chat: "95ac34b3", stoppedSeconds: 43, aborted: 1, cancelled: 0 },
    "a live-shaped line parses",
  );
  assert.equal(parseTurnResetSummary(""), null);
  assert.equal(parseTurnResetSummary("Owner reset chat 95ac34b3: turn stopped after 43s"), null, "a truncated line does not parse");
  assert.equal(parseTurnResetSummary("Some wholly novel reset shape"), null);
});

test("turn-reset scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-resets"), "sam-turn-resets is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-resets");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "reset-scorecard"], "the argv rides observe reset-scorecard");
});

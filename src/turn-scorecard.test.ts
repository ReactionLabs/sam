import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTurnSummary, relayTurnLedgerSummary, turnLedgerSummary, turnScorecardText } from "./agent-turn.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The completed-turn daily-measurement wiring (2026-11-19,
// the measured-proof series): the success class of the turn
// ledger - "turn" for every completed chat turn - was never
// folded, while its failure sibling (turn-failed) has been
// measured since 2026-11-10, so how many turns SAM
// completed, through which route, how many were resumes
// from a partial, and across how many chats was invisible
// in aggregate. The verdict is attention only on an
// unparseable line, else clear: a completed turn is the
// system working, and a resumed turn is the
// partial-recovery seam working, never a defect. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, and never a chat id or verbatim summary
// - a turn line carries only the chat's 8-char prefix, and
// the fold surfaces even that only as a distinct count. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and runs no turn; every state here
// is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-scorecard-"));
}

test("turn scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnScorecardText(dir);
    assert.equal(text, "Turns: clear, 0 turns (answered 0, relay 0), 0 resumed, 0 distinct chats, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn scorecard: every route folds to counts and no chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnScorecardText(dir);
    recordActivity(dir, "sam", "turn", turnLedgerSummary("16e058ea-1111-2222-3333-444444444444", false));
    recordActivity(dir, "sam", "turn", turnLedgerSummary("16e058ea-1111-2222-3333-444444444444", true));
    recordActivity(dir, "dip", "turn", turnLedgerSummary("a1b2c3d4-5555-6666-7777-888888888888", false));
    recordActivity(dir, "sam", "turn", relayTurnLedgerSummary("a1b2c3d4-5555-6666-7777-888888888888"));
    recordActivity(dir, "sam", "turn-failed", "Model not configured");
    const text = turnScorecardText(dir);
    assert.equal(text, "Turns: clear, 4 turns (answered 3, relay 1), 1 resumed, 2 distinct chats, 4 total");
    assert.equal(text.includes("16e058ea"), false, "no chat prefix surfaces");
    assert.equal(text.includes("a1b2c3d4"), false, "no chat prefix surfaces");
    assert.notEqual(text, clean, "the first completed turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "turn", turnLedgerSummary("16e058ea-1111-2222-3333-444444444444", false));
    recordActivity(dir, "sam", "turn", "Some wholly novel turn shape mentioning sekrit content");
    const text = turnScorecardText(dir);
    assert.equal(text, "Turns: attention, 1 turns (answered 1, relay 0), 0 resumed, 1 distinct chats, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel turn"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn parse: the seams' own writer lines parse, the live shapes parse, and only the fixed shapes parse", () => {
  assert.equal(
    turnLedgerSummary("16e058ea-1111-2222-3333-444444444444", false),
    "Answered in chat 16e058ea",
    "the writer is byte-identical to the shape the main seam has always ledgered",
  );
  assert.equal(
    turnLedgerSummary("16e058ea-1111-2222-3333-444444444444", true),
    "Answered in chat 16e058ea (resumed from partial)",
    "the writer is byte-identical to the resumed shape the main seam has always ledgered",
  );
  assert.equal(
    relayTurnLedgerSummary("16e058ea-1111-2222-3333-444444444444"),
    "Relay answered in chat 16e058ea",
    "the writer is byte-identical to the shape the relay seam has always ledgered",
  );
  assert.deepEqual(parseTurnSummary("Answered in chat 16e058ea"), { route: "answered", chat: "16e058ea", resumed: false });
  assert.deepEqual(parseTurnSummary("Answered in chat 16e058ea (resumed from partial)"), { route: "answered", chat: "16e058ea", resumed: true });
  assert.deepEqual(parseTurnSummary("Relay answered in chat 16e058ea"), { route: "relay", chat: "16e058ea", resumed: false });
  assert.equal(parseTurnSummary(""), null);
  assert.equal(parseTurnSummary("Answered in chat "), null, "a missing chat prefix does not parse");
  assert.equal(parseTurnSummary("Answered in chat 16e058ea (resumed)"), null, "a near-miss tail does not parse");
  assert.equal(parseTurnSummary("Relay answered in chat 16e058ea (resumed from partial)"), null, "the relay shape carries no resumed tail");
  assert.equal(parseTurnSummary("Some wholly novel turn shape"), null);
});

test("turn scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turns"), "sam-turns is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turns");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "turn-scorecard"], "the argv rides observe turn-scorecard");
});

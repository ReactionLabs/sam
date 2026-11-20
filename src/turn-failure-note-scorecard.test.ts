import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTurnFailureNoteSummary, turnFailureNoteScorecardText, turnFailureNoteSummary } from "./agent-turn.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-failure-note daily-measurement wiring (2026-11-20, the
// measured-proof series): the turn failure note seam has ledgered a
// turn-failure-note line through the ONE writer
// (turnFailureNoteSummary in agent-turn.ts) whenever a failed owner
// chat turn leaves its one plain sentence in the chat - but the
// class was never folded, so how often SAM has to tell the owner a
// turn did not finish was invisible in aggregate. The note is the
// failure-visibility fix working as designed, so the verdict is
// attention only when a line is unparseable. The scorecard text is
// a script job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no chat id - the
// summaries carry the chat ids, which the fold consumes into a
// distinct count and never prints, and never a verbatim reason.
// The scorecard path is a pure read - it creates nothing and notes
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-failure-note-scorecard-"));
}

test("turn failure note scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnFailureNoteScorecardText(dir);
    assert.equal(text, "Turn failure notes: clear, 0 notes, 0 distinct chats, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnFailureNoteScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held failure-note scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn failure note scorecard: the class folds to counts, and no chat id or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnFailureNoteScorecardText(dir);
    recordActivity(dir, "sam", "turn-failure-note", turnFailureNoteSummary("48d8efb2aaaaaaaa", new Error("sekrit reason")));
    recordActivity(dir, "dip", "turn-failure-note", turnFailureNoteSummary("48d8efb2bbbbbbbb", new Error("sekrit reason")));
    recordActivity(dir, "sam", "turn-failure-note", turnFailureNoteSummary("12345678cccccccc", new Error("other failure")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = turnFailureNoteScorecardText(dir);
    assert.equal(text, "Turn failure notes: clear, 3 notes, 2 distinct chats, 3 total");
    assert.equal(text.includes("48d8efb2"), false, "no chat id surfaces");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded note changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn failure note scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "turn-failure-note", turnFailureNoteSummary("48d8efb2aaaaaaaa", new Error("boom")));
    recordActivity(dir, "dip", "turn-failure-note", "Some wholly novel note shape naming sekrit_chat");
    const text = turnFailureNoteScorecardText(dir);
    assert.equal(text, "Turn failure notes: attention, 1 notes, 1 distinct chats, 2 total, 1 unparseable");
    assert.equal(text.includes("novel note"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_chat"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn failure note parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(turnFailureNoteSummary("48d8efb2aaaaaaaa", new Error("Unsafe model output")), "Turn failure noted in chat 48d8efb2: the owner reads one plain sentence in the chat (the raw error never reaches the owner); error: Unsafe model output");
  assert.deepEqual(parseTurnFailureNoteSummary(turnFailureNoteSummary("48d8efb2aaaaaaaa", new Error("Unsafe model output"))), { chatId: "48d8efb2" });
  assert.equal(parseTurnFailureNoteSummary(""), null);
  assert.equal(parseTurnFailureNoteSummary("Turn failure noted in chat 48d8efb2: the owner reads one plain sentence in the chat (the raw error never reaches the owner); error: "), null, "an empty reason does not parse");
  assert.equal(parseTurnFailureNoteSummary("Turn failure noted in chat 48d8efb: the owner reads one plain sentence in the chat (the raw error never reaches the owner); error: boom"), null, "a short chat id does not parse");
  assert.equal(parseTurnFailureNoteSummary("Turn failure noted in chat 48d8efb2: error: boom"), null, "a truncated line does not parse");
});

test("turn failure note scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-failure-notes"), "sam-turn-failure-notes is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-failure-notes");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "failure-note-scorecard"], "the argv rides observe failure-note-scorecard");
});

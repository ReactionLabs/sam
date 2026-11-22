import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { malformedCompletionLedgerSummary, parseTurnGuardrailSummary, providerOverloadLedgerSummary, rateLimitLedgerSummary, sessionCapLedgerSummary, turnGuardrailHistoryScorecardText } from "./agent-turn.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn guardrail history daily-measurement wiring
// (2026-11-22, the measured-proof series): a chat turn's
// four protective responses to session and provider
// trouble have ledgered as session-cap,
// malformed-completion, rate-limit, and provider-overload
// lines from four seams in agent-turn - but the family
// was never folded, so how often SAM's turns hit a cap,
// redraw a malformed completion, ride out a rate-limit
// episode, or take the overload note was invisible in
// aggregate. A guardrail trip is the protection working
// as designed, not an alarm, so the verdict is attention
// only when a line is unparseable, else clear. The
// scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no chat id, no
// malformed detail - the summaries carry the chat
// prefixes and the validation detail, which the fold
// consumes and never prints. The scorecard path is a
// pure read - it creates nothing, spends no model call,
// and trips nothing; every state here is built through
// the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-guardrail-history-"));
}

const BARE = "Turn guardrail history: clear, 0 trips, session cap 0 (turns 0 / tokens 0), malformed 0, rate limited 0 (opened 0 / silent 0 / closed 0), provider overload 0, 0 distinct chats, 0 total";
const CHAT_A = "6b222963-1111-2222-3333-444444444444";
const CHAT_B = "abcdef01-5555-6666-7777-888888888888";

test("turn guardrail history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnGuardrailHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnGuardrailHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn guardrail scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn guardrail history scorecard: all four writers fold to counts per guardrail, and no chat id or detail surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnGuardrailHistoryScorecardText(dir);
    recordActivity(dir, "sam", "session-cap", sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns"));
    recordActivity(dir, "sam", "session-cap", sessionCapLedgerSummary(CHAT_B, 4, 90000, "tokens"));
    recordActivity(dir, "sam", "malformed-completion", malformedCompletionLedgerSummary(CHAT_A, "sekrit detail words", 1, 3));
    recordActivity(dir, "sam", "rate-limit", rateLimitLedgerSummary(CHAT_A, "opened"));
    recordActivity(dir, "sam", "rate-limit", rateLimitLedgerSummary(CHAT_B, "already-open"));
    recordActivity(dir, "sam", "rate-limit", rateLimitLedgerSummary(CHAT_A, "closed"));
    recordActivity(dir, "sam", "provider-overload", providerOverloadLedgerSummary(CHAT_B));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = turnGuardrailHistoryScorecardText(dir);
    assert.equal(text, "Turn guardrail history: clear, 7 trips, session cap 2 (turns 1 / tokens 1), malformed 1, rate limited 3 (opened 1 / silent 1 / closed 1), provider overload 1, 2 distinct chats, 7 total");
    assert.equal(text.includes("sekrit"), false, "no malformed detail surfaces");
    assert.equal(text.includes("6b222963"), false, "no chat prefix surfaces");
    assert.equal(text.includes("abcdef01"), false, "no chat prefix surfaces");
    assert.notEqual(text, clean, "the first recorded trip changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn guardrail history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "session-cap", sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns"));
    recordActivity(dir, "sam", "rate-limit", "Some wholly novel rate shape naming sekrit_evidence");
    recordActivity(dir, "sam", "malformed-completion", sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns"));
    const text = turnGuardrailHistoryScorecardText(dir);
    assert.equal(text, "Turn guardrail history: attention, 1 trips, session cap 1 (turns 1 / tokens 0), malformed 0, rate limited 0 (opened 0 / silent 0 / closed 0), provider overload 0, 1 distinct chats, 3 total, 2 unparseable");
    assert.equal(text.includes("novel rate shape"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn guardrail parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns"), "Session cap reached in chat 6b222963: 30 turns, 12000 tokens today (turns cap)");
  assert.equal(sessionCapLedgerSummary(CHAT_B, 4, 90000, "tokens"), "Session cap reached in chat abcdef01: 4 turns, 90000 tokens today (tokens cap)");
  assert.equal(malformedCompletionLedgerSummary(CHAT_A, "tool call failed validation", 2, 3), "Malformed completion in chat 6b222963: tool call failed validation (attempt 2 of 3; nothing executed, the model redraws)");
  assert.equal(rateLimitLedgerSummary(CHAT_A, "opened"), "Rate limited in chat 6b222963: episode opened, grace message sent (the raw provider error never reaches the owner)");
  assert.equal(rateLimitLedgerSummary(CHAT_A, "already-open"), "Rate limited in chat 6b222963: episode already open, staying silent");
  assert.equal(rateLimitLedgerSummary(CHAT_A, "closed"), "Rate-limit episode closed in chat 6b222963: a model call succeeded again");
  assert.equal(providerOverloadLedgerSummary(CHAT_B), "Provider overloaded in chat abcdef01: in-turn retries exhausted, the plain outage note is in the chat and the message stays marked failed, not lost (the raw provider error never reaches the owner)");
  assert.deepEqual(parseTurnGuardrailSummary("session-cap", sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns")), { chatId: "6b222963", bucket: "session-cap-turns" });
  assert.deepEqual(parseTurnGuardrailSummary("malformed-completion", malformedCompletionLedgerSummary(CHAT_A, "bad shape", 1, 3)), { chatId: "6b222963", bucket: "malformed" });
  assert.deepEqual(parseTurnGuardrailSummary("rate-limit", rateLimitLedgerSummary(CHAT_B, "already-open")), { chatId: "abcdef01", bucket: "rate-silent" });
  assert.deepEqual(parseTurnGuardrailSummary("provider-overload", providerOverloadLedgerSummary(CHAT_B)), { chatId: "abcdef01", bucket: "overload" });
  assert.equal(parseTurnGuardrailSummary("session-cap", ""), null);
  assert.equal(parseTurnGuardrailSummary("session-cap", "Session cap reached in chat 6b222963: 30 turns, 12000 tokens today (banana cap)"), null, "a cap outside the fixed vocabulary does not parse");
  assert.equal(parseTurnGuardrailSummary("rate-limit", sessionCapLedgerSummary(CHAT_A, 30, 12000, "turns")), null, "a session-cap line never parses as a rate-limit line");
  assert.equal(parseTurnGuardrailSummary("turn-failed", rateLimitLedgerSummary(CHAT_A, "opened")), null, "an unknown kind never parses");
  assert.equal(parseTurnGuardrailSummary("malformed-completion", "Malformed completion in chat 6b222963:  (attempt 1 of 3; nothing executed, the model redraws)"), null, "a line with an empty detail does not parse");
});

test("turn guardrail history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-guardrail-history"), "sam-turn-guardrail-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-guardrail-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "guardrail-history"], "the argv rides observe guardrail-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { chatCitationLedgerSummary, chatCitationScorecardText, parseChatCitationSummary } from "./agent-turn.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The chat-citation daily-measurement wiring (2026-11-20, the
// measured-proof series): the citation seam has ledgered a
// chat-citation line whenever a reply attaches a citation to a
// past chat - until now as inline concatenation at the seam, with
// no ONE writer and no fold, so how often SAM cites a chat, and
// whether citations point across chats or back at the citing chat
// itself, was invisible in aggregate. An attached citation is the
// citation pass working as designed, so the verdict is attention
// only when a line is unparseable. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no chat id - the
// summaries carry the prefixes, which the fold consumes into
// distinct and self-citation counts and never prints, and never
// a message id. The scorecard path is a pure read - it creates
// nothing and cites nothing; every state here is built through
// the ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chat-citation-scorecard-"));
}

test("chat citation scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = chatCitationScorecardText(dir);
    assert.equal(text, "Chat citations: clear, 0 citations, 0 distinct chats, 0 self-citations, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = chatCitationScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held citation scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation scorecard: the class folds to counts, self-citations are counted, and no id surfaces", () => {
  const dir = scratch();
  try {
    const clean = chatCitationScorecardText(dir);
    recordActivity(dir, "sam", "chat-citation", chatCitationLedgerSummary("2e67eb98aaaaaaaa", "2e67eb98bbbbbbbb", "c3df753bcccccccc"));
    recordActivity(dir, "sam", "chat-citation", chatCitationLedgerSummary("48d8efb2aaaaaaaa", "12345678bbbbbbbb", "0d1bb05cccccccccc".slice(0, 16)));
    recordActivity(dir, "dip", "chat-citation", chatCitationLedgerSummary("48d8efb2dddddddd", "87654321eeeeeeee", "aaaaaaaaffffffff"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = chatCitationScorecardText(dir);
    assert.equal(text, "Chat citations: clear, 3 citations, 2 distinct chats, 1 self-citations, 3 total");
    assert.equal(text.includes("2e67eb98"), false, "no chat id surfaces");
    assert.equal(text.includes("c3df753b"), false, "no message id surfaces");
    assert.notEqual(text, clean, "the first recorded citation changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "chat-citation", chatCitationLedgerSummary("48d8efb2aaaaaaaa", "48d8efb2bbbbbbbb", "0d1bb05cccccccccc".slice(0, 16)));
    recordActivity(dir, "sam", "chat-citation", "Some wholly novel citation shape naming sekrit_chat");
    const text = chatCitationScorecardText(dir);
    assert.equal(text, "Chat citations: attention, 1 citations, 1 distinct chats, 1 self-citations, 2 total, 1 unparseable");
    assert.equal(text.includes("novel citation"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_chat"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(chatCitationLedgerSummary("2e67eb98aaaaaaaa", "48d8efb2bbbbbbbb", "c3df753bcccccccc"), "Citation attached in chat 2e67eb98 pointing at chat 48d8efb2, message c3df753b");
  assert.deepEqual(parseChatCitationSummary(chatCitationLedgerSummary("2e67eb98aaaaaaaa", "48d8efb2bbbbbbbb", "c3df753bcccccccc")), { chatId: "2e67eb98", targetChatId: "48d8efb2", messageId: "c3df753b" });
  assert.equal(parseChatCitationSummary(""), null);
  assert.equal(parseChatCitationSummary("Citation attached in chat 2e67eb9 pointing at chat 48d8efb2, message c3df753b"), null, "a short chat id does not parse");
  assert.equal(parseChatCitationSummary("Citation attached in chat 2e67eb98 pointing at chat 48d8efb2"), null, "a truncated line does not parse");
  assert.equal(parseChatCitationSummary("Citation attached in chat 2e67eb98 pointing at chat 48d8efb2, message c3df753b extra"), null, "trailing text does not parse");
});

test("chat citation scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-chat-citations"), "sam-chat-citations is allowlisted");
  const argv = scriptArgv("/some/root", "sam-chat-citations");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "chat-citation-scorecard"], "the argv rides observe chat-citation-scorecard");
});

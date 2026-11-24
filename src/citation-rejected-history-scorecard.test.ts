import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationRejectedHistoryScorecardText, citationRejectedLedgerSummary, parseCitationRejectedSummary } from "./chat-citations.js";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The citation rejected history daily-measurement wiring
// (2026-11-24, the measured-proof series): the citation pass
// ledgers every fabricated chat citation as a
// "citation-rejected" line through the ONE writer
// (citationRejectedLedgerSummary, fixed shape "Citation
// rejected in chat <8-char prefix>: the reply's marker named
// a source outside this run's chat-search results (<N> hit(s)
// recorded); no citation attached") - and while self-work
// labels single lines, the chat citation scorecard folds only
// the successful attaches, the chat-citation-failed fold
// counts the attach store's failures, and the citation-
// rejection scorecard folds the different
// "source-citation-rejected" kind, so no surface folds this
// kind: a model fabricating chat-history citations shipped
// clean replies with nothing counting the class. Every
// rejection line is by construction a fabricated marker that
// was stripped, so the verdict is attention when any
// rejection was ever recorded or any line is unparseable,
// else clear. The scorecard text is a script job's stdout and
// is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no chat id, no hit count,
// and no verbatim summary. The scorecard path is a pure read
// - it creates nothing, spends no model call, and cites
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-citation-rejected-history-"));
}

const CHAT_A = "abcd1234-5678-4abc-8def-0123456789ab";
const CHAT_B = "1234abcd-5678-4abc-8def-0123456789ab";
const SOURCE_REJECTED_LINE = "Source citation rejected in chat abcd1234: the reply cited 1 source number(s) outside this run's registered sources (4 registered); the invalid citations were stripped and no source was listed for them";

const BARE = "Citation rejected history: clear, 0 rejected, 0 distinct chats, 0 total";

test("citation rejected history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = citationRejectedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = citationRejectedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held citation rejected scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejected history scorecard: the writer's rejections fold to counts with the distinct-chat count, and no chat prefix or hit count surfaces", () => {
  const dir = scratch();
  try {
    const clean = citationRejectedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 3));
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 0));
    recordActivity(dir, "dip", "citation-rejected", citationRejectedLedgerSummary(CHAT_B, 12));
    recordActivity(dir, "sam", "chat-citation", "Chat citation attached in chat abcd1234");
    const text = citationRejectedHistoryScorecardText(dir);
    assert.equal(text, "Citation rejected history: attention, 3 rejected, 2 distinct chats, 3 total");
    assert.equal(text.includes("abcd1234"), false, "no chat prefix surfaces");
    assert.equal(text.includes("12"), false, "no hit count surfaces");
    assert.notEqual(text, clean, "the first recorded rejection changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejected history scorecard: an unmatched shape, the sibling kind's shape, a truncated shape, and a negative-count shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 2));
    recordActivity(dir, "sam", "citation-rejected", "Some wholly novel ledger shape naming sekrit_chat");
    recordActivity(dir, "sam", "citation-rejected", SOURCE_REJECTED_LINE);
    recordActivity(dir, "sam", "citation-rejected", "Citation rejected in chat abcd1234: the reply's marker named a source outside this run's chat-search results (2 hit(s) recorded)");
    recordActivity(dir, "sam", "citation-rejected", "Citation rejected in chat abcd1234: the reply's marker named a source outside this run's chat-search results (-1 hit(s) recorded); no citation attached");
    const text = citationRejectedHistoryScorecardText(dir);
    assert.equal(text, "Citation rejected history: attention, 1 rejected, 1 distinct chats, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejected history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    citationRejectedLedgerSummary(CHAT_A, 3),
    "Citation rejected in chat abcd1234: the reply's marker named a source outside this run's chat-search results (3 hit(s) recorded); no citation attached",
  );
  assert.deepEqual(parseCitationRejectedSummary(citationRejectedLedgerSummary(CHAT_A, 3)), { chat: "abcd1234", hits: 3 });
  assert.deepEqual(parseCitationRejectedSummary(citationRejectedLedgerSummary(CHAT_B, 0)), { chat: "1234abcd", hits: 0 });
  assert.equal(parseCitationRejectedSummary(""), null);
  assert.equal(parseCitationRejectedSummary("Citation rejected in chat abcd1234: the reply's marker named a source outside this run's chat-search results (3 hit(s) recorded)"), null, "a line missing the fixed tail does not parse");
  assert.equal(parseCitationRejectedSummary("Citation rejected in chat ABCD1234: the reply's marker named a source outside this run's chat-search results (3 hit(s) recorded); no citation attached"), null, "an uppercase prefix the writer never writes does not parse");
  assert.equal(parseCitationRejectedSummary("Citation rejected in chat abcd1234: the reply's marker named a source outside this run's chat-search results (-1 hit(s) recorded); no citation attached"), null, "a negative hit count does not parse");
  assert.equal(parseCitationRejectedSummary(SOURCE_REJECTED_LINE), null, "a source-citation-rejected line never parses as a citation-rejected line");
});

test("citation rejected history scorecard: repeat rejections in one chat raise the rejected count only, and a held state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 1));
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 5));
    recordActivity(dir, "sam", "citation-rejected", citationRejectedLedgerSummary(CHAT_A, 2));
    const text = citationRejectedHistoryScorecardText(dir);
    assert.equal(text, "Citation rejected history: attention, 3 rejected, 1 distinct chats, 3 total");
    assert.equal(citationRejectedHistoryScorecardText(dir), text, "a held state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejected history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-citation-rejected-history"), "sam-citation-rejected-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-citation-rejected-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "citation-rejected-history"], "the argv rides observe citation-rejected-history");
});

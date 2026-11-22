import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { autotitleFailedHistoryScorecardText, autotitleFailedSummary, parseAutotitleFailedSummary } from "./chat-title.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The autotitle failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a chat autotitle
// attempt whose completer dies ledgers as an
// autotitle-failed line through the ONE writer
// autotitleFailedSummary, and self-work ranks the class as
// a defect - but the class was never folded, so how often
// the title route has ever died, on how many chats, and
// whether the cause was transport, an unsafe completion,
// an empty completion, or something else was invisible in
// aggregate. Every failure line is by construction a title
// attempt the completer could not finish, so the verdict
// is attention when any failure was ever recorded or any
// line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// chat id, and no verbatim reason - the summaries carry
// chat prefixes and failure reasons, which the fold
// consumes into buckets and a distinct count and never
// prints. The scorecard path is a pure read - it creates
// nothing, spends no model call, and titles nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-autotitle-history-"));
}

const BARE = "Autotitle failed history: clear, 0 failures, transport 0 / unsafe 0 / empty 0 / other 0, 0 distinct chats, 0 total";
const CHAT_A = "6b222963-1111-2222-3333-444444444444";
const CHAT_B = "abcdef01-5555-6666-7777-888888888888";

test("autotitle failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = autotitleFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = autotitleFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held autotitle scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("autotitle failed history scorecard: the writer's failures fold to counts per reason-head bucket, and no chat id or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = autotitleFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "autotitle-failed", autotitleFailedSummary(CHAT_A, new Error("fetch failed: getaddrinfo ENOTFOUND models.invalid")));
    recordActivity(dir, "sam", "autotitle-failed", autotitleFailedSummary(CHAT_A, new Error("Unsafe model output")));
    recordActivity(dir, "dip", "autotitle-failed", autotitleFailedSummary(CHAT_B, new Error("Empty model response")));
    recordActivity(dir, "sam", "autotitle-failed", autotitleFailedSummary(CHAT_B, new Error("Something else entirely sekrit")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = autotitleFailedHistoryScorecardText(dir);
    assert.equal(text, "Autotitle failed history: attention, 4 failures, transport 1 / unsafe 1 / empty 1 / other 1, 2 distinct chats, 4 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("ENOTFOUND"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("6b222963"), false, "no chat prefix surfaces");
    assert.equal(text.includes("abcdef01"), false, "no chat prefix surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("autotitle failed history scorecard: the writer's own 200-char cap still folds from the reason head", () => {
  const dir = scratch();
  try {
    const summary = autotitleFailedSummary(CHAT_A, new Error("fetch failed: " + "x".repeat(300)));
    assert.equal(summary.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "autotitle-failed", summary);
    const parsed = parseAutotitleFailedSummary(summary);
    assert.deepEqual(parsed, { chat: "6b222963", bucket: "transport" });
    const text = autotitleFailedHistoryScorecardText(dir);
    assert.equal(text, "Autotitle failed history: attention, 1 failures, transport 1 / unsafe 0 / empty 0 / other 0, 1 distinct chats, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("autotitle failed history scorecard: an unmatched shape and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "autotitle-failed", autotitleFailedSummary(CHAT_A, new Error("Unsafe model output")));
    recordActivity(dir, "sam", "autotitle-failed", "Some wholly novel autotitle shape naming sekrit_evidence");
    recordActivity(dir, "sam", "autotitle-failed", "Autotitle failed in chat 6b222963:   ");
    const text = autotitleFailedHistoryScorecardText(dir);
    assert.equal(text, "Autotitle failed history: attention, 1 failures, transport 0 / unsafe 1 / empty 0 / other 0, 1 distinct chats, 3 total, 2 unparseable");
    assert.equal(text.includes("novel autotitle"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("autotitle failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    autotitleFailedSummary("12345678-1234-1234-1234-123456789012", new Error("Unsafe model output")),
    "Autotitle failed in chat 12345678: Unsafe model output",
  );
  assert.deepEqual(parseAutotitleFailedSummary(autotitleFailedSummary(CHAT_A, new Error("Unsafe model output"))), { chat: "6b222963", bucket: "unsafe" });
  assert.deepEqual(parseAutotitleFailedSummary(autotitleFailedSummary(CHAT_B, new Error("Empty model response"))), { chat: "abcdef01", bucket: "empty" });
  assert.equal(parseAutotitleFailedSummary(""), null);
  assert.equal(parseAutotitleFailedSummary("Autotitle failed in chat 6b222963:"), null, "a line with no reason does not parse");
  assert.equal(parseAutotitleFailedSummary("Autotitle failed in chat 6b222963: "), null, "a line with a blank reason does not parse");
  assert.equal(parseAutotitleFailedSummary("Turn failed in chat 6b222963: Unsafe model output"), null, "a turn-failed line never parses as an autotitle line");
  assert.equal(parseAutotitleFailedSummary("Owner turn hit the internal budget guardrail (calls): 2/300 calls used (a, b) - closed with a synthesis from gathered material"), null, "a budget-guardrail line never parses as an autotitle line");
});

test("autotitle failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-autotitle-history"), "sam-autotitle-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-autotitle-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "autotitle-history"], "the argv rides observe autotitle-history");
});

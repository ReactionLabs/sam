import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { chatCitationFailedHistoryScorecardText, chatCitationFailureSummary, parseChatCitationFailedSummary } from "./chat-citations.js";
import { sourceCitationFailureSummary } from "./source-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The chat citation failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the citation attach
// path ledgers every failure as a chat-citation-failed line
// through the ONE writer chatCitationFailureSummary, and
// self-work ranks the class as a defect keyed by phase - but
// the class was never folded, so how often a reply's citation
// failed to attach was invisible in aggregate (the existing
// chat-citation scorecard folds only successful attaches).
// Every failure line is by construction a citation attach
// that did not complete, so the verdict is attention when
// any failure was ever recorded or any line is unparseable,
// else clear. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no phase name, and no
// verbatim reason - the summaries carry phases and reasons,
// which the fold consumes and never prints. The scorecard
// path is a pure read - it creates nothing, sends nothing,
// retries nothing, and attaches no citation; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chat-citation-failed-history-"));
}

const BARE = "Chat citation failed history: clear, 0 failed, 0 distinct phases, 0 total";

test("chat citation failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = chatCitationFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = chatCitationFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held chat citation scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation failed history scorecard: the writer's failures fold to counts, and no phase or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = chatCitationFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "chat-citation-failed", chatCitationFailureSummary("attach", new Error("EISDIR: illegal operation on a directory, open sekrit-path")));
    recordActivity(dir, "sam", "chat-citation-failed", chatCitationFailureSummary("attach", new Error("EPERM: operation not permitted")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = chatCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat citation failed history: attention, 2 failed, 1 distinct phases, 2 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason head surfaces");
    assert.equal(text.includes("attach"), false, "no phase name surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation failed history scorecard: the writer's own reason cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = chatCitationFailureSummary("attach", new Error("x".repeat(500)));
    assert.equal(capped, "Chat citation attach failed: " + "x".repeat(160), "the writer caps its reason at 160");
    recordActivity(dir, "sam", "chat-citation-failed", capped);
    assert.deepEqual(parseChatCitationFailedSummary(capped), { phase: "attach" });
    const text = chatCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat citation failed history: attention, 1 failed, 1 distinct phases, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation failed history scorecard: an unmatched shape, a sibling kind's shape, an unknown phase, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "chat-citation-failed", chatCitationFailureSummary("attach", new Error("EPERM: operation not permitted")));
    recordActivity(dir, "sam", "chat-citation-failed", "Some wholly novel citation shape naming sekrit_source");
    recordActivity(dir, "sam", "chat-citation-failed", sourceCitationFailureSummary("attach", new Error("boom sekrit")));
    recordActivity(dir, "sam", "chat-citation-failed", "Chat citation read failed: boom sekrit");
    recordActivity(dir, "sam", "chat-citation-failed", "Chat citation attach failed:   ");
    const text = chatCitationFailedHistoryScorecardText(dir);
    assert.equal(text, "Chat citation failed history: attention, 1 failed, 1 distinct phases, 5 total, 4 unparseable");
    assert.equal(text.includes("novel citation"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("read"), false, "an unknown phase is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat citation failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    chatCitationFailureSummary("attach", new Error("EPERM: operation not permitted")),
    "Chat citation attach failed: EPERM: operation not permitted",
  );
  assert.deepEqual(parseChatCitationFailedSummary(chatCitationFailureSummary("attach", new Error("boom"))), { phase: "attach" });
  assert.equal(parseChatCitationFailedSummary(""), null);
  assert.equal(parseChatCitationFailedSummary("Chat citation attach failed:"), null, "a line with no reason does not parse");
  assert.equal(parseChatCitationFailedSummary("Chat citation attach failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseChatCitationFailedSummary("Chat citation read failed: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseChatCitationFailedSummary(sourceCitationFailureSummary("attach", new Error("boom"))), null, "a source-citation-failed line never parses as a chat-citation-failed line");
  assert.deepEqual(parseChatCitationFailedSummary("Chat citation attach failed: boom: with colon"), { phase: "attach" }, "a reason carrying a colon still parses from the fixed head");
});

test("chat citation failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-chat-citation-failed-history"), "sam-chat-citation-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-chat-citation-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "chat-citation-failed-history"], "the argv rides observe chat-citation-failed-history");
});

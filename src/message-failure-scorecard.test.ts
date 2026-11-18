import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { messageFailureBucket, messageFailureMessages, messageFailureReason, messageFailureScorecardText, messageFailedSummary } from "./chat-queue.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The message-failure daily-measurement wiring (2026-11-18,
// the measured-proof series): the chat queue ledgers every
// queued turn that dies, and since 2026-11-16 the line
// carries its reason - but no daily surface ever counted
// the class, so a queue failing regularly was invisible
// until the owner hit a failed bubble. The scorecard text
// is a script job's stdout and is P3-diffed on its facts,
// so it carries counts only: no stamp, no chat id, no
// actor, no verbatim reason - reasons fold into the fixed
// turn-failure buckets and an unmatched or legacy
// (pre-cause-fix, reasonless) line is "other", never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, retries nothing, and
// resends nothing; every state here is built through the
// ledger's own public door (recordActivity) with the
// queue seam's own summary writer (messageFailedSummary),
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-message-failure-scorecard-"));
}

test("message failure scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = messageFailureScorecardText(dir);
    assert.match(text, /^Queued message failures: clear$/m);
    assert.match(text, /^Failed queued turns: 0$/m);
    assert.match(text, /^Failed messages: 0$/m);
    assert.match(text, /^By reason: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = messageFailureScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held message-failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message failure scorecard: failed queued turns flip the verdict, fold messages and buckets, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = messageFailureScorecardText(dir);
    recordActivity(dir, "sam", "message-failed", messageFailedSummary("sekritchat-1234", 2, new Error("Unsafe model output")));
    recordActivity(dir, "sam", "message-failed", messageFailedSummary("sekritchat-1234", 1, new Error("Model not configured")));
    recordActivity(dir, "sam", "message-failed", messageFailedSummary("sekritchat-1234", 3, new Error("Connector request failed (HTTP 529)")));
    recordActivity(dir, "sam", "message-failed", "A queued turn in chat sekritch failed; its 1 message(s) are marked failed in the queue, not lost");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = messageFailureScorecardText(dir);
    assert.match(text, /^Queued message failures: attention$/m);
    assert.match(text, /^Failed queued turns: 4$/m);
    assert.match(text, /^Failed messages: 7$/m);
    assert.match(text, /^By reason: not-configured 1, other 1, provider-error 1, unsafe-output 1$/m);
    assert.equal(text.includes("sekrit"), false, "no chat id surfaces");
    assert.equal(text.includes("Unsafe model output"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first failed queued turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("message failure parsing: the reason rides between the fixed halves, the legacy shape has none, and only the fixed enum classifies", () => {
  assert.equal(messageFailureReason(messageFailedSummary("12345678-abcd", 1, new Error("Model not configured"))), "Model not configured");
  assert.equal(messageFailureReason("A queued turn in chat 12345678 failed; its 1 message(s) are marked failed in the queue, not lost"), "");
  assert.equal(messageFailureMessages(messageFailedSummary("12345678-abcd", 3, new Error("x"))), 3);
  assert.equal(messageFailureMessages("some other line"), 0);
  assert.equal(messageFailureBucket("Unsafe model output"), "unsafe-output");
  assert.equal(messageFailureBucket("Empty model response"), "empty-response");
  assert.equal(messageFailureBucket("Too many tool calls in one completion"), "too-many-tool-calls");
  assert.equal(messageFailureBucket("The request timed out"), "timeout");
  assert.equal(messageFailureBucket("Model not configured"), "not-configured");
  assert.equal(messageFailureBucket("Connector request failed (HTTP 502)"), "provider-error");
  assert.equal(messageFailureBucket("Invalid profile name"), "invalid-request");
  assert.equal(messageFailureBucket(""), "other");
  assert.equal(messageFailureBucket("Some wholly novel failure"), "other");
});

test("message failure scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-message-failures"), "sam-message-failures is allowlisted");
  const argv = scriptArgv("/some/root", "sam-message-failures");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "message-scorecard"], "the argv rides observe message-scorecard");
});

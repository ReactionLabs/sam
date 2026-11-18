import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { turnFailureBucket, turnFailureScorecardText } from "./observability.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-failure daily-measurement wiring (2026-11-18,
// the measured-proof series): the 2026-11-10 turn-failed
// seam made dead turns countable, and observability folds
// the last 200 into the status JSON with stamps, actors,
// and verbatim reasons - but no daily surface ever counted
// the class, so a new dead turn was invisible until a chat
// died in front of the owner. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// carries counts only: no stamp, no chat id, no actor, no
// verbatim reason - reasons fold into fixed in-code
// buckets and an unmatched reason is "other", never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, and retries nothing;
// every state here is built through the ledger's own
// public door (recordActivity), never around it.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-failure-scorecard-"));
}

function fail(root: string, actor: string, chatId: string, error: string): void {
  recordActivity(root, actor, "turn-failed", "Turn failed in chat " + chatId + " (chat): " + error);
}

test("turn failure scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnFailureScorecardText(dir);
    assert.match(text, /^Turn failures: clear$/m);
    assert.match(text, /^Failed turns: 0$/m);
    assert.match(text, /^By reason: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnFailureScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn-failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn failure scorecard: dead turns flip the verdict, fold to fixed buckets, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = turnFailureScorecardText(dir);
    fail(dir, "sam", "sekrit-chat-id", "Model connector request failed (HTTP 529)");
    fail(dir, "dip", "sekrit-chat-id", "Model connector request failed (HTTP 429)");
    fail(dir, "sam", "other-chat", "Invalid tool call");
    fail(dir, "sam", "other-chat", "Unsafe model output");
    fail(dir, "sam", "other-chat", "Some wholly novel failure shape");
    recordActivity(dir, "sam", "turn", "Turn completed in chat other-chat (chat): all good");
    const text = turnFailureScorecardText(dir);
    assert.match(text, /^Turn failures: attention$/m);
    assert.match(text, /^Failed turns: 5$/m);
    assert.match(text, /^By reason: invalid-request 1, other 1, provider-error 2, unsafe-output 1$/m);
    assert.equal(text.includes("sekrit"), false, "no chat id surfaces");
    assert.equal(text.includes("529"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("novel failure"), false, "an unmatched reason is never printed");
    assert.notEqual(text, clean, "the first dead turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn failure bucket: every fixed shape classifies, and only into the fixed enum", () => {
  assert.equal(turnFailureBucket("Unsafe model output"), "unsafe-output");
  assert.equal(turnFailureBucket("Empty model response"), "empty-response");
  assert.equal(turnFailureBucket("Too many tool calls"), "too-many-tool-calls");
  assert.equal(turnFailureBucket("Model connector request timed out"), "timeout");
  assert.equal(turnFailureBucket("Model not configured"), "not-configured");
  assert.equal(turnFailureBucket("Model connector request failed (HTTP 429)"), "provider-error");
  assert.equal(turnFailureBucket("Invalid connector model request"), "invalid-request");
  assert.equal(turnFailureBucket("Invalid tool call"), "invalid-request");
  assert.equal(turnFailureBucket("Chat not found"), "other");
});

test("turn failure scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-failures"), "sam-turn-failures is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-failures");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "scorecard"], "the argv rides observe scorecard");
});

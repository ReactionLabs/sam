import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTurnRetrySummary, turnRetryLedgerSummary, turnRetryScorecardText, turnRetrySummary } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-retry daily-measurement wiring (2026-11-19, the
// measured-proof series): turns whose first completion failed
// before any tool ran and retried on a trimmed context have
// ledgered as "turn-retry" lines since the context-reset fix
// landed - one line per reset, in the one fixed shape the
// retry seams write - but the class was never folded, so how
// often a turn's history had to be reset to survive, and
// whether the trigger was unsafe or empty model output, was
// invisible in aggregate while every sibling turn class was
// measured. Every retry line is by construction a first
// completion that failed, so the verdict is attention when
// any line exists. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, and never a
// verbatim reason - the reason surfaces only as one of three
// fixed buckets read from its head. The scorecard path is a
// pure read - it creates nothing, spends no model call, and
// retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-retry-scorecard-"));
}

test("turn-retry scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnRetryScorecardText(dir);
    assert.equal(text, "Turn retries: clear, 0 retries, unsafe 0, empty 0, other 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnRetryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn-retry scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-retry scorecard: retries fold to fixed reason buckets and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnRetryScorecardText(dir);
    recordActivity(dir, "sam", "turn-retry", turnRetryLedgerSummary(new Error("Unsafe model output")));
    recordActivity(dir, "sam", "turn-retry", turnRetryLedgerSummary(new Error("Empty model response")));
    recordActivity(dir, "dip", "turn-retry", turnRetryLedgerSummary(new Error("Unsafe model output: sekrit transport detail")));
    recordActivity(dir, "sam", "turn-retry", turnRetryLedgerSummary(new Error("Model not configured")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = turnRetryScorecardText(dir);
    assert.equal(text, "Turn retries: attention, 4 retries, unsafe 2, empty 1, other 1, 4 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("Model not configured"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first retry changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-retry scorecard: a capped stored line still buckets from its reason head and is marked incomplete in the parse", () => {
  const dir = scratch();
  try {
    const long = new Error("Unsafe model output: " + "x".repeat(400));
    recordActivity(dir, "sam", "turn-retry", turnRetryLedgerSummary(long));
    const stored = readFileSync(join(dir, ".sam", "activity.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(stored[0].summary.length, 300, "the ledger capped the long line, the live shape");
    assert.equal(stored[0].summary.endsWith("messages"), false, "a capped line has no suffix");
    const parsed = parseTurnRetrySummary(stored[0].summary);
    assert.ok(parsed, "the capped shape parses");
    assert.equal(parsed.bucket, "unsafe");
    assert.equal(parsed.complete, false, "a capped line is marked incomplete");
    const text = turnRetryScorecardText(dir);
    assert.equal(text, "Turn retries: attention, 1 retries, unsafe 1, empty 0, other 0, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-retry scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "turn-retry", turnRetryLedgerSummary(new Error("Empty model response")));
    recordActivity(dir, "sam", "turn-retry", "Some wholly novel retry shape mentioning sekrit reasons");
    recordActivity(dir, "sam", "turn-retry", "Context reset after 'Unsafe model output' before any tool ran");
    const text = turnRetryScorecardText(dir);
    assert.equal(text, "Turn retries: attention, 1 retries, unsafe 0, empty 1, other 0, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel retry"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-retry parse: the seam's own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(
    turnRetrySummary(new Error("Unsafe model output")),
    "Context reset after 'Unsafe model output' before any tool ran; history trimmed to the last 6 messages",
    "the legacy writer name is byte-identical to the shape the retry seams have always ledgered",
  );
  assert.equal(
    turnRetryLedgerSummary(new Error("Empty model response")),
    "Context reset after 'Empty model response' before any tool ran; history trimmed to the last 6 messages",
  );
  assert.deepEqual(parseTurnRetrySummary(turnRetryLedgerSummary(new Error("Unsafe model output"))), { bucket: "unsafe", complete: true });
  assert.deepEqual(parseTurnRetrySummary(turnRetryLedgerSummary(new Error("Empty model response"))), { bucket: "empty", complete: true });
  assert.deepEqual(parseTurnRetrySummary(turnRetryLedgerSummary(new Error("Something else entirely"))), { bucket: "other", complete: true });
  assert.equal(parseTurnRetrySummary(""), null);
  assert.equal(parseTurnRetrySummary("Context reset after 'Unsafe model output' before any tool ran"), null, "a short line missing its suffix does not parse");
  assert.equal(parseTurnRetrySummary("Some wholly novel retry shape"), null);
});

test("turn-retry scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-retries"), "sam-turn-retries is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-retries");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "retry-scorecard"], "the argv rides observe retry-scorecard");
});

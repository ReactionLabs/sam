import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { historyTrimLedgerSummary, historyTrimScorecardText, parseHistoryTrimSummary } from "./tool-tiers.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The history-trim daily-measurement wiring (2026-11-19, the
// measured-proof series): turns whose request history crosses
// the message cap fold their oldest completed rounds out of
// the model's working window and have ledgered as
// "turn-history-trimmed" lines since the trim landed - one
// line per trimmed turn, in the one fixed shape the loops
// write - but the class was never folded, so how often turns
// outgrow the request window, and how many rounds they shed,
// was invisible in aggregate. The trim is the mechanism
// working as designed (the work stays in the transcript), so
// the verdict is attention only on an unparseable line. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no verbatim summary - trims fold into the
// fixed shape the loops write (through its ONE writer) and an
// unmatched shape counts toward the total and the unparseable
// count, never printed. The scorecard path is a pure read -
// it creates nothing, spends no model call, and trims no
// turn; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-history-trim-scorecard-"));
}

test("history-trim scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = historyTrimScorecardText(dir);
    assert.equal(text, "History trims: clear, 0 trimmed turns, 0 rounds folded, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = historyTrimScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held history-trim scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history-trim scorecard: trims fold to counts and stay clear, the mechanism working", () => {
  const dir = scratch();
  try {
    const clean = historyTrimScorecardText(dir);
    recordActivity(dir, "sam", "turn-history-trimmed", historyTrimLedgerSummary(1));
    recordActivity(dir, "sam", "turn-history-trimmed", historyTrimLedgerSummary(2));
    recordActivity(dir, "sam", "turn-history-trimmed", historyTrimLedgerSummary(2));
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = historyTrimScorecardText(dir);
    assert.equal(text, "History trims: clear, 3 trimmed turns, 5 rounds folded, 3 total");
    assert.notEqual(text, clean, "the first trim changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history-trim scorecard: an unmatched shape flips the verdict to attention and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "turn-history-trimmed", historyTrimLedgerSummary(2));
    recordActivity(dir, "sam", "turn-history-trimmed", "Some wholly novel history-trim shape mentioning sekrit rounds");
    const text = historyTrimScorecardText(dir);
    assert.equal(text, "History trims: attention, 1 trimmed turns, 2 rounds folded, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel history-trim"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history-trim parse: the seam's own writer lines parse, and only the fixed shape parses", () => {
  assert.equal(
    historyTrimLedgerSummary(1),
    "Folded 1 older completed round(s) out of this turn's request history to stay inside the model request limit; the work itself stays in the transcript and the ledger",
    "the writer is byte-identical to the shape the loops have always ledgered",
  );
  assert.equal(
    historyTrimLedgerSummary(12),
    "Folded 12 older completed round(s) out of this turn's request history to stay inside the model request limit; the work itself stays in the transcript and the ledger",
    "the writer is byte-identical to the shape the loops have always ledgered",
  );
  assert.deepEqual(parseHistoryTrimSummary(historyTrimLedgerSummary(1)), { rounds: 1 });
  assert.deepEqual(parseHistoryTrimSummary(historyTrimLedgerSummary(2)), { rounds: 2 });
  assert.deepEqual(
    parseHistoryTrimSummary("Folded 2 older completed round(s) out of this turn's request history to stay inside the model request limit; the work itself stays in the transcript and the ledger"),
    { rounds: 2 },
    "a live-shaped line parses",
  );
  assert.equal(parseHistoryTrimSummary(""), null);
  assert.equal(parseHistoryTrimSummary("Folded 2 older completed round(s) out of this turn's request history"), null, "a truncated shape does not parse");
  assert.equal(parseHistoryTrimSummary("Some wholly novel history-trim shape"), null);
});

test("history-trim scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-history-trims"), "sam-history-trims is allowlisted");
  const argv = scriptArgv("/some/root", "sam-history-trims");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "history-scorecard"], "the argv rides observe history-scorecard");
});

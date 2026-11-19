import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { correctionLedgerSummary, correctionScorecardText, parseCorrectionSummary } from "./corrections.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The correction daily-measurement wiring (2026-11-19, the
// measured-proof series): owner corrections that the P6
// detector catches are proposed as standing law through the
// P1 gate and have ledgered as "correction" lines since the
// gate landed - one line per proposed correction, in the one
// fixed shape proposeCorrection writes - but the class was
// never folded, so how often the owner has had to correct
// SAM, and whether the same rule needed proposing twice, was
// invisible in aggregate. Every correction line is by
// construction a behaviour the owner had to correct, so the
// verdict is attention when any line exists. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, and never the rule statement itself - the
// statement is the owner's own words as law-to-be, and the
// distinct-rule count rides it internally (normalized
// exactly as the gate dedupes) and surfaces as a number
// only. The scorecard path is a pure read - it creates
// nothing, spends no model call, and proposes nothing;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-correction-scorecard-"));
}

test("correction scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = correctionScorecardText(dir);
    assert.equal(text, "Corrections: clear, 0 proposed, 0 distinct rules, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = correctionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held correction scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction scorecard: corrections fold to counts, a repeat rule collapses in the distinct count, and no statement surfaces", () => {
  const dir = scratch();
  try {
    const clean = correctionScorecardText(dir);
    recordActivity(dir, "sam", "correction", correctionLedgerSummary("Never create another duplicate"));
    recordActivity(dir, "sam", "correction", correctionLedgerSummary("Never create another duplicate."));
    recordActivity(dir, "sam", "correction", correctionLedgerSummary("Never edit the approval gate"));
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = correctionScorecardText(dir);
    assert.equal(text, "Corrections: attention, 3 proposed, 2 distinct rules, 3 total");
    assert.equal(text.includes("duplicate"), false, "no rule statement surfaces");
    assert.equal(text.includes("approval gate"), false, "no rule statement surfaces");
    assert.notEqual(text, clean, "the first correction changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "correction", correctionLedgerSummary("Never save him"));
    recordActivity(dir, "sam", "correction", "Some wholly novel correction shape mentioning sekrit rules");
    const text = correctionScorecardText(dir);
    assert.equal(text, "Corrections: attention, 1 proposed, 1 distinct rules, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel correction"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("save him"), false, "no rule statement surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("correction parse: the seam's own writer lines parse, and only the fixed shape parses", () => {
  assert.equal(
    correctionLedgerSummary("Never create another duplicate"),
    "Correction proposed as law: Never create another duplicate",
    "the writer is byte-identical to the shape the gate has always ledgered",
  );
  assert.deepEqual(parseCorrectionSummary(correctionLedgerSummary("Never edit the approval gate")), { statement: "Never edit the approval gate" });
  assert.deepEqual(
    parseCorrectionSummary("Correction proposed as law: Stop rerunning the chat test and trace the worker budget in the harness"),
    { statement: "Stop rerunning the chat test and trace the worker budget in the harness" },
    "a live-shaped line parses",
  );
  assert.equal(parseCorrectionSummary(""), null);
  assert.equal(parseCorrectionSummary("Correction proposed as law:"), null, "a prefix with no statement does not parse");
  assert.equal(parseCorrectionSummary("Correction proposed as law: "), null, "a prefix with a blank statement does not parse");
  assert.equal(parseCorrectionSummary("Some wholly novel correction shape"), null);
});

test("correction scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-corrections"), "sam-corrections is allowlisted");
  const argv = scriptArgv("/some/root", "sam-corrections");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "correction-scorecard"], "the argv rides observe correction-scorecard");
});

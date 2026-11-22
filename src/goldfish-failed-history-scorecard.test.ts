import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { goldfishFailedHistoryScorecardText, parseGoldfishFailedSummary, goldfishFailureSummary } from "./goldfish.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The goldfish failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a goldfish
// records read or append that throws ledgers as a
// goldfish-failed line through the ONE writer
// goldfishFailureSummary, and self-work ranks the class as
// a defect keyed by phase - but the class was never folded,
// so how often the reviewer's own ledger died was invisible
// in aggregate. Every failure line is by construction a
// records operation that did not complete, so the verdict
// is attention when any failure was ever recorded or any
// line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// phase name, no verdict, and no verbatim reason - the
// summaries carry phases, labels, and reasons, which the
// fold consumes and never prints; the review label's change
// count is a number in the shape, summed as reviewed
// changes. The scorecard path is a pure read - it creates
// nothing, sends nothing, retries nothing, and runs no
// review; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-goldfish-failed-history-"));
}

const BARE = "Goldfish failed history: clear, 0 failed, 0 distinct phases, 0 reviewed changes, 0 total";

test("goldfish failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = goldfishFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = goldfishFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held goldfish scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goldfish failed history scorecard: the writer's failures fold to counts, and no phase, verdict, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = goldfishFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "goldfish-failed", goldfishFailureSummary("append", "review PASS over 3 change(s)", "EACCES: permission denied, sekrit path"));
    recordActivity(dir, "sam", "goldfish-failed", goldfishFailureSummary("append", "review BLOCK over 2 change(s)", "ENOSPC: no space left on device"));
    recordActivity(dir, "sam", "goldfish-failed", goldfishFailureSummary("read", "ledger", "file is not valid JSON"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = goldfishFailedHistoryScorecardText(dir);
    assert.equal(text, "Goldfish failed history: attention, 3 failed, 2 distinct phases, 5 reviewed changes, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("append"), false, "no phase name surfaces");
    assert.equal(text.includes("PASS"), false, "no verdict surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goldfish failed history scorecard: the writer's own 200-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = goldfishFailureSummary("read", "ledger", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "goldfish-failed", capped);
    assert.deepEqual(parseGoldfishFailedSummary(capped), { phase: "read", changes: 0 });
    const text = goldfishFailedHistoryScorecardText(dir);
    assert.equal(text, "Goldfish failed history: attention, 1 failed, 1 distinct phases, 0 reviewed changes, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goldfish failed history scorecard: an unmatched shape, an unknown phase, an unknown label, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "goldfish-failed", goldfishFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "goldfish-failed", "Some wholly novel goldfish shape naming sekrit_evidence");
    recordActivity(dir, "sam", "goldfish-failed", "Goldfish write failed for ledger: boom sekrit");
    recordActivity(dir, "sam", "goldfish-failed", "Goldfish read failed for sekrit-label: boom");
    recordActivity(dir, "sam", "goldfish-failed", "Goldfish read failed for ledger:   ");
    const text = goldfishFailedHistoryScorecardText(dir);
    assert.equal(text, "Goldfish failed history: attention, 1 failed, 1 distinct phases, 0 reviewed changes, 5 total, 4 unparseable");
    assert.equal(text.includes("novel goldfish"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("write"), false, "an unknown phase is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goldfish failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    goldfishFailureSummary("read", "ledger", "file is not a database"),
    "Goldfish read failed for ledger: file is not a database",
  );
  assert.deepEqual(parseGoldfishFailedSummary(goldfishFailureSummary("read", "ledger", "boom")), { phase: "read", changes: 0 });
  assert.deepEqual(parseGoldfishFailedSummary(goldfishFailureSummary("append", "review PASS over 4 change(s)", "boom")), { phase: "append", changes: 4 });
  assert.deepEqual(parseGoldfishFailedSummary(goldfishFailureSummary("append", "review BLOCK over 0 change(s)", "boom")), { phase: "append", changes: 0 });
  assert.equal(parseGoldfishFailedSummary(""), null);
  assert.equal(parseGoldfishFailedSummary("Goldfish read failed for ledger:"), null, "a line with no reason does not parse");
  assert.equal(parseGoldfishFailedSummary("Goldfish read failed for ledger: "), null, "a line with a blank reason does not parse");
  assert.equal(parseGoldfishFailedSummary("Goldfish write failed for ledger: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseGoldfishFailedSummary("Goldfish read failed for review MAYBE over 2 change(s): boom"), null, "a verdict the label never carries does not parse");
  assert.equal(parseGoldfishFailedSummary("Verification read failed for ledger: boom"), null, "a verification-failed line never parses as a goldfish line");
  assert.deepEqual(parseGoldfishFailedSummary("Goldfish read failed for ledger: boom: with colon"), { phase: "read", changes: 0 }, "a reason carrying a colon still parses from the fixed head");
});

test("goldfish failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-goldfish-failed-history"), "sam-goldfish-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-goldfish-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["goldfish", "failed-history"], "the argv rides goldfish failed-history");
});

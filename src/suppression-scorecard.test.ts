import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSuppressionBlockedSummary, parseSuppressionRecordedSummary, suppressionBlockedLedgerSummary, suppressionRecordedLedgerSummary, suppressionScorecardText } from "./capture-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The suppression daily-measurement wiring (2026-11-19, the
// measured-proof series): the capture guard's two ledger
// classes - "memory-suppression" for a newly recorded
// do-not-store instruction and "memory-suppressed" for every
// automatic write the guard blocks - were never folded, so
// how many suppressions the owner has standing, how much
// already-stored memory awaited a purge decision when each
// was recorded, and how often the guard has actually held a
// write back (and through which seam) was invisible in
// aggregate. The verdict is attention ONLY on an unparseable
// line, else clear: a recorded suppression is the owner's own
// governance act and a blocked write is the guard holding,
// the system working, never a defect. The scorecard text is
// a script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, and
// never a profile name, needle, fingerprint, or suppression
// id - the distinct-profile count rides each recorded line's
// profile internally and surfaces as a number only. The
// scorecard path is a pure read - it creates nothing, spends
// no model call, and suppresses nothing; every state here is
// built through the ledger's own public door (recordActivity)
// with the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-suppression-scorecard-"));
}

test("suppression scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = suppressionScorecardText(dir);
    assert.equal(text, "Suppressions: clear, 0 recorded, 0 already-matching records awaiting purge, 0 writes blocked (episodes 0, compaction 0, other 0), 0 distinct profiles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = suppressionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held suppression scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suppression scorecard: both classes fold to counts, profiles collapse in the distinct count, and no identifier surfaces", () => {
  const dir = scratch();
  try {
    const clean = suppressionScorecardText(dir);
    recordActivity(dir, "dip", "memory-suppression", suppressionRecordedLedgerSummary("dip", "5f6cfe08258f", "c80ecbd2", "cli", 1));
    recordActivity(dir, "sam", "memory-suppression", suppressionRecordedLedgerSummary("sam", "5f6cfe08258f", "1991c7af", "cli", 3));
    recordActivity(dir, "dip", "memory-suppressed", suppressionBlockedLedgerSummary("episodes", "dip", "c80ecbd2", "5f6cfe08258f"));
    recordActivity(dir, "sam", "memory-suppressed", suppressionBlockedLedgerSummary("compaction", "sam", "1991c7af", "5f6cfe08258f"));
    recordActivity(dir, "sam", "memory-suppressed", suppressionBlockedLedgerSummary("episodes", "sam", "1991c7af", "5f6cfe08258f"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = suppressionScorecardText(dir);
    assert.equal(text, "Suppressions: clear, 2 recorded, 4 already-matching records awaiting purge, 3 writes blocked (episodes 2, compaction 1, other 0), 2 distinct profiles, 5 total");
    assert.equal(text.includes("5f6cfe08258f"), false, "no needle fingerprint surfaces");
    assert.equal(text.includes("c80ecbd2"), false, "no suppression id surfaces");
    assert.equal(text.includes("dip"), false, "no profile name surfaces");
    assert.notEqual(text, clean, "the first suppression changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suppression scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "memory-suppression", suppressionRecordedLedgerSummary("dip", "5f6cfe08258f", "c80ecbd2", "cli", 1));
    recordActivity(dir, "dip", "memory-suppressed", "Some wholly novel guard shape mentioning sekrit needles");
    const text = suppressionScorecardText(dir);
    assert.equal(text, "Suppressions: attention, 1 recorded, 1 already-matching records awaiting purge, 0 writes blocked (episodes 0, compaction 0, other 0), 1 distinct profiles, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel guard"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suppression parse: the seams' own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(
    suppressionRecordedLedgerSummary("dip", "5f6cfe08258f", "c80ecbd2", "cli", 1),
    "Capture suppression recorded for profile dip: needle sha256 5f6cfe08258f (suppression c80ecbd2, from cli); 1 live memory record(s) already match and await the owner's purge decision",
    "the writer is byte-identical to the shape addSuppression has always ledgered",
  );
  assert.equal(
    suppressionBlockedLedgerSummary("episodes", "dip", "c80ecbd2", "5f6cfe08258f"),
    "Memory write suppressed via episodes for dip: matched capture suppression c80ecbd2 (needle sha256 5f6cfe08258f); nothing was stored",
    "the writer is byte-identical to the shape recordSuppressionBlock has always ledgered",
  );
  assert.deepEqual(parseSuppressionRecordedSummary(suppressionRecordedLedgerSummary("sam", "5f6cfe08258f", "1991c7af", "cli", 0)), { profile: "sam", backlog: 0 });
  assert.deepEqual(
    parseSuppressionRecordedSummary("Capture suppression recorded for profile dip: needle sha256 5f6cfe08258f (suppression c80ecbd2, from cli); 1 live memory record(s) already match and await the owner's purge decision"),
    { profile: "dip", backlog: 1 },
    "a live-shaped line parses",
  );
  assert.deepEqual(parseSuppressionBlockedSummary(suppressionBlockedLedgerSummary("compaction", "sam", "1991c7af", "5f6cfe08258f")), { via: "compaction" });
  assert.deepEqual(
    parseSuppressionBlockedSummary("Memory write suppressed via episodes for sam: matched capture suppression 1991c7af (needle sha256 5f6cfe08258f); nothing was stored"),
    { via: "episodes" },
    "a live-shaped line parses",
  );
  assert.equal(parseSuppressionRecordedSummary(""), null);
  assert.equal(parseSuppressionRecordedSummary("Capture suppression recorded for profile dip"), null, "a truncated line does not parse");
  assert.equal(parseSuppressionBlockedSummary("Memory write suppressed via episodes for dip"), null, "a truncated line does not parse");
  assert.equal(parseSuppressionBlockedSummary("Some wholly novel guard shape"), null);
});

test("suppression scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-suppressions"), "sam-suppressions is allowlisted");
  const argv = scriptArgv("/some/root", "sam-suppressions");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "suppression-scorecard"], "the argv rides observe suppression-scorecard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerificationFailedSummary, verificationFailedHistoryScorecardText, verificationFailureSummary } from "./verification.js";
import { recordActivity } from "./activity.js";
import { skillUseFailureSummary } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The verification failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the verify-on-stop
// ledger ledgers every failed touch of itself as a
// verification-failed line through the ONE writer
// verificationFailureSummary (naming the phase and the event
// label), ridden by recordVerificationFailure from both seams
// (the append catch, which never throws, and the read catch,
// which ledgers and rethrows fail-closed) - but the class was
// never folded, so how often the ledger that decides "done"
// itself died was invisible in aggregate. Every failure line
// is by construction a verification touch that did not
// complete, so the verdict is attention when any failure was
// ever recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no stamp,
// no phase name, no event name, no path, no source, no run
// prefix, and no verbatim reason - the summaries carry phases,
// events, paths, sources, run prefixes, and reasons, and the
// fold consumes and never prints them. The scorecard path is
// a pure read - it creates nothing, sends nothing, and retries
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-verification-failed-history-"));
}

const BARE = "Verification failed history: clear, 0 failed, 0 append, 0 read, 0 distinct events, 0 total";

test("verification failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = verificationFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = verificationFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held verification scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verification failed history scorecard: the writer's failures fold to counts with distinct events as a number only, and no path, source, run prefix, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = verificationFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("append", "change src/a.ts (source edit-apply)", "ENOENT: no such file sekrit"));
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("append", "change src/b.ts (source edit-apply)", "disk full"));
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("append", "verification build passed (run 12345678)", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("append", "verification test failed (run abcdef12)", "EACCES: permission denied"));
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("read", "ledger", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = verificationFailedHistoryScorecardText(dir);
    assert.equal(text, "Verification failed history: attention, 5 failed, 4 append, 1 read, 4 distinct events, 5 total");
    assert.equal(text.includes("src/a.ts"), false, "no path surfaces");
    assert.equal(text.includes("edit-apply"), false, "no source surfaces");
    assert.equal(text.includes("build"), false, "no event name surfaces");
    assert.equal(text.includes("12345678"), false, "no run prefix surfaces");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verification failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = verificationFailureSummary("append", "change src/a.ts (source test)", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseVerificationFailedSummary(capped), { phase: "append", event: "change" });
    recordActivity(dir, "sam", "verification-failed", capped);
    const text = verificationFailedHistoryScorecardText(dir);
    assert.equal(text, "Verification failed history: attention, 1 failed, 1 append, 0 read, 1 distinct events, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verification failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and mismatched phase shapes count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "verification-failed", verificationFailureSummary("append", "change src/a.ts (source test)", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "verification-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "verification-failed", skillUseFailureSummary("agent-reach", null, "boom sekrit"));
    recordActivity(dir, "sam", "verification-failed", "Verification append failed for change src/a.ts (source test):   ");
    recordActivity(dir, "sam", "verification-failed", "Verification read failed for change src/a.ts (source test): boom");
    recordActivity(dir, "sam", "verification-failed", "Verification append failed for ledger: boom");
    const text = verificationFailedHistoryScorecardText(dir);
    assert.equal(text, "Verification failed history: attention, 1 failed, 1 append, 0 read, 1 distinct events, 6 total, 5 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verification failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    verificationFailureSummary("append", "change src/a.ts (source test)", "EPERM: operation not permitted"),
    "Verification append failed for change src/a.ts (source test): EPERM: operation not permitted",
  );
  assert.deepEqual(parseVerificationFailedSummary(verificationFailureSummary("append", "change src/a.ts (source test)", "boom")), { phase: "append", event: "change" });
  assert.deepEqual(parseVerificationFailedSummary(verificationFailureSummary("read", "ledger", "boom")), { phase: "read", event: "ledger" });
  assert.deepEqual(parseVerificationFailedSummary(verificationFailureSummary("append", "verification build passed (run 12345678)", "boom")), { phase: "append", event: "verification build passed" });
  assert.deepEqual(parseVerificationFailedSummary(verificationFailureSummary("append", "verification test failed (run r1)", "boom")), { phase: "append", event: "verification test failed" }, "a short caller-shaped run id still parses - no fixed-width run shape is assumed");
  assert.equal(parseVerificationFailedSummary(""), null);
  assert.equal(parseVerificationFailedSummary("Verification append failed for change src/a.ts (source test):"), null, "a line with no reason does not parse");
  assert.equal(parseVerificationFailedSummary("Verification append failed for change src/a.ts (source test): "), null, "a line with a blank reason does not parse");
  assert.equal(parseVerificationFailedSummary("Verification write failed for ledger: boom"), null, "a phase the seam never writes does not parse");
  assert.equal(parseVerificationFailedSummary("Verification append failed for ledger: boom"), null, "an append line naming the read label does not parse");
  assert.equal(parseVerificationFailedSummary("Verification read failed for change src/a.ts (source test): boom"), null, "a read line naming an append event does not parse");
  assert.equal(parseVerificationFailedSummary("Verification append failed for verification lint passed (run 12345678): boom"), null, "a kind the seam never writes does not parse");
  assert.equal(parseVerificationFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), null, "a skill-use-failed line never parses as a verification-failed line");
  assert.deepEqual(parseVerificationFailedSummary("Verification append failed for change src/a.ts (source test): boom: with colon"), { phase: "append", event: "change" }, "a reason carrying a colon still parses from the fixed head");
});

test("verification failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-verification-failed-history"), "sam-verification-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-verification-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["verify", "failed-history"], "the argv rides verify failed-history");
});

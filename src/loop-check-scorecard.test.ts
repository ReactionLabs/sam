import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { loopCheckLedgerSummary, loopCheckScorecardText, parseLoopCheckSummary } from "./loop-guards.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import type { VerificationStatus } from "./verification.js";

// The loop-check daily-measurement wiring (2026-11-19, the
// measured-proof series): turns that change code and close
// while the verification ledger reads unverified or failed
// have ledgered as "loop-check" lines since the finish
// self-check landed - one line per short close, in the one
// fixed shape the loops write - but the class was never
// folded, so how often SAM's turns end over code SAM itself
// does not count as done, and how many files those closes
// leave pending, was invisible in aggregate. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, no path, no verbatim summary - closes fold into
// the fixed shape the loops write (through its ONE writer)
// and an unmatched shape counts toward the total and the
// unparseable count, never printed. The verdict is
// attention whenever any line exists: every loop-check line
// is by construction a turn that closed over code not
// counted done. The scorecard path is a pure read - it
// creates nothing, spends no model call, and closes no
// turn; every state here is built through the ledger's own
// public door (recordActivity) with the seam's own summary
// writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loop-check-scorecard-"));
}

function status(state: VerificationStatus["state"], paths: string[]): VerificationStatus {
  return {
    state,
    pendingChanges: paths.map(path => ({ path, replacementHash: "hash", at: "2026-11-19T00:00:00.000Z", source: "code-write" })),
    lastChangeAt: null,
    lastVerificationAt: null,
    buildPassedAfterChange: false,
    testPassedAfterChange: false,
  };
}

test("loop-check scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = loopCheckScorecardText(dir);
    assert.equal(text, "Loop checks: clear, 0 unverified, 0 failed, 0 other, 0 pending files, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = loopCheckScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held loop-check scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop-check scorecard: short closes fold to counts, read attention, and leak no path or note", () => {
  const dir = scratch();
  try {
    const clean = loopCheckScorecardText(dir);
    recordActivity(dir, "sam", "loop-check", loopCheckLedgerSummary(status("unverified", ["sekrit-file.py"])) as string);
    recordActivity(dir, "sam", "loop-check", loopCheckLedgerSummary(status("unverified", ["sekrit-file.py", "other-file.py"])) as string);
    recordActivity(dir, "sam", "loop-check", loopCheckLedgerSummary(status("failed", ["sekrit-file.py", "other-file.py", "third-file.py"])) as string);
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = loopCheckScorecardText(dir);
    assert.equal(text, "Loop checks: attention, 2 unverified, 1 failed, 0 other, 6 pending files, 3 total");
    assert.equal(text.includes("sekrit-file"), false, "no path surfaces");
    assert.equal(text.includes("other-file"), false, "no path surfaces");
    assert.equal(text.includes("Verification note"), false, "no verbatim summary surfaces");
    assert.notEqual(text, clean, "the first short close changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop-check scorecard: an unmatched shape flips the verdict to attention and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-check", loopCheckLedgerSummary(status("failed", ["sekrit-file.py"])) as string);
    recordActivity(dir, "sam", "loop-check", "Some wholly novel loop-check shape mentioning sekrit-file.py");
    const text = loopCheckScorecardText(dir);
    assert.equal(text, "Loop checks: attention, 0 unverified, 1 failed, 0 other, 1 pending files, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no path surfaces");
    assert.equal(text.includes("novel loop-check"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop-check parse: the seam's own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(
    loopCheckLedgerSummary(status("unverified", ["a.py"])),
    "Chat turn closed over code in verification state unverified (a.py) - Verification note: code changed in this turn and is not verified yet - a fresh build and test have not both passed after the last change (unverified: a.py). The change is not done until both pass; run them through sam_code, or hand the work to the coding loop.",
    "the writer is byte-identical to the shape the loops have always ledgered",
  );
  assert.equal(
    loopCheckLedgerSummary(status("failed", ["a.py", "b.py"])),
    "Chat turn closed over code in verification state failed (a.py, b.py) - Verification note: code changed in this turn and the latest verification after the change FAILED, so the change is not done. Read the failing build or test output, fix the cause, and verify again.",
    "the writer is byte-identical to the shape the loops have always ledgered",
  );
  assert.equal(loopCheckLedgerSummary(status("verified", [])), null, "a verified close ledgers nothing");
  assert.equal(loopCheckLedgerSummary(status("clean", [])), null, "a clean close ledgers nothing");
  assert.deepEqual(parseLoopCheckSummary(loopCheckLedgerSummary(status("unverified", ["a.py"])) as string), { state: "unverified", files: 1 });
  assert.deepEqual(parseLoopCheckSummary(loopCheckLedgerSummary(status("unverified", ["a.py", "b.py", "c.py"])) as string), { state: "unverified", files: 3 });
  assert.deepEqual(parseLoopCheckSummary(loopCheckLedgerSummary(status("failed", ["a.py", "b.py"])) as string), { state: "failed", files: 2 });
  assert.deepEqual(
    parseLoopCheckSummary("Chat turn closed over code in verification state unverified (sam-grep-phrase.py) - Verification note: code changed in this turn and is not verified yet - a fresh build and test have not both passed after the last change (unverified: sam-grep-phrase.py). The change is not done until both pass; run them through sam_code, or hand the work to the coding loop."),
    { state: "unverified", files: 1 },
    "a live-shaped line parses",
  );
  assert.equal(parseLoopCheckSummary(""), null);
  assert.equal(parseLoopCheckSummary("Chat turn closed over code in verification state unverified (a.py)"), null, "no note, no parse");
  assert.equal(parseLoopCheckSummary("Some wholly novel loop-check shape"), null);
});

test("loop-check scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-loop-checks"), "sam-loop-checks is allowlisted");
  const argv = scriptArgv("/some/root", "sam-loop-checks");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "loop-check-scorecard"], "the argv rides observe loop-check-scorecard");
});

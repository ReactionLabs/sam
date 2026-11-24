import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStandingFileFailedSummary, standingFileFailedHistoryScorecardText, standingFileFailureSummary } from "./standing-files.js";
import { recordActivity } from "./activity.js";
import { compactionFailureSummary } from "./compaction.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The standing file failed history daily-measurement wiring
// (2026-11-24, the measured-proof series): every failed
// standing-file read ledgers a standing-file-failed line
// through the ONE writer (standingFileFailureSummary, fixed
// shape "Standing file read failed for profile <profile>
// (<name>): <reason>", the name one of the three fixed
// standing files) - and while self-work labels single lines
// and the config-acts scorecard folds the success kind, no
// surface folds this kind, so a broken standing file (a dead
// read means a persona silently drops out of every prompt
// that profile assembles) was invisible in aggregate. Every
// failure line is by construction a read that did not
// complete, so the verdict is attention when any failure was
// ever recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no reason, no profile name, and no file name - the
// summaries carry all of those, and the fold consumes and
// never prints them (distinct values surface as numbers
// only). The scorecard path is a pure read - it creates
// nothing, reads no standing file, and assembles nothing;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-standing-file-failed-history-"));
}

const BARE = "Standing file failed history: clear, 0 failed, 0 distinct profiles, 0 distinct files, 0 total";

test("standing file failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = standingFileFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = standingFileFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held standing file scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("standing file failed history scorecard: the writer's failures fold to counts with the distinct profile and file counts, and no profile, file name, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = standingFileFailedHistoryScorecardText(dir);
    recordActivity(dir, "sekrit-profile", "standing-file-failed", standingFileFailureSummary("sekrit-profile", "persona", "EACCES: permission denied, open '/sekrit/path/persona.md'"));
    recordActivity(dir, "sekrit-profile", "standing-file-failed", standingFileFailureSummary("sekrit-profile", "persona", "boom"));
    recordActivity(dir, "sekrit-profile", "standing-file-failed", standingFileFailureSummary("sekrit-profile", "owner", "boom"));
    recordActivity(dir, "other-profile", "standing-file-failed", standingFileFailureSummary("other-profile", "ops", "boom"));
    recordActivity(dir, "sekrit-profile", "standing-file", "Standing file persona (stable) set, 42 chars");
    const text = standingFileFailedHistoryScorecardText(dir);
    assert.equal(text, "Standing file failed history: attention, 4 failed, 2 distinct profiles, 3 distinct files, 4 total");
    assert.equal(text.includes("sekrit"), false, "no profile name or path surfaces");
    assert.equal(text.includes("persona"), false, "no file name surfaces");
    assert.equal(text.includes("EACCES"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("standing file failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, an unknown-file shape, and an invalid-profile shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "standing-file-failed", standingFileFailureSummary("sam", "ops", "boom"));
    recordActivity(dir, "sam", "standing-file-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "standing-file-failed", compactionFailureSummary("abcdef123456", "read", "boom sekrit"));
    recordActivity(dir, "sam", "standing-file-failed", "Standing file read failed for profile sam (ops):   ");
    recordActivity(dir, "sam", "standing-file-failed", "Standing file read failed for profile sam (secrets): boom");
    recordActivity(dir, "sam", "standing-file-failed", "Standing file read failed for profile Sam (ops): boom");
    const text = standingFileFailedHistoryScorecardText(dir);
    assert.equal(text, "Standing file failed history: attention, 1 failed, 1 distinct profiles, 1 distinct files, 6 total, 5 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("standing file failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    standingFileFailureSummary("sam", "persona", "EACCES: permission denied"),
    "Standing file read failed for profile sam (persona): EACCES: permission denied",
  );
  assert.deepEqual(parseStandingFileFailedSummary(standingFileFailureSummary("sam", "persona", "boom")), { profile: "sam", name: "persona" });
  assert.deepEqual(parseStandingFileFailedSummary(standingFileFailureSummary("second-shift", "owner", "boom")), { profile: "second-shift", name: "owner" });
  assert.equal(parseStandingFileFailedSummary(""), null);
  assert.equal(parseStandingFileFailedSummary("Standing file read failed for profile sam (ops):"), null, "a line with no reason does not parse");
  assert.equal(parseStandingFileFailedSummary("Standing file read failed for profile sam (ops): "), null, "a line with a blank reason does not parse");
  assert.equal(parseStandingFileFailedSummary("Standing file read failed for profile sam (secrets): boom"), null, "a file name the writer never writes does not parse");
  assert.equal(parseStandingFileFailedSummary("Standing file read failed for profile Sam (ops): boom"), null, "a profile outside the writer's alphabet does not parse");
  assert.equal(parseStandingFileFailedSummary("Standing file read failed for profile " + "x".repeat(65) + " (ops): boom"), null, "a profile longer than the writer's 64-char cap never parses");
  assert.equal(parseStandingFileFailedSummary(compactionFailureSummary("abcdef123456", "read", "boom")), null, "a compaction-failed line never parses as a standing-file-failed line");
  assert.deepEqual(parseStandingFileFailedSummary("Standing file read failed for profile sam (ops): boom: with colon"), { profile: "sam", name: "ops" }, "a reason carrying a colon still parses from the fixed head");
});

test("standing file failed history scorecard: repeat failures against one profile and file raise the failed count only, and a held state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "standing-file-failed", standingFileFailureSummary("sam", "persona", "boom"));
    recordActivity(dir, "sam", "standing-file-failed", standingFileFailureSummary("sam", "persona", "boom again"));
    recordActivity(dir, "sam", "standing-file-failed", standingFileFailureSummary("sam", "persona", "boom a third time"));
    const text = standingFileFailedHistoryScorecardText(dir);
    assert.equal(text, "Standing file failed history: attention, 3 failed, 1 distinct profiles, 1 distinct files, 3 total");
    assert.equal(standingFileFailedHistoryScorecardText(dir), text, "a held state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("standing file failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-standing-file-failed-history"), "sam-standing-file-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-standing-file-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-3), ["agents", "files", "failed-history"], "the argv rides agents files failed-history");
});

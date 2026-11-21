import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { backupDrillHistoryScorecardText, backupDrillLedgerSummary, backupDrillNoArchiveLedgerSummary, parseBackupDrillSummary } from "./backup.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The backup drill history daily-measurement wiring (2026-11-20,
// the measured-proof series): every recorded restore drill has
// ledgered as a backup-drill line since the drill landed - until
// now as inline concatenation at the seam, with no ONE writer and
// no fold, so how many drills ever recorded, whether any drill
// ever FAILED, and how the drilled state's boot counts trend was
// invisible in aggregate (the drill's own text proves only the
// NEWEST archive; the backup history scorecard folds backup /
// backup-failed / restore but not backup-drill - the last
// unmeasured live class in the census). A failed drill is the
// restore path naming itself broken before restore day, so the
// verdict is attention only when a drill failed, any error was
// ever summed, a run found no archive, or a line is unparseable.
// The scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no stamp, no
// actor, no archive name, no destination path, no error text -
// the summaries carry the counts and the path, which the fold
// consumes and never prints. The scorecard path is a pure read -
// it creates nothing and runs no drill; every state here is built
// through the ledger's own public door (recordActivity) with the
// seam's own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-backup-drill-history-"));
}

const OK_REPORT = { ok: true, files: 65, databases: [1, 2], chats: 22, missions: 0, memories: 64, preferences: 7, errors: [] } as never;
const FAILED_REPORT = { ok: false, files: 66, databases: [1, 2, 3], chats: 23, missions: 1, memories: 65, preferences: 7, errors: ["boom sekrit_error"] } as never;

test("backup drill history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = backupDrillHistoryScorecardText(dir);
    assert.equal(text, "Backup drill history: clear, 0 runs, 0 ok, 0 failed, 0 no-archive, 0 errors, latest 0 files / 0 databases, latest boot 0 chats / 0 missions / 0 memories / 0 preferences, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = backupDrillHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held drill history scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup drill history scorecard: the history folds to counts, the latest drill wins, and no path surfaces", () => {
  const dir = scratch();
  try {
    const clean = backupDrillHistoryScorecardText(dir);
    recordActivity(dir, "sam", "backup-drill", backupDrillLedgerSummary(OK_REPORT));
    recordActivity(dir, "sam", "backup-drill", backupDrillLedgerSummary({ ...(OK_REPORT as object), files: 66, chats: 25, memories: 68 } as never));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = backupDrillHistoryScorecardText(dir);
    assert.equal(text, "Backup drill history: clear, 2 runs, 2 ok, 0 failed, 0 no-archive, 0 errors, latest 66 files / 2 databases, latest boot 25 chats / 0 missions / 68 memories / 7 preferences, 2 total");
    assert.notEqual(text, clean, "the first recorded drill changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup drill history scorecard: a failed drill and a no-archive run are attention and stay attention", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "backup-drill", backupDrillLedgerSummary(FAILED_REPORT));
    recordActivity(dir, "sam", "backup-drill", backupDrillNoArchiveLedgerSummary("/some/sekrit_dest"));
    const text = backupDrillHistoryScorecardText(dir);
    assert.equal(text, "Backup drill history: attention, 2 runs, 0 ok, 1 failed, 1 no-archive, 1 errors, latest 66 files / 3 databases, latest boot 23 chats / 1 missions / 65 memories / 7 preferences, 2 total");
    assert.equal(text.includes("sekrit_dest"), false, "no destination path surfaces");
    assert.equal(text.includes("sekrit_error"), false, "no error text surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup drill history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "backup-drill", backupDrillLedgerSummary(OK_REPORT));
    recordActivity(dir, "sam", "backup-drill", "Some wholly novel drill shape naming sekrit_evidence");
    const text = backupDrillHistoryScorecardText(dir);
    assert.equal(text, "Backup drill history: attention, 1 runs, 1 ok, 0 failed, 0 no-archive, 0 errors, latest 65 files / 2 databases, latest boot 22 chats / 0 missions / 64 memories / 7 preferences, 2 total, 1 unparseable");
    assert.equal(text.includes("novel drill"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup drill parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(backupDrillLedgerSummary(OK_REPORT), "Restore drill recorded: OK, 65 files, 2 databases, boot counts 22 chats / 0 missions / 64 memories / 7 preferences, 0 error(s)");
  assert.equal(backupDrillLedgerSummary(FAILED_REPORT), "Restore drill recorded: FAILED, 66 files, 3 databases, boot counts 23 chats / 1 missions / 65 memories / 7 preferences, 1 error(s)");
  assert.equal(backupDrillNoArchiveLedgerSummary("/x/backups"), "Restore drill recorded: no state backup archive found in /x/backups");
  assert.deepEqual(parseBackupDrillSummary(backupDrillLedgerSummary(OK_REPORT)), { state: "ok", files: 65, databases: 2, chats: 22, missions: 0, memories: 64, preferences: 7, errors: 0 });
  assert.deepEqual(parseBackupDrillSummary(backupDrillLedgerSummary(FAILED_REPORT)), { state: "failed", files: 66, databases: 3, chats: 23, missions: 1, memories: 65, preferences: 7, errors: 1 });
  assert.deepEqual(parseBackupDrillSummary(backupDrillNoArchiveLedgerSummary("/x/backups")), { state: "no-archive" });
  assert.equal(parseBackupDrillSummary(""), null);
  assert.equal(parseBackupDrillSummary("Restore drill recorded: PASSED, 65 files, 2 databases, boot counts 22 chats / 0 missions / 64 memories / 7 preferences, 0 error(s)"), null, "an unknown verdict does not parse");
  assert.equal(parseBackupDrillSummary("Restore drill recorded: OK, 65 files, 2 databases, boot counts 22 chats / 0 missions / 64 memories / 7 preferences"), null, "a truncated line does not parse");
  assert.equal(parseBackupDrillSummary("Restore drill recorded: OK, 65 files, 2 databases, boot counts 22 chats / 0 missions / 64 memories / 7 preferences, 0 error(s) extra"), null, "trailing text does not parse");
  assert.equal(parseBackupDrillSummary("Restore drill recorded: no state backup archive found in "), null, "a no-archive line with no destination does not parse");
});

test("backup drill history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-backup-drill-history"), "sam-backup-drill-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-backup-drill-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["backup", "drill-scorecard"], "the argv rides backup drill-scorecard");
});

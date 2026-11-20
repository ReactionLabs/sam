import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  backupFailureSummary,
  backupHistoryScorecardText,
  backupLedgerSummary,
  parseBackupFailedSummary,
  parseBackupSummary,
  parseRestoreSummary,
  restoreLedgerSummary,
} from "./backup.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The backup history daily-measurement wiring (2026-11-19, the
// measured-proof series): every nightly state backup, every
// backup failure, and every restore has ledgered as a backup /
// backup-failed / restore line since P9 landed - one line per
// event, in the fixed shapes the seams write, carrying the
// archive name (which embeds its creation stamp) and, for
// failures, the verbatim reason - but the classes were never
// folded, so how many backups SAM has landed, whether any
// backup ever failed, whether a restore ever ran, and how the
// archive's shape grows was invisible in aggregate. The
// backup-drill scorecard proves only the NEWEST archive. The
// verdict is attention only when a backup failed or a line is
// unparseable: backups and restores are operator or scheduled
// acts, a failed backup is the news. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no
// archive name, no failure reason - a backup fold that printed
// archive names would change every night even at an identical
// shape. The scorecard path is a pure read - it creates
// nothing, verifies nothing, drills nothing, and restores
// nothing; every state here is built through the ledger's own
// public door (recordActivity) with the seams' own summary
// writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-backup-history-scorecard-"));
}

const ARCHIVE = "sam-state-20261119T083036Z.tar.gz";

test("backup history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = backupHistoryScorecardText(dir);
    assert.equal(text, "Backups: clear, 0 backups, 0 failed, 0 restores, latest 0 files / 0 databases / 0 bytes, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = backupHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held backup history scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup history scorecard: the history folds to counts and no archive name surfaces, latest wins", () => {
  const dir = scratch();
  try {
    const clean = backupHistoryScorecardText(dir);
    recordActivity(dir, "sam", "backup", backupLedgerSummary("sam-state-20261118T083016Z.tar.gz", 66, 38, 503117));
    recordActivity(dir, "sam", "backup", backupLedgerSummary(ARCHIVE, 66, 38, 519724));
    recordActivity(dir, "owner", "restore", restoreLedgerSummary(ARCHIVE, null));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = backupHistoryScorecardText(dir);
    assert.equal(text, "Backups: clear, 2 backups, 0 failed, 1 restores, latest 66 files / 38 databases / 519724 bytes, 3 total");
    assert.equal(text.includes("sam-state"), false, "no archive name surfaces");
    assert.equal(text.includes("20261119"), false, "no archive stamp surfaces");
    assert.notEqual(text, clean, "the first backup changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup history scorecard: a failed backup is attention and its reason never surfaces", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "backup", backupLedgerSummary(ARCHIVE, 66, 38, 519724));
    recordActivity(dir, "sam", "backup-failed", backupFailureSummary(new Error("sekrit disk path exploded")));
    const text = backupHistoryScorecardText(dir);
    assert.equal(text, "Backups: attention, 1 backups, 1 failed, 0 restores, latest 66 files / 38 databases / 519724 bytes, 2 total");
    assert.equal(text.includes("sekrit"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "backup", backupLedgerSummary(ARCHIVE, 66, 38, 519724));
    recordActivity(dir, "sam", "backup", "Some wholly novel backup shape mentioning sekrit archives");
    recordActivity(dir, "owner", "restore", "Restored state from a sekrit place");
    const text = backupHistoryScorecardText(dir);
    assert.equal(text, "Backups: attention, 1 backups, 0 failed, 0 restores, latest 66 files / 38 databases / 519724 bytes, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel backup"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup history parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    backupLedgerSummary(ARCHIVE, 66, 38, 519724),
    "State backup sam-state-20261119T083036Z.tar.gz (66 files, 38 databases, 519724 bytes)",
  );
  assert.equal(restoreLedgerSummary(ARCHIVE, null), "Restored state from sam-state-20261119T083036Z.tar.gz");
  assert.equal(
    restoreLedgerSummary(ARCHIVE, ".sam.pre-restore-20261119T090000Z"),
    "Restored state from sam-state-20261119T083036Z.tar.gz (previous state kept at .sam.pre-restore-20261119T090000Z)",
  );
  assert.equal(backupFailureSummary(new Error("disk full")), "Backup failed: disk full");
  assert.deepEqual(parseBackupSummary(backupLedgerSummary(ARCHIVE, 66, 38, 519724)), { files: 66, databases: 38, bytes: 519724 });
  assert.deepEqual(parseBackupFailedSummary(backupFailureSummary(new Error("disk full"))), {});
  assert.deepEqual(parseRestoreSummary(restoreLedgerSummary(ARCHIVE, null)), {});
  assert.deepEqual(parseRestoreSummary(restoreLedgerSummary(ARCHIVE, ".sam.pre-restore-x")), {});
  assert.equal(parseBackupSummary(""), null);
  assert.equal(parseBackupSummary("State backup sam-state-20261119T083036Z.tar.gz (66 files, 38 databases)"), null, "a truncated backup line does not parse");
  assert.equal(parseBackupSummary("State backup other.tar.gz (1 files, 1 databases, 1 bytes)"), null, "a non-state archive name does not parse");
  assert.equal(parseBackupFailedSummary("Backup failed:"), null, "a failure line with no reason does not parse");
  assert.equal(parseRestoreSummary("Restored state from sam-state-20261119T083036Z.tar.gz yesterday"), null);
  assert.equal(parseRestoreSummary("Some wholly novel restore shape"), null);
});

test("backup history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-backup-history"), "sam-backup-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-backup-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["backup", "history-scorecard"], "the argv rides backup history-scorecard");
});

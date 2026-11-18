import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { BACKUP_DRILL_SCRIPT, backupDrillText, createBackup, runBackupDrill } from "./backup.js";
import { ChatStore } from "./chats.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { PreferenceStore } from "./preferences.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { MissionStore } from "./storage.js";

// The backup drill's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04 through loop audit's
// 19:04 fixes): the P9 nightly backup creates an archive
// every night, but verifyBackup / runRestoreDrill were
// manual CLI verbs only - no ledger line, no job, no
// scorecard - so a backup that stopped verifying or
// booting would be discovered on restore day.
// backupDrillText is the script job's stdout and is
// P3-diffed on its facts, so it carries no clock reading
// and no archive name (the name embeds the backup's
// creation stamp, a fresh date fact every night). Two
// consecutive drills of the same backup produce
// byte-identical text P3 judges the same news; a real
// state change in the next backup still changes the text.

function seedState(root: string, chats: number): void {
  const store = new ChatStore(root);
  for (let i = 0; i < chats; i++) {
    const chat = store.create("Desk " + String(i), "trading");
    store.add(chat.id, "user", "Watch the frozen stack");
  }
  store.close();
  const prefs = new PreferenceStore(root);
  prefs.note("trading", "Never call it a mini", "rule", "operator");
  prefs.close();
  const missions = new MissionStore(join(root, ".sam", "missions.db"));
  missions.create("Hold the desk");
  missions.close();
}

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-backup-drill-")); }

test("backup-drill scorecard: two consecutive drills are byte-identical, stamp-free, and P3-silent", () => {
  const root = fresh();
  try {
    seedState(root, 1);
    createBackup(root, join(root, "backups"));
    const first = runBackupDrill(root);
    assert.ok(first?.ok, first?.errors.join("; "));
    const text = backupDrillText(first);
    assert.match(text, /^Restore drill - OK \(verified and booted\)$/m);
    assert.match(text, /Boot counts: 1 chats, 1 missions, \d+ memories, 1 preferences/);
    assert.doesNotMatch(text, /sam-state-\d{8}T\d{6}Z/, "the archive name (a creation stamp) never enters the text");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no clock reading in the text");
    const second = runBackupDrill(root);
    const again = backupDrillText(second);
    assert.equal(again, text, "two drills of the same backup produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held backup the same news",
    );
    const lines = readActivity(root, 50, { kind: "backup-drill" });
    assert.equal(lines.length, 2, "one ledger line per drill run");
    assert.match(lines[0].summary, /^Restore drill recorded: OK, /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup-drill scorecard: a real state change in the next backup still changes the text", () => {
  const root = fresh();
  try {
    seedState(root, 1);
    createBackup(root, join(root, "backups"));
    const before = backupDrillText(runBackupDrill(root));
    assert.match(before, /Boot counts: 1 chats,/);
    // Archive names are second-resolution; force a distinct stamp.
    const now = Date.now(); while (Date.now() - now < 1100) { /* spin */ }
    seedState(root, 1);
    createBackup(root, join(root, "backups"));
    const after = backupDrillText(runBackupDrill(root));
    assert.notEqual(after, before, "the next backup carrying a second chat changes the scorecard");
    assert.match(after, /Boot counts: 2 chats,/, "the boot-count line carries the new count");
    assert.doesNotMatch(after, /sam-state-\d{8}T\d{6}Z/, "no archive name in the changed text either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup-drill scorecard: no archive yet is a stable text, not an error, and a stateless install ledgers nothing", () => {
  const root = fresh();
  const empty = fresh();
  try {
    seedState(root, 1);
    const text = backupDrillText(runBackupDrill(root));
    assert.match(text, /^Restore drill - no backup to drill$/m);
    assert.equal(backupDrillText(runBackupDrill(root)), text, "the empty state is stable across runs");
    const lines = readActivity(root, 50, { kind: "backup-drill" });
    assert.equal(lines.length, 2, "the absence is ledgered once per run, so a stopped nightly backup stays countable");
    assert.equal(runBackupDrill(empty), null);
    assert.equal(readActivity(empty, 50, { kind: "backup-drill" }).length, 0, "a stateless install ledgers nothing");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});

test("backup-drill scorecard: sam-backup-drill is allowlisted and rides the backup scorecard door", () => {
  assert.ok(scriptCommandNames().includes(BACKUP_DRILL_SCRIPT));
  const argv = scriptArgv(fresh(), BACKUP_DRILL_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("backup") && argv.includes("scorecard"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, restoreBackup, runRestoreDrill, verifyBackup } from "./backup.js";
import { ChatStore } from "./chats.js";
import { PreferenceStore } from "./preferences.js";
import { MissionStore } from "./storage.js";

function seedState(root: string): void {
  const chats = new ChatStore(root);
  const chat = chats.create("Desk", "trading");
  chats.add(chat.id, "user", "Watch the frozen stack");
  chats.add(chat.id, "assistant", "Watching it.");
  chats.close();
  const prefs = new PreferenceStore(root);
  prefs.note("trading", "Never call it a mini", "rule", "operator");
  prefs.close();
  const missions = new MissionStore(join(root, ".sam", "missions.db"));
  missions.create("Hold the desk");
  missions.close();
  writeFileSync(join(root, ".sam", "minis.json"), JSON.stringify([{ name: "trading" }]));
}

test("createBackup writes a manifest-verified tarball with consistent DB snapshots and no WAL sidecars", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bk-"));
  const dest = mkdtempSync(join(tmpdir(), "sam-bkdest-"));
  try {
    seedState(root);
    const info = createBackup(root, dest);
    assert.match(info.archive, /^sam-state-\d{8}T\d{6}Z\.tar\.gz$/);
    assert.ok(info.bytes > 0);
    const report = verifyBackup(info.path);
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.ok(report.databases.includes("chats.db"), report.databases.join(","));
    assert.ok(report.databases.includes("preferences.db"), report.databases.join(","));
    assert.ok(report.files >= 4);
    assert.equal(listBackups(dest).length, 1);
    // The activity ledger records the backup, like every other thing SAM does.
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /"kind":"backup"/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
});

test("restore drill boots the copy: the real stores open and count what was seeded", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bk2-"));
  const dest = mkdtempSync(join(tmpdir(), "sam-bkdest2-"));
  try {
    seedState(root);
    const info = createBackup(root, dest);
    const drill = runRestoreDrill(info.path);
    assert.equal(drill.ok, true, drill.errors.join("; "));
    assert.equal(drill.chats, 1);
    assert.equal(drill.missions, 1);
    assert.equal(drill.preferences, 1);
    assert.ok(drill.memories >= 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
});

test("restore refuses to overwrite live state without force, and keeps the old state aside with it", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bk3-"));
  const target = mkdtempSync(join(tmpdir(), "sam-bk3t-"));
  const dest = mkdtempSync(join(tmpdir(), "sam-bkdest3-"));
  try {
    seedState(root);
    const info = createBackup(root, dest);
    seedState(target); // target already has live state of its own
    assert.throws(() => restoreBackup(target, info.path), /already has \.sam state/);
    const result = restoreBackup(target, info.path, true);
    assert.ok(result.keptAside && existsSync(result.keptAside));
    const chats = new ChatStore(target);
    try { assert.equal(chats.list().length, 1); } finally { chats.close(); }
    // Restoring into an empty workspace needs no force.
    const empty = mkdtempSync(join(tmpdir(), "sam-bk3e-"));
    try {
      const again = restoreBackup(empty, info.path);
      assert.equal(again.keptAside, null);
      assert.ok(existsSync(join(empty, ".sam", "chats.db")));
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
});

test("verify catches a tampered file and a corrupt database", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bk4-"));
  const dest = mkdtempSync(join(tmpdir(), "sam-bkdest4-"));
  const scratch = mkdtempSync(join(tmpdir(), "sam-bk4s-"));
  try {
    seedState(root);
    const info = createBackup(root, dest);
    // Tamper: rewrite minis.json inside a re-packed copy.
    execFileSync("tar", ["-xzf", info.path, "-C", scratch]);
    writeFileSync(join(scratch, "minis.json"), JSON.stringify([{ name: "intruder" }]));
    const tampered = join(dest, "sam-state-20990101T000000Z.tar.gz");
    // Named operands, never ".": Windows bsdtar refuses to visit "." in a
    // temp dir (same owner-hit failure as production backup creation).
    execFileSync("tar", ["-czf", tampered, "-C", scratch, ...readdirSync(scratch)]);
    const report = verifyBackup(tampered);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some(e => e.includes("minis.json")), report.errors.join("; "));
    // Corrupt: garbage where the archive should be is not a backup at all.
    const garbage = join(dest, "sam-state-20990102T000000Z.tar.gz");
    writeFileSync(garbage, "not a tarball");
    assert.throws(() => verifyBackup(garbage));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test("createBackup prunes to the newest keep archives and refuses a stateless workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bk5-"));
  const dest = mkdtempSync(join(tmpdir(), "sam-bkdest5-"));
  const empty = mkdtempSync(join(tmpdir(), "sam-bk5e-"));
  try {
    assert.throws(() => createBackup(empty, dest), /No \.sam state/);
    seedState(root);
    mkdirSync(join(dest, "decoy"), { recursive: true });
    writeFileSync(join(dest, "unrelated.txt"), "keep me");
    for (let i = 0; i < 3; i++) {
      createBackup(root, dest, 2);
      // Archive names are second-resolution; force distinct stamps.
      const now = Date.now(); while (Date.now() - now < 1100) { /* spin */ }
    }
    const kept = listBackups(dest);
    assert.equal(kept.length, 2);
    assert.ok(existsSync(join(dest, "unrelated.txt")));
    assert.equal(readdirSync(dest).filter(n => n.endsWith(".tar.gz")).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});

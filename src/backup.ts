import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { MissionStore } from "./storage.js";

// Reliability (program P9): SAM's whole .sam state is the product - every
// chat, law, episode, door key, and ledger line lives there, and until now
// none of it existed anywhere but Johnny's box. A backup is a tarball of
// the state directory with two disciplines a raw copy does not have:
//
// - Consistent databases. The state holds live SQLite DBs in WAL mode;
//   copying the .db files mid-write can capture a torn page. Each DB is
//   snapshotted with VACUUM INTO (a transactionally consistent copy),
//   sidecar -wal/-shm files are never copied, and a DB that cannot be
//   snapshotted fails the whole backup loudly - a partial backup that
//   looks fine is worse than none.
// - A manifest that can be checked without trust. manifest.json lists
//   every file with its byte count and sha256; verify recomputes both and
//   runs integrity_check on every DB, and the restore drill goes further
//   and actually opens the real stores on the extracted copy - a copy
//   that boots, counts and all, not a copy that merely un-tars.
//
// What never happens here: restore over a live state without --force
// (and even then the old state is renamed aside, never deleted), and any
// network movement - create/list/verify/drill/restore are local file
// operations; getting the tarball off the box is the pull script's job.
export interface BackupFileEntry { name: string; bytes: number; sha256: string }
export interface BackupManifest { format: 1; created_at: string; files: BackupFileEntry[]; databases: string[] }
export interface BackupInfo { archive: string; path: string; bytes: number; created_at: string }
export interface VerifyReport { ok: boolean; archive: string; files: number; databases: string[]; errors: string[] }
export interface DrillReport extends VerifyReport { chats: number; missions: number; memories: number; preferences: number }

const ARCHIVE_RE = /^sam-state-\d{8}T\d{6}Z\.tar\.gz$/;
function samDir(root: string): string { return join(resolve(root), ".sam"); }
function stamp(at: Date): string { return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function sha256File(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function snapshotDatabase(source: string, dest: string): void {
  const db = new Database(source);
  try {
    db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  } finally { db.close(); }
}

export function createBackup(root: string, destDir: string, keep = 7): BackupInfo {
  const state = samDir(root);
  if (!existsSync(state)) throw new Error("No .sam state to back up at " + state);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("keep must be 1..365");
  const dest = resolve(destDir);
  mkdirSync(dest, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "sam-backup-"));
  try {
    const names = readdirSync(state).filter(n => statSync(join(state, n)).isFile()).sort();
    const databases: string[] = [];
    for (const name of names) {
      if (name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal")) continue;
      if (name.endsWith(".db")) { snapshotDatabase(join(state, name), join(staging, name)); databases.push(name); }
      else copyFileSync(join(state, name), join(staging, name));
    }
    const files: BackupFileEntry[] = readdirSync(staging).sort().map(name => {
      const path = join(staging, name);
      return { name, bytes: statSync(path).size, sha256: sha256File(path) };
    });
    const created = new Date();
    const manifest: BackupManifest = { format: 1, created_at: created.toISOString(), files, databases: databases.sort() };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const archive = "sam-state-" + stamp(created) + ".tar.gz";
    const archivePath = join(dest, archive);
    execFileSync("tar", ["-czf", archivePath, "-C", staging, "."]);
    // Prune to the newest `keep` archives; names sort chronologically.
    const all = listBackups(dest);
    for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(old.path, { force: true });
    const info: BackupInfo = { archive, path: archivePath, bytes: statSync(archivePath).size, created_at: manifest.created_at };
    recordActivity(root, "sam", "backup", "State backup " + archive + " (" + files.length + " files, " + databases.length + " databases, " + info.bytes + " bytes)");
    return info;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function listBackups(destDir: string): BackupInfo[] {
  const dest = resolve(destDir);
  if (!existsSync(dest)) return [];
  return readdirSync(dest).filter(n => ARCHIVE_RE.test(n)).sort().map(name => {
    const path = join(dest, name);
    const st = statSync(path);
    return { archive: name, path, bytes: st.size, created_at: st.mtime.toISOString() };
  });
}

function extract(archivePath: string): string {
  if (!existsSync(archivePath)) throw new Error("Backup archive not found: " + archivePath);
  const dir = mkdtempSync(join(tmpdir(), "sam-restore-"));
  execFileSync("tar", ["-xzf", resolve(archivePath), "-C", dir]);
  return dir;
}

function checkExtracted(dir: string, archive: string): VerifyReport {
  const errors: string[] = [];
  let manifest: BackupManifest;
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (!value || typeof value !== "object" || (value as BackupManifest).format !== 1 || !Array.isArray((value as BackupManifest).files)) throw new Error("bad manifest");
    manifest = value as BackupManifest;
  } catch { return { ok: false, archive, files: 0, databases: [], errors: ["manifest.json missing or invalid"] }; }
  for (const entry of manifest.files) {
    const path = join(dir, entry.name);
    if (!existsSync(path)) { errors.push("missing file: " + entry.name); continue; }
    if (statSync(path).size !== entry.bytes) errors.push("size mismatch: " + entry.name);
    else if (sha256File(path) !== entry.sha256) errors.push("sha256 mismatch: " + entry.name);
  }
  for (const name of manifest.databases) {
    const path = join(dir, name);
    if (!existsSync(path)) continue; // already reported as missing above
    try {
      const db = new Database(path, { readonly: true });
      try {
        const row = db.pragma("integrity_check", { simple: true });
        if (row !== "ok") errors.push("integrity_check failed for " + name + ": " + String(row));
      } finally { db.close(); }
    } catch (e) { errors.push("cannot open database " + name + ": " + (e instanceof Error ? e.message : String(e))); }
  }
  return { ok: errors.length === 0, archive, files: manifest.files.length, databases: manifest.databases, errors };
}

export function verifyBackup(archivePath: string): VerifyReport {
  const dir = extract(archivePath);
  try { return checkExtracted(dir, basename(archivePath)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// The restore drill: verify, then boot the copy - open the real stores on
// the extracted state and count what they hold. Proves the backup is a
// working SAM state, not just a well-formed tarball.
export function runRestoreDrill(archivePath: string): DrillReport {
  const dir = extract(archivePath);
  try {
    const base = checkExtracted(dir, basename(archivePath));
    const report: DrillReport = { ...base, chats: 0, missions: 0, memories: 0, preferences: 0 };
    if (!base.ok) return report;
    const fakeRoot = mkdtempSync(join(tmpdir(), "sam-drill-"));
    try {
      renameSync(dir, join(fakeRoot, ".sam"));
      try {
        const chats = new ChatStore(fakeRoot); try { report.chats = chats.list().length; } finally { chats.close(); }
        const missions = new MissionStore(join(fakeRoot, ".sam", "missions.db")); try { report.missions = missions.list().length; } finally { missions.close(); }
        const memories = new MemoryStore(join(fakeRoot, ".sam", "missions.db")); try { report.memories = memories.list(undefined).length; } finally { memories.close(); }
        const prefs = new PreferenceStore(fakeRoot); try { report.preferences = prefs.list().length; } finally { prefs.close(); }
      } catch (e) { report.ok = false; report.errors.push("drill could not boot the copy: " + (e instanceof Error ? e.message : String(e))); }
    } finally { rmSync(fakeRoot, { recursive: true, force: true }); }
    return report;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function restoreBackup(root: string, archivePath: string, force = false): { restored: string; keptAside: string | null } {
  const dir = extract(archivePath);
  try {
    const check = checkExtracted(dir, basename(archivePath));
    if (!check.ok) throw new Error("Backup failed verification, refusing to restore: " + check.errors.join("; "));
    const target = samDir(root);
    let keptAside: string | null = null;
    if (existsSync(target) && readdirSync(target).length > 0) {
      if (!force) throw new Error("Target workspace already has .sam state; pass --force to restore over it (the old state is kept aside, never deleted)");
      keptAside = target + ".pre-restore-" + stamp(new Date());
      renameSync(target, keptAside);
    }
    mkdirSync(resolve(root), { recursive: true });
    renameSync(dir, target);
    recordActivity(root, "owner", "restore", "Restored state from " + basename(archivePath) + (keptAside ? " (previous state kept at " + basename(keptAside) + ")" : ""));
    return { restored: target, keptAside };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

import { openDatabase } from "./sqlite.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { MissionStore } from "./storage.js";
import { errorReason } from "./error-reason.js";

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
  const db = openDatabase(source);
  try {
    db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  } finally { db.close(); }
  // VACUUM INTO writes a DELETE-mode file. Seal the copy in WAL and
  // drop the empty sidecars before the manifest hashes it, so the
  // readonly integrity open (which requires WAL) matches the tarball
  // and no -wal/-shm file is archived.
  const copy = openDatabase(dest);
  try { copy.pragma("wal_checkpoint(TRUNCATE)"); }
  finally { copy.close(); }
  rmSync(dest + "-wal", { force: true });
  rmSync(dest + "-shm", { force: true });
}

// A failed backup ledgers before it rethrows (the turn-failed /
// tick-failed seam): success already writes its "backup" line, but a
// throw anywhere in the work below used to exist only on the CLI's
// stderr - on the box that is the systemd journal of the sam-backup
// oneshot, invisible to the owner console, the brief, and self-work.
// The summary carries the composed failure reason only (collapsed,
// capped by recordActivity), never a file's contents.
/** The reason a backup-failed line carries (census sprint
 * 2026-11-17): backupFailureSummary took error.message
 * alone, discarding error.cause, so a backup that died
 * behind a wrapper was countable but never diagnosable.
 * Now it composes through errorReason (the 04:04 bridge
 * seam): causeless errors keep their plain message, a
 * non-Error reads through String, bot-token segments are
 * redacted, and no file content ever enters the line. */
export function backupFailureReason(error: unknown): string {
  return errorReason(error);
}

export function backupFailureSummary(error: unknown): string {
  const reason = backupFailureReason(error).replace(/\s+/g, " ").trim();
  return "Backup failed: " + (reason || "unknown error");
}

export function recordBackupFailure(root: string, error: unknown): void {
  recordActivity(root, "sam", "backup-failed", backupFailureSummary(error).slice(0, 200));
}

export function createBackup(root: string, destDir: string, keep = 7): BackupInfo {
  const state = samDir(root);
  if (!existsSync(state)) throw new Error("No .sam state to back up at " + state);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("keep must be 1..365");
  // Validation above is a usage error the caller sees synchronously;
  // only a failure of the backup WORK ledgers (and rethrows exactly).
  try { return createBackupWork(root, destDir, keep); }
  catch (error) {
    try { recordBackupFailure(root, error); } catch { /* the ledger never breaks the work it records */ }
    throw error;
  }
}

function createBackupWork(root: string, destDir: string, keep: number): BackupInfo {
  const state = samDir(root);
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
    // Standing files (Phase A) are the one state kept in a subdirectory:
    // .sam/standing/<profile>/<file>.md rides along whole, or a restore
    // would silently strip every profile back to its bare paragraph.
    const standingSrc = join(state, "standing");
    if (existsSync(standingSrc) && statSync(standingSrc).isDirectory()) {
      cpSync(standingSrc, join(staging, "standing"), { recursive: true });
    }
    // The manifest walks recursively so subdirectory state (standing
    // files) is listed by its slash path, e.g. standing/dip/persona.md;
    // verify and restore resolve those names with join, on any platform.
    const walk = (dir: string, prefix: string): BackupFileEntry[] => {
      const out: BackupFileEntry[] = [];
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const rel = prefix ? prefix + "/" + name : name;
        if (statSync(path).isDirectory()) out.push(...walk(path, rel));
        else out.push({ name: rel, bytes: statSync(path).size, sha256: sha256File(path) });
      }
      return out;
    };
    const files: BackupFileEntry[] = walk(staging, "");
    const created = new Date();
    const manifest: BackupManifest = { format: 1, created_at: created.toISOString(), files, databases: databases.sort() };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const archive = "sam-state-" + stamp(created) + ".tar.gz";
    const archivePath = join(dest, archive);
    // Archive the staged files by name, never ".": Windows bsdtar refuses
    // to visit "." in a temp dir ("Couldn't visit directory: Permission
    // denied", owner-hit on Dip's PC 2026-11-09), and an explicit operand
    // list is deterministic on every platform's tar.
    execFileSync("tar", ["-czf", archivePath, "-C", staging, ...readdirSync(staging).sort(), "manifest.json"]);
    // Prune to the newest `keep` archives; names sort chronologically.
    const all = listBackups(dest);
    for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(old.path, { force: true });
    const info: BackupInfo = { archive, path: archivePath, bytes: statSync(archivePath).size, created_at: manifest.created_at };
    recordActivity(root, "sam", "backup", backupLedgerSummary(archive, files.length, databases.length, info.bytes));
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
      const db = openDatabase(path, { readonly: true });
      try {
        const row = db.pragma("integrity_check", { simple: true });
        if (row !== "ok") errors.push("integrity_check failed for " + name + ": " + String(row));
      } finally { db.close(); }
    } catch (e) { errors.push("cannot open database " + name + ": " + backupFailureReason(e)); }
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
      } catch (e) { report.ok = false; report.errors.push("drill could not boot the copy: " + backupFailureReason(e)); }
    } finally { rmSync(fakeRoot, { recursive: true, force: true }); }
    return report;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const BACKUP_DRILL_SCRIPT = "sam-backup-drill";

/** Where the newest backup lives, resolved the way installs
 *  actually lay it out: an explicit directory wins, then the
 *  SAM_BACKUP_DIR env name, then the CLI default
 *  (<workspace>/backups), then the sibling directory the
 *  box's systemd unit writes to (<workspace>/../backups for a
 *  workspace at /opt/sam/home). The candidate holding the
 *  newest archive (names sort chronologically) is the one
 *  the drill reads; when none holds an archive, the CLI
 *  default is returned so the no-archive report names the
 *  canonical place. */
export function backupDrillDest(root: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const candidates: string[] = [];
  const envDir = process.env.SAM_BACKUP_DIR;
  if (envDir) candidates.push(resolve(envDir));
  candidates.push(join(resolve(root), "backups"));
  candidates.push(join(resolve(root), "..", "backups"));
  let best: string | null = null;
  let bestNewest = "";
  for (const dir of candidates) {
    const newest = listBackups(dir).at(-1);
    if (newest && newest.archive > bestNewest) { best = dir; bestNewest = newest.archive; }
  }
  return best ?? join(resolve(root), "backups");
}

/** Run the restore drill over the NEWEST backup and ledger
 *  ONE backup-drill line carrying counts only (never the
 *  archive name, never any file content). Returns the drill
 *  report, or null when there is nothing to drill: no .sam
 *  state yet (a stateless install ledgers nothing, the
 *  createBackup usage-error precedent), or state with no
 *  archive yet (that absence IS ledgered once per run - a
 *  nightly backup that stopped landing is a fact the owner
 *  console should be able to count). */
export function runBackupDrill(root: string, explicitDest?: string): DrillReport | null {
  if (!existsSync(samDir(root))) return null;
  const dest = backupDrillDest(root, explicitDest);
  const newest = listBackups(dest).at(-1);
  if (!newest) {
    recordActivity(root, "sam", "backup-drill", "Restore drill recorded: no state backup archive found in " + dest);
    return null;
  }
  const report = runRestoreDrill(newest.path);
  recordActivity(root, "sam", "backup-drill", "Restore drill recorded: " + (report.ok ? "OK" : "FAILED") + ", " + String(report.files) + " files, " + String(report.databases.length) + " databases, boot counts " + String(report.chats) + " chats / " + String(report.missions) + " missions / " + String(report.memories) + " memories / " + String(report.preferences) + " preferences, " + String(report.errors.length) + " error(s)");
  return report;
}

/** The drill as plain text (the sam-backup-drill script
 *  job's stdout shape): the scorecard a person reads. It
 *  carries NO clock reading and NO archive name - the name
 *  embeds the backup's creation stamp, an ISO date fact P3
 *  fact diffing would read as changed news every night at
 *  an identical OK. Only the drill facts ride the text: the
 *  verdict, the manifest and integrity counts, the boot
 *  counts the drill exists to prove, and any error lines.
 *  The no-archive state is a stable two-line text, not an
 *  error (the answer-judge empty-state precedent). */
export function backupDrillText(report: DrillReport | null): string {
  if (!report) return ["Restore drill - no backup to drill", "No state backup archive exists yet, so there is nothing to verify or boot; the nightly backup must land first."].join("\n");
  const lines: string[] = ["Restore drill - " + (report.ok ? "OK (verified and booted)" : "FAILED")];
  lines.push("Newest state backup: " + String(report.files) + " files manifest-checked, " + String(report.databases.length) + " databases integrity-checked");
  lines.push("Boot counts: " + String(report.chats) + " chats, " + String(report.missions) + " missions, " + String(report.memories) + " memories, " + String(report.preferences) + " preferences");
  if (report.errors.length) {
    lines.push("", "Errors:");
    for (const e of report.errors) lines.push("- " + e);
  } else lines.push("", "Errors: none - the newest backup verifies against its manifest and boots as a working SAM state.");
  return lines.join("\n");
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
    recordActivity(root, "owner", "restore", restoreLedgerSummary(basename(archivePath), keptAside ? basename(keptAside) : null));
    return { restored: target, keptAside };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The ONE writers for the backup history's success and restore
// activity lines, so the scorecard's parsers below can never
// drift from the seams they count. Each shape is byte-identical
// to what the seams wrote inline before these writers existed.
// (The failure seam already rides its ONE writer,
// backupFailureSummary above.)
export function backupLedgerSummary(archive: string, fileCount: number, databaseCount: number, bytes: number): string {
  return "State backup " + archive + " (" + String(fileCount) + " files, " + String(databaseCount) + " databases, " + String(bytes) + " bytes)";
}

export function restoreLedgerSummary(archive: string, keptAside: string | null): string {
  return "Restored state from " + archive + (keptAside ? " (previous state kept at " + keptAside + ")" : "");
}

// The backup history scorecard (2026-11-19, the measured-proof
// series): the nightly backup's ledger classes (backup /
// backup-failed / restore) have ledgered in fixed shapes since
// P9 landed, but the classes were never folded, so how many
// backups have landed, whether any backup ever failed, whether
// a restore ever ran, and how the archive's shape grows were
// invisible in aggregate (the backup-drill scorecard proves
// only the NEWEST archive). Every backup and restore is an
// operator or scheduled act, so the verdict is attention only
// when a backup failed or a line is unparseable, else clear -
// a failed backup is the news. This text folds the three
// classes to counts only, on ONE line: backups / failed /
// restores, the latest parsed backup's files / databases /
// bytes, and the total. No stamp, no actor, no archive name,
// no failure reason, and no verbatim summary enters the text.
// A pure read: it creates nothing, verifies nothing, drills
// nothing, and restores nothing - the backup seams themselves
// are untouched.
export function parseBackupSummary(summary: string): { files: number; databases: number; bytes: number } | null {
  const m = /^State backup sam-state-\d{8}T\d{6}Z\.tar\.gz \((\d+) files, (\d+) databases, (\d+) bytes\)$/.exec(summary);
  if (!m) return null;
  return { files: Number(m[1]), databases: Number(m[2]), bytes: Number(m[3]) };
}

export function parseBackupFailedSummary(summary: string): Record<string, never> | null {
  if (!/^Backup failed: .+$/.test(summary)) return null;
  return {};
}

export function parseRestoreSummary(summary: string): Record<string, never> | null {
  if (!/^Restored state from sam-state-\d{8}T\d{6}Z\.tar\.gz( \(previous state kept at .+\))?$/.test(summary)) return null;
  return {};
}

export function backupHistoryScorecardText(root: string): string {
  const backupLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "backup" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "backup-failed" });
  const restoreLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "restore" });
  let backups = 0;
  let failed = 0;
  let restores = 0;
  let unparseable = 0;
  let latest: { files: number; databases: number; bytes: number } | null = null;
  for (const line of backupLines) {
    const parsed = parseBackupSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    backups += 1;
    latest = parsed;
  }
  for (const line of failedLines) {
    if (!parseBackupFailedSummary(line.summary)) { unparseable += 1; continue; }
    failed += 1;
  }
  for (const line of restoreLines) {
    if (!parseRestoreSummary(line.summary)) { unparseable += 1; continue; }
    restores += 1;
  }
  const total = backupLines.length + failedLines.length + restoreLines.length;
  const parts: string[] = [];
  parts.push("Backups: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(backups) + " backups");
  parts.push(String(failed) + " failed");
  parts.push(String(restores) + " restores");
  parts.push("latest " + String(latest?.files ?? 0) + " files / " + String(latest?.databases ?? 0) + " databases / " + String(latest?.bytes ?? 0) + " bytes");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

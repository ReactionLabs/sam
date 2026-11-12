import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { channels, setChannelOwners, type Channel } from "./channels.js";
import { recordActivity } from "./activity.js";

// Pairing-code channel auth (Plan Phase A item 3): how a person proves they
// belong on a channel's owner list without the operator hand-copying numeric
// IDs out of a candidate file. The operator issues a code on the CLI (shown
// once, only its sha256 is stored); the person sends it to the bot within the
// hour; redemption adds their sender id to the channel's ownerIds through the
// same setChannelOwners door the CLI has always used. Default-deny ordering
// is unchanged: owners are checked first, a pairing attempt second, and
// everyone else is still silently ignored (no oracle for strangers - the
// door-guard precedent). Failed attempts are counted per channel and trip a
// lockout, ledgered once per lockout like the door probes.
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1 - nothing confusable
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 3_600_000; // 1 hour (plan doc)
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 600_000; // 10 minutes
const LOCK_MS = 900_000; // 15 minutes
const MAX_CODE_RECORDS = 64;

interface PairingCodeRecord { id: string; channelId: string; codeHash: string; createdAt: string; expiresAt: string; usedBy?: number; usedAt?: string; retired?: boolean }
interface PairingGuard { failures: number[]; lockedUntil: string | null }
interface PairingStore { codes: PairingCodeRecord[]; guards: Record<string, PairingGuard> }

function storePath(root: string): string { return join(resolve(root), ".sam", "pairing.json"); }
function pairingDbFile(root: string): string { return join(resolve(root), ".sam", "pairing.db"); }
// State convergence (UNIFICATION item 4, eleventh store): the pairing
// store is SQLite (.sam/pairing.db, the actions/jobs pattern), one row
// per code holding the code's full JSON in rowid (issue) order plus one
// keyed row per channel guard. The old pairing.json was rewritten whole
// on every issue, every redeem attempt, and every lockout, and its
// writers are three processes (the Telegram bridge redeeming a
// stranger's attempt, the CLI issuing and redeeming on demand, and any
// dashboard-side redeem path), so two writers holding the same snapshot
// silently lost the second one's change - and here the losses are
// security-shaped: a failed attempt's count could revert and defeat
// the 5-failure lockout, a consumed code's used mark could revert and
// allow a replay, a freshly issued code could vanish under a redeem's
// save, and a lockout itself could be erased. Here each mutation is a
// single-row INSERT or UPDATE (issue's retire + insert + cap prune and
// a successful redeem's consume + guard clear each ride one
// transaction), and connections carry a busy_timeout (the F1
// cross-process lock seam) so a writer waits out a peer's transaction
// instead of dying on "database is locked". First open imports a
// legacy pairing.json (codes in order, guards by channel) and renames
// it pairing.json.migrated - imported, never deleted; a malformed file
// imports nothing and is left in place (the migrated shape reads it as
// an empty store instead of throwing, the channels precedent - the old
// reader threw, and pairingStatus rides the dashboard /api/status
// handler, so one torn write took the status payload down with it). A
// pure read on an install with neither file creates nothing, and a
// redeem refused as locked writes nothing. The P9 backup snapshots
// every .sam/*.db generically, so the migrated store is carried with
// no backup change.
function openPairingStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(pairingDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS pairing_codes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS pairing_guards (channelId TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyPairing(db, root);
  return db;
}
function migrateLegacyPairing(db: Database.Database, root: string): void {
  const codes = db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get() as { n: number };
  const guards = db.prepare("SELECT COUNT(*) AS n FROM pairing_guards").get() as { n: number };
  if (codes.n > 0 || guards.n > 0) return;
  const file = storePath(root);
  if (!existsSync(file)) return;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const store = value as PairingStore;
  if (!Array.isArray(store.codes) || typeof store.guards !== "object" || store.guards === null || Array.isArray(store.guards)) return;
  const insertCode = db.prepare("INSERT OR IGNORE INTO pairing_codes (id, data) VALUES (?, ?)");
  const insertGuard = db.prepare("INSERT OR IGNORE INTO pairing_guards (channelId, data) VALUES (?, ?)");
  const importAll = db.transaction((legacy: PairingStore) => {
    for (const raw of legacy.codes) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Partial<PairingCodeRecord>;
      if (typeof rec.id !== "string" || !rec.id) continue;
      insertCode.run(rec.id, JSON.stringify(rec));
    }
    for (const [channelId, guard] of Object.entries(legacy.guards)) {
      if (!guard || typeof guard !== "object") continue;
      insertGuard.run(channelId, JSON.stringify(guard));
    }
  });
  importAll(store);
  renameSync(file, file + ".migrated");
}
function storeExists(root: string): boolean {
  return existsSync(pairingDbFile(root)) || existsSync(storePath(root));
}
function rowToCode(data: string): PairingCodeRecord | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as PairingCodeRecord : null; }
  catch { return null; }
}
function rowToGuard(data: string): PairingGuard | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const guard = value as Partial<PairingGuard>;
    return { failures: Array.isArray(guard.failures) ? guard.failures.filter(t => typeof t === "number") : [], lockedUntil: typeof guard.lockedUntil === "string" ? guard.lockedUntil : null };
  } catch { return null; }
}
function readStore(db: Database.Database): PairingStore {
  const codes: PairingCodeRecord[] = [];
  const rows = db.prepare("SELECT data FROM pairing_codes ORDER BY rowid").all() as Array<{ data: string }>;
  for (const row of rows) { const rec = rowToCode(row.data); if (rec) codes.push(rec); }
  const guards: Record<string, PairingGuard> = {};
  const guardRows = db.prepare("SELECT channelId, data FROM pairing_guards").all() as Array<{ channelId: string; data: string }>;
  for (const row of guardRows) { const guard = rowToGuard(row.data); if (guard) guards[row.channelId] = guard; }
  return { codes, guards };
}
// The store's read door (the heartbeatState / episodeEvidence
// precedent): the full pairing snapshot read through the store's own
// shape. A pure read on an install with neither file creates nothing.
export function readPairingStore(root: string): PairingStore {
  if (!storeExists(root)) return { codes: [], guards: {} };
  const db = openPairingStore(root);
  try { return readStore(db); } finally { db.close(); }
}
function hashCode(normalized: string): string { return createHash("sha256").update("sam-pairing:" + normalized).digest("hex"); }
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Normalize a typed code: case-insensitive, dashes/spaces ignored. Returns
// null when the text is not code-shaped at all (an ordinary message).
export function normalizePairingCode(input: string): string | null {
  const flat = input.toUpperCase().replace(/[\s-]+/g, "");
  if (flat.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of flat) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return flat;
}
// Extract a pairing attempt from an incoming message: the whole message is
// the code, or an explicit "pair <code>" / "/pair <code>" command. Anything
// else is conversation, not an attempt, and must not burn the failure budget.
export function pairingAttemptCode(text: string): string | null {
  const trimmed = text.trim();
  const whole = normalizePairingCode(trimmed);
  if (whole) return whole;
  const m = /^\/?pair[:\s]+(\S+)$/i.exec(trimmed);
  return m ? normalizePairingCode(m[1]) : null;
}
export function formatPairingCode(normalized: string): string { return normalized.slice(0, 4) + "-" + normalized.slice(4); }

export function findChannel(root: string, idOrName: string): Channel {
  const found = channels(root).find(c => c.id === idOrName) ?? channels(root).find(c => c.name === idOrName);
  if (!found) throw Error("Channel not found: " + idOrName);
  return found;
}

// Issue a fresh code for a telegram channel. One live code per channel:
// issuing retires the previous unused code, so a re-issue is also the
// revoke. The plaintext is returned exactly once; only its hash is stored.
export function issuePairingCode(root: string, idOrName: string, now = Date.now()): { channel: string; profile: string; code: string; expiresAt: string } {
  const channel = findChannel(root, idOrName);
  if (channel.kind !== "telegram") throw Error("Pairing codes are for telegram channels (owner ids are telegram user ids)");
  if (!channel.enabled) throw Error("Channel is disabled: " + channel.name);
  let normalized = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) normalized += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  const rec: PairingCodeRecord = {
    id: randomUUID(), channelId: channel.id, codeHash: hashCode(normalized),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
  };
  const db = openPairingStore(root);
  try {
    const issue = db.transaction(() => {
      // Retire this channel's previous live codes, one row update each.
      const all = db.prepare("SELECT id, data FROM pairing_codes ORDER BY rowid").all() as Array<{ id: string; data: string }>;
      for (const row of all) {
        const existing = rowToCode(row.data);
        if (existing && existing.channelId === channel.id && !existing.usedAt && !existing.retired) {
          existing.retired = true;
          db.prepare("UPDATE pairing_codes SET data = ? WHERE id = ?").run(JSON.stringify(existing), existing.id);
        }
      }
      db.prepare("INSERT INTO pairing_codes (id, data) VALUES (?, ?)").run(rec.id, JSON.stringify(rec));
      // The 64-record cap, pruned oldest-first (the old slice(-64)).
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get() as { n: number };
      if (n > MAX_CODE_RECORDS) {
        db.prepare("DELETE FROM pairing_codes WHERE rowid IN (SELECT rowid FROM pairing_codes ORDER BY rowid ASC LIMIT ?)").run(n - MAX_CODE_RECORDS);
      }
    });
    issue();
  } finally { db.close(); }
  recordActivity(root, channel.profile, "pairing-issued", "Pairing code issued for channel " + channel.name + " (expires " + rec.expiresAt + ")");
  return { channel: channel.name, profile: channel.profile, code: formatPairingCode(normalized), expiresAt: rec.expiresAt };
}

export type RedeemResult =
  | { ok: true; channel: Channel }
  | { ok: false; reason: "locked" | "invalid" | "expired" | "used" | "retired" };

// Redeem a code for a sender id. Every non-locked failure (wrong, expired,
// used, retired) counts toward the channel's lockout; the lock check runs
// first and refuses even the correct code while it stands. On success the
// sender joins ownerIds, the code is consumed, and the failure count clears.
export function redeemPairingCode(root: string, channelId: string, rawCode: string, userId: number, now = Date.now()): RedeemResult {
  const channel = channels(root).find(c => c.id === channelId);
  if (!channel) throw Error("Channel not found: " + channelId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw Error("Invalid owner id");
  const db = openPairingStore(root);
  try {
    const guardRow = db.prepare("SELECT data FROM pairing_guards WHERE channelId = ?").get(channelId) as { data: string } | undefined;
    const guard: PairingGuard = (guardRow ? rowToGuard(guardRow.data) : null) ?? { failures: [], lockedUntil: null };
    if (guard.lockedUntil && now < Date.parse(guard.lockedUntil)) return { ok: false, reason: "locked" };
    if (guard.lockedUntil) { guard.lockedUntil = null; guard.failures = []; }
    const saveGuard = (next: PairingGuard) => {
      db.prepare("INSERT INTO pairing_guards (channelId, data) VALUES (?, ?) ON CONFLICT(channelId) DO UPDATE SET data = excluded.data")
        .run(channelId, JSON.stringify(next));
    };
    const fail = (reason: "invalid" | "expired" | "used" | "retired"): RedeemResult => {
      guard.failures = [...guard.failures.filter(t => now - t < FAILURE_WINDOW_MS), now];
      if (guard.failures.length >= MAX_FAILURES) {
        guard.lockedUntil = new Date(now + LOCK_MS).toISOString();
        guard.failures = [];
        saveGuard(guard);
        recordActivity(root, channel.profile, "pairing-lockout", "Pairing locked for channel " + channel.name + " until " + guard.lockedUntil + " after repeated failed attempts");
        return { ok: false, reason: "locked" };
      }
      saveGuard(guard);
      return { ok: false, reason };
    };
    const normalized = normalizePairingCode(rawCode);
    if (!normalized) return fail("invalid");
    const digest = hashCode(normalized);
    const rows = db.prepare("SELECT id, data FROM pairing_codes ORDER BY rowid").all() as Array<{ id: string; data: string }>;
    let rec: PairingCodeRecord | null = null;
    for (const row of rows) {
      const candidate = rowToCode(row.data);
      if (candidate && candidate.channelId === channelId && hashEquals(candidate.codeHash, digest)) { rec = candidate; break; }
    }
    if (!rec) return fail("invalid");
    if (rec.retired) return fail("retired");
    if (rec.usedAt) return fail("used");
    if (now >= Date.parse(rec.expiresAt)) return fail("expired");
    rec.usedBy = userId;
    rec.usedAt = new Date(now).toISOString();
    guard.failures = [];
    guard.lockedUntil = null;
    // Consume + clear in one transaction: neither half can revert alone.
    const consume = db.transaction(() => {
      db.prepare("UPDATE pairing_codes SET data = ? WHERE id = ?").run(JSON.stringify(rec), (rec as PairingCodeRecord).id);
      saveGuard(guard);
    });
    consume();
  } finally { db.close(); }
  const updated = setChannelOwners(root, channelId, [...channel.ownerIds, userId]);
  recordActivity(root, channel.profile, "pairing-redeemed", "Paired telegram user " + userId + " as an owner of channel " + channel.name);
  return { ok: true, channel: updated };
}

export interface PairingChannelStatus { channel: string; channelId: string; profile: string; owners: number; liveCode: boolean; codeExpiresAt: string | null; recentFailures: number; lockedUntil: string | null }
export function pairingStatus(root: string, now = Date.now()): PairingChannelStatus[] {
  const store: PairingStore = storeExists(root) ? readPairingStore(root) : { codes: [], guards: {} };
  return channels(root).filter(c => c.kind === "telegram").map(c => {
    const live = store.codes.find(r => r.channelId === c.id && !r.usedAt && !r.retired && now < Date.parse(r.expiresAt));
    const guard = store.guards[c.id];
    const lockedUntil = guard?.lockedUntil && now < Date.parse(guard.lockedUntil) ? guard.lockedUntil : null;
    return {
      channel: c.name, channelId: c.id, profile: c.profile, owners: c.ownerIds.length,
      liveCode: !!live, codeExpiresAt: live ? live.expiresAt : null,
      recentFailures: guard ? guard.failures.filter(t => now - t < FAILURE_WINDOW_MS).length : 0,
      lockedUntil,
    };
  });
}

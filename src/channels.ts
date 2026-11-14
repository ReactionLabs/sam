import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";

// Channels are how the outside world talks to SAM: a messaging surface (Telegram
// first) bound to one profile. Like connectors, a channel stores only an env
// reference for its credential, never the secret itself. Owner allowlisting is
// fail-closed: an empty owner list means nobody can talk yet. The registry
// lives in .sam/channels.db (UNIFICATION item 4, tenth store).
export type Channel = { id:string; kind:"telegram"|"webhook"|"discord"; name:string; profile:string; tokenEnv:string; ownerIds:number[]; enabled:boolean };
const namePattern = /^[A-Za-z0-9 _.-]{1,64}$/;
const profilePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const envPattern = /^SAM_CHANNEL_[A-Z0-9_]{1,64}$/;
function channelsFile(root: string): string { return join(resolve(root), ".sam", "channels.json"); }
function channelsDbFile(root: string): string { return join(resolve(root), ".sam", "channels.db"); }
// State convergence (UNIFICATION item 4, tenth store): the channel
// registry is SQLite (.sam/channels.db, the actions/jobs pattern),
// one row per channel holding the channel's full JSON, rowid order =
// the old file order. The old channels.json was rewritten whole on
// every add, remove, and setChannelOwners, and three processes write
// this store (the dashboard process through the config wizard, the
// Telegram bridge process through a pairing redemption's
// setChannelOwners, and the CLI on demand), so two writers holding
// the same snapshot silently lost the second one's change: a paired
// owner could vanish under a concurrent add, a removed channel
// could resurrect, and an owner the operator removed could be
// resurrected by a bridge-side snapshot save - ownerIds is the
// fail-closed allowlist every Telegram message is checked against.
// Here each mutation is a single-row INSERT, UPDATE, or DELETE, and
// connections carry a busy_timeout (the F1 cross-process lock seam)
// so a writer waits out a peer's transaction instead of dying on
// "database is locked". First open imports a legacy channels.json
// in file order and renames it channels.json.migrated - imported,
// never deleted; a malformed file imports nothing and is left in
// place (the migrated shape reads it as an empty, fail-closed
// registry instead of throwing, the heartbeat-state precedent -
// strictly safer for an allowlist store). A pure read on an install
// with neither file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with no
// backup change.
function openChannelsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(channelsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyChannels(db, root);
  return db;
}
function migrateLegacyChannels(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number };
  if (n > 0) return;
  const file = channelsFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO channels (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const channel = raw as Partial<Channel>;
      if (typeof channel.id !== "string" || !channel.id) continue;
      insert.run(channel.id, JSON.stringify(channel));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToChannel(data: string): Channel | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as Channel : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(channelsDbFile(root)) || existsSync(channelsFile(root));
}
// Failure visibility (gap found 2026-11-14, hourly run
// 13:04 EST): channels() is the one read door for the channel
// registry - the registry every outside surface rides. The
// Telegram bridge resolves its channel through it on every
// poll, pairing issue/redeem and bindings validation read it,
// heartbeat delivery finds its target channel through it, and
// the status payload, CLI, config detection, brief, and
// action validation all read it. Every touch was unguarded:
// a dead channels.db threw raw into whichever catch happened
// to wrap the call (the bridge's poll failure ledger with
// the channel seam unnamed, a raw dashboard/status death, a
// pairing redemption dying mid-flow), and no channel-failed
// kind existed, so the class was uncountable. Now the read
// doors own their touch (the links / dashboard-config
// precedent): a failed open/read ledgers ONE channel-failed
// line (phase read for channels(), phase lookup for
// getChannel(); actor sam; the verbatim reason collapsed and
// capped; never any channel record - names, profiles, and
// owner lists are routing data, not failure data), tags the
// error, and rethrows exactly, so every caller's handling is
// unchanged. An absent store still reads [] / null with no
// line and creates nothing, and torn row payloads still
// parse forgiving - only the store touch is guarded. The
// writers ride the same doors (addChannel reads through
// channels(), setChannelOwners and updateChannel through
// getChannel()), so a dead store fails a write at its read
// with the seam named instead of writing blind.
export type ChannelPhase = "read" | "lookup";

export function channelFailureSummary(phase: ChannelPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  if (phase === "lookup") return ("Channel lookup failed: " + clean).slice(0, 200);
  return ("Channel read failed: " + clean).slice(0, 200);
}

export function recordChannelFailure(root: string, phase: ChannelPhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "channel-failed", channelFailureSummary(phase, reason));
}

function tagChannelLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { channelLedgered?: boolean }).channelLedgered = true;
  }
}

export function isChannelLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { channelLedgered?: boolean }).channelLedgered === true;
}

function failChannel(root: string, phase: ChannelPhase, error: unknown): never {
  if (!isChannelLedgered(error)) recordChannelFailure(root, phase, error);
  tagChannelLedgered(error);
  throw error;
}

function readChannels(root: string, phase: ChannelPhase): Channel[] {
  if (!storeExists(root)) return [];
  let db: Database.Database;
  try { db = openChannelsStore(root); } catch (error) { failChannel(root, phase, error); }
  try {
    const rows = db!.prepare("SELECT data FROM channels ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Channel[] = [];
    for (const row of rows) { const channel = rowToChannel(row.data); if (channel) items.push(channel); }
    return items;
  } catch (error) { failChannel(root, phase, error); }
  finally { db!.close(); }
}

export function channels(root: string): Channel[] {
  return readChannels(root, "read");
}
export function getChannel(root: string, id: string): Channel | null {
  if (!storeExists(root)) return null;
  let db: Database.Database;
  try { db = openChannelsStore(root); } catch (error) { failChannel(root, "lookup", error); }
  try {
    const row = db!.prepare("SELECT data FROM channels WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToChannel(row.data) : null;
  } catch (error) { failChannel(root, "lookup", error); }
  finally { db!.close(); }
}
function insertChannelRow(root: string, item: Channel): void {
  const db = openChannelsStore(root);
  try { db.prepare("INSERT INTO channels (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  finally { db.close(); }
}
function updateChannelRow(root: string, item: Channel): void {
  const db = openChannelsStore(root);
  try { db.prepare("UPDATE channels SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  finally { db.close(); }
}
// The store's update door (the updateBackgroundTask precedent): patch
// one channel by id through the store's own shape. Returns the
// updated channel, or null when no such channel exists - and a miss
// on an install with no store at all creates nothing.
export function updateChannel(root: string, id: string, patch: Partial<Channel>): Channel | null {
  if (!storeExists(root)) return null;
  const current = getChannel(root, id);
  if (!current) return null;
  const next: Channel = { ...current, ...patch, id: current.id };
  updateChannelRow(root, next);
  return next;
}
export function addChannel(root: string, kind: Channel["kind"], name: string, profile: string, tokenEnv: string, ownerIds: number[] = []): Channel {
  if (kind !== "telegram" && kind !== "webhook" && kind !== "discord") throw Error("Invalid channel kind");
  if (!namePattern.test(name) || !profilePattern.test(profile) || !envPattern.test(tokenEnv)) throw Error("Invalid channel name, profile, or environment variable");
  if (!Array.isArray(ownerIds) || ownerIds.length > 64 || ownerIds.some(x => !Number.isSafeInteger(x) || x <= 0)) throw Error("Invalid owner list");
  const items = channels(root);
  if (items.length >= 16 || items.some(c => c.name === name)) throw Error("Channel limit or duplicate name");
  const item: Channel = { id: randomUUID(), kind, name, profile, tokenEnv, ownerIds: [...new Set(ownerIds)], enabled: true };
  insertChannelRow(root, item);
  return item;
}
export function removeChannel(root: string, id: string): boolean {
  if (!storeExists(root)) return false;
  const db = openChannelsStore(root);
  try {
    const result = db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return result.changes > 0;
  } finally { db.close(); }
}
export function setChannelOwners(root: string, id: string, ownerIds: number[]): Channel {
  if (!Array.isArray(ownerIds) || ownerIds.length > 64 || ownerIds.some(x => !Number.isSafeInteger(x) || x <= 0)) throw Error("Invalid owner list");
  const item = getChannel(root, id);
  if (!item) throw Error("Channel not found");
  item.ownerIds = [...new Set(ownerIds)];
  updateChannelRow(root, item);
  return item;
}

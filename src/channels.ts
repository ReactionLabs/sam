import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";
import { ChatStore } from "./chats.js";

// Channels are how the outside world talks to SAM: a messaging surface (Telegram
// first) bound to one profile. Like connectors, a channel stores only an env
// reference for its credential, never the secret itself. Owner allowlisting is
// fail-closed: an empty owner list means nobody can talk yet. The registry
// lives in .sam/channels.db (UNIFICATION item 4, tenth store).
export const channelKinds = ["telegram", "webhook", "discord"] as const;
export type ChannelKind = (typeof channelKinds)[number];
export type Channel = { id:string; kind:ChannelKind; name:string; profile:string; tokenEnv:string; ownerIds:number[]; enabled:boolean };
export function foldChannelKindName(value: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/** The ONE source for why a channel cannot be created
 *  with this kind: the kind is a registry name
 *  (channelKinds) that every channel creation names into
 *  addChannel - the ONE seam every kind rides (the CLI
 *  channels add / add-discord / add-webhook doors and
 *  the config wizard each name one) - and addChannel
 *  refused an unknown kind with the bare "Invalid
 *  channel kind": the bad value never echoed, none of
 *  the three kinds named, and no fold correction
 *  offered, so a folded name ("Telegram", "Web-Hook",
 *  "disc_ord") dead-ended even though the intended kind
 *  is unambiguous. An exact kind reads no blocker.
 *  Anything else is refused with the value echoed, the
 *  kinds named as the registry, the standing "Invalid
 *  channel kind" prefix kept (its readers match it),
 *  and, when exactly one kind matches the bad value
 *  folded for case and separators, that correction.
 *  addChannel throws this before any other validation
 *  or store write. Stored channel kinds stay permissive
 *  by design - a stored channel's kind is read back as
 *  stored and the runner doors never re-validate it.
 *  Null means the kind can be named. */
export function channelKindBlocker(value: unknown): string | null {
  if (typeof value === "string" && (channelKinds as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldChannelKindName(value) : "";
  const matches = target ? channelKinds.filter(k => foldChannelKindName(k) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Invalid channel kind \"" + String(value) + "\". Kinds: " + channelKinds.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
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

/**
 * The reason a channel-failed line carries (census sprint
 * 2026-11-17): recordChannelFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function channelFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordChannelFailure(root: string, phase: ChannelPhase, error: unknown): void {
  const reason = channelFailureReason(error);
  recordActivity(root, "sam", "channel-failed", channelFailureSummary(phase, reason));
}

// The channel failed history scorecard (2026-11-23, the
// measured-proof series): the channel registry's read doors
// ledger every failure as a "channel-failed" line through the
// ONE writer above (channelFailureSummary, fixed shapes
// "Channel read failed: <reason>" / "Channel lookup failed:
// <reason>", capped 200; phases read / lookup, ridden by
// recordChannelFailure from channels() and getChannel(), actor
// sam) - and while self-work's classifyDefect labels single
// lines and the bridge folds count the bridge's own kinds, no
// surface folds this kind, so a dead channels.db - the registry
// the Telegram bridge resolves through on every poll, pairing
// and bindings read, and heartbeat delivery finds its target
// through - could fail every touch with nothing counting the
// class in aggregate. Every failure line is by construction a
// registry touch that did not complete, so the verdict is
// attention when any failure was ever recorded or any line is
// unparseable, else clear. This parser is strict: only the two
// shapes the writer writes parse, and a non-empty reason is
// required and consumed, never printed - a reason can carry a
// store path or a redacted token segment and never surfaces
// here, and no channel record ever enters the fold. A line from
// any other kind never parses. A pure read: it creates nothing,
// updates nothing, and reads no channel record - the registry
// seams themselves are untouched.
export function parseChannelFailedSummary(summary: string): { phase: ChannelPhase } | null {
  const m = /^Channel (read|lookup) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[2] ?? "").trim()) return null;
  return { phase: m[1] as ChannelPhase };
}

export function channelFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "channel-failed" });
  let failed = 0;
  let unparseable = 0;
  let read = 0;
  let lookup = 0;
  for (const line of lines) {
    const parsed = parseChannelFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      if (parsed.phase === "read") read += 1;
      else lookup += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Channel failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(lookup) + " lookup");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
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
function normalizeChannelProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source for why a channel cannot be created for this
 *  profile: the name is not in the profile registry ("sam",
 *  the implicit core profile, plus every registered agent),
 *  so a channel created with it would be bound to nobody -
 *  resolveBindingProfile falls back to the channel's own
 *  profile as the default, the bridge and webhook doors
 *  ensure a chat under that name, and the turn resolves no
 *  registered profile, so the conversation runs unscoped
 *  (no instructions, no connector pin, no law of the person
 *  the channel was meant to serve) while reading as a
 *  working channel. Every other profile-naming creation
 *  door already validates the registry (channels bind,
 *  events bind, agents add-fallback, skills allow,
 *  heartbeats add / schedule); the channel creation doors
 *  (channels add / add-discord / add-webhook and the config
 *  wizard's channels section) throw this text before
 *  creating anything. The store itself stays permissive by
 *  design, exactly as for heartbeat jobs: a profile can be
 *  removed AFTER a channel names it, and the channel keeps
 *  resolving to its stored default - creation doors are
 *  where the check belongs. When exactly one registered
 *  profile matches the bad name folded for case and
 *  separators, the refusal names it ("Second Shift" ->
 *  "second-shift"). Null means the profile can be named. */
export function channelProfileBlocker(root: string, profile: string): string | null {
  const db = new ChatStore(root);
  let names: string[];
  try { names = ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; } finally { db.close(); }
  if (names.includes(profile)) return null;
  const target = normalizeChannelProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizeChannelProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in channel detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
export function normalizeChannelName(value: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/** The ONE source for why a channel door cannot name this
 *  channel: the value names no channel in the registry, so
 *  the door it rides (channels pair / redeem / bind /
 *  resolve, through findChannel in pairing.ts) dead-ended
 *  with the bare "Channel not found: X" - no registry, no
 *  correction - while every sibling naming door reads its
 *  registry through a ONE source. The heartbeat channel
 *  field reads this same registry through
 *  heartbeatChannelBlocker, but that text is
 *  heartbeat-detail-specific and cannot serve the channel
 *  doors themselves. A value reads no blocker when it
 *  names a registered channel by exact id OR by exact
 *  name. Anything else is refused with the channels listed
 *  as name (id) and, when exactly one registered name
 *  matches the bad value folded for case and separators,
 *  that correction ("dip telegram" -> "Dip Telegram").
 *  The "Channel not found" prefix is kept: existing
 *  readers match it. By-id internal lookups (setBinding,
 *  redeemPairingCode - the bridge carries the channel's
 *  own id) are not this door and stay as they are, and
 *  channels() / the store stay permissive by design.
 *  Null means the channel can be named. */
export function channelNameBlocker(root: string, idOrName: string): string | null {
  const known = channels(root);
  if (known.some(c => c.id === idOrName || c.name === idOrName)) return null;
  const target = normalizeChannelName(idOrName ?? "");
  const matches = target ? known.filter(c => normalizeChannelName(c.name) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Channel not found: \"" + idOrName + "\". Channels: " + (known.length ? known.map(c => c.name + " (" + c.id + ")").join(", ") : "none registered") + (fix ? ". Did you mean \"" + fix.name + "\" (" + fix.id + ")?" : "");
}
/** The ONE source for why a channel RUNNER door cannot pick
 *  its channel: the telegram bridge, the discord poster, and
 *  the webhook server each resolved their channel through
 *  their own inline find filtered by kind + enabled and
 *  refused a miss with a generic line ("No enabled telegram
 *  channel configured" / "No enabled discord channel with
 *  that name") naming no registry, offering no fold
 *  correction, and unable to distinguish an unknown name
 *  from a disabled channel or a channel of another kind.
 *  A pick reads no blocker when an ENABLED channel of the
 *  kind matches the name exactly, or, when no name is
 *  given, when any enabled channel of the kind exists (the
 *  bridge's standing first-enabled default). Anything else
 *  is refused with the channels OF THAT KIND listed as
 *  name (id, enabled/disabled) and, when exactly one of
 *  them matches the bad name folded for case and
 *  separators, that correction. channels() and the store
 *  stay permissive by design. Null means the pick works. */
export function channelRunnerBlocker(root: string, kind: Channel["kind"], name?: string): string | null {
  const ofKind = channels(root).filter(c => c.kind === kind);
  const enabled = ofKind.filter(c => c.enabled);
  if (name === undefined ? enabled.length > 0 : enabled.some(c => c.name === name)) return null;
  const listed = ofKind.length ? ofKind.map(c => c.name + " (" + c.id + ", " + (c.enabled ? "enabled" : "disabled") + ")").join(", ") : "none registered";
  const target = name ? normalizeChannelName(name) : "";
  const matches = target ? ofKind.filter(c => normalizeChannelName(c.name) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  const head = name === undefined ? "No enabled " + kind + " channel configured." : "No enabled " + kind + " channel: \"" + name + "\".";
  return head + " " + kind[0].toUpperCase() + kind.slice(1) + " channels: " + listed + (fix ? ". Did you mean \"" + fix.name + "\" (" + fix.id + ", " + (fix.enabled ? "enabled" : "disabled") + ")?" : "");
}
/** Resolve the channel a runner door runs on, or throw the
 *  ONE source's refusal before anything starts: the named
 *  enabled channel of the kind, or the first enabled one
 *  when no name is given. */
export function runnerChannel(root: string, kind: Channel["kind"], name?: string): Channel {
  const blocker = channelRunnerBlocker(root, kind, name);
  if (blocker) throw Error(blocker);
  const enabled = channels(root).filter(c => c.kind === kind && c.enabled);
  return (name === undefined ? enabled[0] : enabled.find(c => c.name === name))!;
}
export function addChannel(root: string, kind: Channel["kind"], name: string, profile: string, tokenEnv: string, ownerIds: number[] = []): Channel {
  const kindBlocker = channelKindBlocker(kind);
  if (kindBlocker) throw Error(kindBlocker);
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

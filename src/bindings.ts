import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { channels, type Channel } from "./channels.js";
import { recordActivity } from "./activity.js";

// Deterministic bindings (Plan Phase C item 3): which profile an incoming
// channel message lands on is a routing decision, and routing is never the
// model's call. A binding maps (channel, peer) -> profile, where peer is
// the sender's id on that channel as a string (a Telegram user id, a
// webhook caller name). Resolution is most-specific-wins, the OpenClaw
// routing discipline the plan adopted:
//   1. a binding for this channel AND this peer
//   2. a binding for this channel with no peer (channel-wide)
//   3. the channel's own profile (the pre-bindings behavior, unchanged)
// Bindings are operator-set records in .sam/bindings.db; a profile the
// registry no longer knows is refused at write time by the CLI, and a
// binding whose channel disappears resolves to nothing (the caller falls
// back to the channel it already holds).
export interface Binding { id: string; channelId: string; peer: string | null; profile: string; createdAt: string }
export interface BindingResolution { profile: string; via: "peer" | "channel" | "default"; binding: Binding | null }

const profilePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_BINDINGS = 64;
function storePath(root: string): string { return join(resolve(root), ".sam", "bindings.json"); }
function bindingsDbFile(root: string): string { return join(resolve(root), ".sam", "bindings.db"); }
// State convergence (UNIFICATION item 4, seventeenth store): the bindings
// registry is SQLite (.sam/bindings.db, the contacts pattern), one row per
// binding keyed by its id holding the binding's full JSON, rowid order =
// the old file order. The old bindings.json was rewritten whole on every
// set and every remove, and its writers (the CLI) ran beside
// resolveBindingProfile readers on every incoming Telegram and webhook
// message and listBindings readers in the dashboard status build, so two
// writers holding the same snapshot silently lost the second one's
// change - routing-shaped here: a binding that sends a person to their
// own scoped SAM could vanish or revert under a concurrent save and that
// person's messages land on the channel's default profile instead. Here
// each mutation is a single-row INSERT, UPDATE, or DELETE, and
// connections carry a busy_timeout so a writer waits out a peer's
// transaction instead of dying on "database is locked". First open
// imports a legacy bindings.json in file order and renames it
// bindings.json.migrated - imported, never deleted; a malformed file, a
// non-array payload, or an over-cap payload imports nothing and is left
// in place (the migrated shape reads it as no bindings instead of
// throwing "Invalid bindings store", the channels/minis precedent -
// strictly more forgiving for a registry the console and the bridges
// read on every message, and the resolver's routing outcome is unchanged
// because it already fell back to the channel default on a throw). A
// pure read on an install with neither file creates nothing. The P9
// backup snapshots every .sam/*.db generically, so the migrated store
// is carried with no backup change.
function openBindingsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(bindingsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyBindings(db, root);
  return db;
}
function migrateLegacyBindings(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM bindings").get() as { n: number };
  if (n > 0) return;
  const file = storePath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data) || data.length > MAX_BINDINGS) return;
  const insert = db.prepare("INSERT OR IGNORE INTO bindings (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const binding = raw as Partial<Binding>;
      if (typeof binding.id !== "string" || !binding.id) continue;
      insert.run(binding.id, JSON.stringify(binding));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToBinding(data: string): Binding | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as Binding : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(bindingsDbFile(root)) || existsSync(storePath(root));
}
// Binding failure visibility (hourly run 2026-11-14): the
// routing seam was silent in both directions. The direct
// readers (status, the CLI bindings view) rode listBindings
// bare, so a dead bindings.db threw raw out of the whole
// status payload / CLI view with no line anywhere; and
// resolveBindingProfile swallowed the same throw and
// returned the channel's default profile - the designed
// answer for NO binding - so a person bound to their own
// scoped SAM silently landed on the default profile, a
// routing / scoping failure dressed as an ordinary unbound
// message on every Telegram and webhook message. Now
// listBindings owns its touch: a failed open/read ledgers
// ONE binding-failed line and rethrows exactly (fail-closed
// for direct readers), the error is tagged (the worthiness /
// session-caps precedent) so a catching resolver records
// nothing more for the same touch, and the line's shape
// follows the caller - a direct reader's line is the generic
// system shape (actor sam, "Binding read failed"), while the
// resolver passes its channel as context and its line keeps
// the resolve shape (actor the channel's default profile,
// the channel named). Never any binding record (channel /
// peer / profile mappings are routing data, not failure
// data). An absent store still reads [] and ledgers nothing.
export type BindingPhase = "read" | "resolve";

export function bindingFailureSummary(phase: BindingPhase, reason: string, channelName?: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  if (phase === "resolve") return ("Binding resolve failed for channel " + (channelName ?? "unknown") + ": " + clean).slice(0, 200);
  return ("Binding read failed: " + clean).slice(0, 200);
}

export function recordBindingReadFailure(root: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "binding-failed", bindingFailureSummary("read", reason));
}

export function recordBindingResolveFailure(root: string, channel: Channel, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, channel.profile, "binding-failed", bindingFailureSummary("resolve", reason, channel.name));
}

function tagBindingLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { bindingLedgered?: boolean }).bindingLedgered = true;
  }
}

export function isBindingLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { bindingLedgered?: boolean }).bindingLedgered === true;
}

export function listBindings(root: string, ctx?: { channel: Channel }): Binding[] {
  if (!storeExists(root)) return [];
  let db: Database.Database;
  try {
    db = openBindingsStore(root);
  } catch (error) {
    if (ctx) recordBindingResolveFailure(root, ctx.channel, error);
    else recordBindingReadFailure(root, error);
    tagBindingLedgered(error);
    throw error;
  }
  try {
    const rows = db.prepare("SELECT data FROM bindings ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Binding[] = [];
    for (const row of rows) { const binding = rowToBinding(row.data); if (binding) items.push(binding); }
    return items;
  } catch (error) {
    if (ctx) recordBindingResolveFailure(root, ctx.channel, error);
    else recordBindingReadFailure(root, error);
    tagBindingLedgered(error);
    throw error;
  } finally { db.close(); }
}
function findBindingRow(root: string, id: string): Binding | null {
  if (!storeExists(root)) return null;
  const db = openBindingsStore(root);
  try {
    const row = db.prepare("SELECT data FROM bindings WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToBinding(row.data) : null;
  } finally { db.close(); }
}
function findPairRow(root: string, channelId: string, peer: string | null): Binding | null {
  if (!storeExists(root)) return null;
  const db = openBindingsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM bindings ORDER BY rowid").all() as Array<{ data: string }>;
    for (const row of rows) { const binding = rowToBinding(row.data); if (binding && binding.channelId === channelId && binding.peer === peer) return binding; }
    return null;
  } finally { db.close(); }
}
function countBindings(root: string): number {
  if (!storeExists(root)) return 0;
  const db = openBindingsStore(root);
  try {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM bindings").get() as { n: number };
    return n;
  } finally { db.close(); }
}
function insertBindingRow(root: string, item: Binding): void {
  const db = openBindingsStore(root);
  try { db.prepare("INSERT INTO bindings (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  finally { db.close(); }
}
function updateBindingRow(root: string, item: Binding): void {
  const db = openBindingsStore(root);
  try { db.prepare("UPDATE bindings SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  finally { db.close(); }
}
export function validPeer(peer: string): string {
  const trimmed = peer.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw Error("Invalid peer: give the sender id as it appears on the channel (1-128 printable characters)");
  return trimmed;
}
// One binding per (channel, peer): setting the same pair again moves it to
// the new profile instead of stacking a second rule the resolver would
// have to arbitrate. peer null is the channel-wide rule.
export function setBinding(root: string, input: { channelId: string; peer: string | null; profile: string }): Binding {
  const channel = channels(root).find(c => c.id === input.channelId);
  if (!channel) throw Error("Channel not found: " + input.channelId);
  if (!profilePattern.test(input.profile)) throw Error("Invalid profile: " + input.profile);
  const peer = input.peer === null ? null : validPeer(input.peer);
  const existing = findPairRow(root, channel.id, peer);
  if (existing) {
    const moved: Binding = { ...existing, profile: input.profile };
    updateBindingRow(root, moved);
    recordActivity(root, input.profile, "binding-set", "Binding updated: channel " + channel.name + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + input.profile);
    return moved;
  }
  if (countBindings(root) >= MAX_BINDINGS) throw Error("Binding limit reached (" + MAX_BINDINGS + ")");
  const item: Binding = { id: randomUUID(), channelId: channel.id, peer, profile: input.profile, createdAt: new Date().toISOString() };
  insertBindingRow(root, item);
  recordActivity(root, input.profile, "binding-set", "Binding set: channel " + channel.name + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + input.profile);
  return item;
}
// The store's update door (the contacts precedent): patch one binding by
// id through the store's own shape. The id never changes; a peer patch is
// validated exactly as setBinding validates it. Returns the updated
// binding, or null when no such binding exists - and a miss on an install
// with no store at all creates nothing.
export function updateBinding(root: string, id: string, patch: Partial<Binding>): Binding | null {
  if (!storeExists(root)) return null;
  const current = findBindingRow(root, id);
  if (!current) return null;
  const next: Binding = { ...current, ...patch, id: current.id };
  if (patch.profile !== undefined && !profilePattern.test(next.profile)) throw Error("Invalid profile: " + next.profile);
  if (patch.peer !== undefined && next.peer !== null) next.peer = validPeer(next.peer);
  updateBindingRow(root, next);
  return next;
}
export function removeBinding(root: string, id: string): boolean {
  if (!storeExists(root)) return false;
  const gone = findBindingRow(root, id);
  if (!gone) return false;
  const db = openBindingsStore(root);
  try {
    const result = db.prepare("DELETE FROM bindings WHERE id = ?").run(id);
    if (result.changes === 0) return false;
  } finally { db.close(); }
  recordActivity(root, gone.profile, "binding-removed", "Binding removed: channel " + gone.channelId + (gone.peer ? ", peer " + gone.peer : " (all peers)") + " -> profile " + gone.profile);
  return true;
}
// The one resolver every channel surface rides. peer may be a number
// (Telegram ids are numeric) or a string; it is compared in its trimmed
// string form, exactly as setBinding stored it.
export function resolveBindingProfile(root: string, channel: Channel, peer?: string | number | null): BindingResolution {
  let items: Binding[];
  // Routing never breaks a message: a failed read still
  // resolves to the channel default exactly as before, but
  // the reader ledgers ONE binding-failed resolve line for
  // the touch (tagged, so this catch records nothing more),
  // and the fallback is countable instead of
  // indistinguishable from no binding existing.
  try { items = listBindings(root, { channel }); } catch (error) {
    if (!isBindingLedgered(error)) recordBindingResolveFailure(root, channel, error);
    return { profile: channel.profile, via: "default", binding: null };
  }
  const mine = items.filter(b => b.channelId === channel.id);
  if (peer !== undefined && peer !== null && String(peer).trim() !== "") {
    const peerBinding = mine.find(b => b.peer === String(peer).trim());
    if (peerBinding) return { profile: peerBinding.profile, via: "peer", binding: peerBinding };
  }
  const channelBinding = mine.find(b => b.peer === null);
  if (channelBinding) return { profile: channelBinding.profile, via: "channel", binding: channelBinding };
  return { profile: channel.profile, via: "default", binding: null };
}

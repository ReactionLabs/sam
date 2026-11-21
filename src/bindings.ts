import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { channels, type Channel } from "./channels.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

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

/**
 * The reason a binding-failed line carries (census sprint
 * 2026-11-17): recordBindingReadFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function bindingFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordBindingReadFailure(root: string, error: unknown): void {
  const reason = bindingFailureReason(error);
  recordActivity(root, "sam", "binding-failed", bindingFailureSummary("read", reason));
}

export function recordBindingResolveFailure(root: string, channel: Channel, error: unknown): void {
  const reason = bindingFailureReason(error);
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
    recordActivity(root, input.profile, "binding-set", bindingSetLedgerSummary(true, channel.name, peer, input.profile));
    return moved;
  }
  if (countBindings(root) >= MAX_BINDINGS) throw Error("Binding limit reached (" + MAX_BINDINGS + ")");
  const item: Binding = { id: randomUUID(), channelId: channel.id, peer, profile: input.profile, createdAt: new Date().toISOString() };
  insertBindingRow(root, item);
  recordActivity(root, input.profile, "binding-set", bindingSetLedgerSummary(false, channel.name, peer, input.profile));
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
  recordActivity(root, gone.profile, "binding-removed", bindingRemovedLedgerSummary(gone.channelId, gone.peer, gone.profile));
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

// The ONE writers for the binding lifecycle's set-side activity
// lines, so the history scorecard's parsers below can never drift
// from the seams they count. The shapes are byte-identical to what
// setBinding and removeBinding wrote inline before these writers
// existed. (The binding-failed line already rides its ONE writer,
// bindingFailureSummary above.)
export function bindingSetLedgerSummary(updated: boolean, channelName: string, peer: string | null, profile: string): string {
  return "Binding " + (updated ? "updated" : "set") + ": channel " + channelName + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + profile;
}
export function bindingRemovedLedgerSummary(channelId: string, peer: string | null, profile: string): string {
  return "Binding removed: channel " + channelId + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + profile;
}

// The binding history scorecard (2026-11-21, the measured-proof
// series): every binding lifecycle event has ledgered as a
// binding-set / binding-removed / binding-failed line since
// deterministic bindings landed (Phase C item 3) - the set and
// removed lines as inline concatenation with no ONE writer until
// now, and with no fold, so how many bindings were ever set,
// moved, or removed, across how many channels and profiles, and
// whether a binding resolve ever failed, was invisible in
// aggregate (listBindings reads only the current store - a
// binding that was set, moved, and removed leaves no surface
// remembering it happened). A resolve failure is the signal of
// the family - a person bound to their own scoped SAM silently
// landing on the channel's default profile, a routing / scoping
// failure dressed as an ordinary unbound message - so the
// verdict is attention only when any binding-failed was ever
// recorded or a line is unparseable, else clear. This text folds
// the three classes to counts only, on ONE line: the set,
// updated, and removed counts, the failed count with its read /
// resolve split, the distinct-channel and distinct-profile
// counts as numbers only, and the total. No stamp, no actor, no
// channel name or id, no peer id, no profile name, no reason,
// and no verbatim summary enters the text - the summaries carry
// channel names, peer sender ids, and failure reasons, which the
// fold consumes and never prints. One shape note the fold
// honors: a removed line names its channel by ID, not by name
// (the remove seam holds the stored record, not the channel), so
// the distinct-channel count is taken from the name-carrying
// lines only (set, updated, resolve-failed) and the removed
// line's id token never enters it; the distinct-profile count
// rides every parsed line, removed included, because every shape
// names its profile the same way. The parsers validate each
// line's profile against the registry's own profile pattern, so
// a line whose shape drifted counts as unparseable rather than
// surfacing as free text. A pure read: it creates nothing, sets
// nothing, removes nothing, and resolves nothing - the binding
// seams themselves are untouched beyond riding their ONE
// writers.
function parseBindingRouteSegment(segment: string): { channel: string; peer: string | null } | null {
  if (segment.endsWith(" (all peers)")) {
    const channel = segment.slice(0, -" (all peers)".length);
    if (!channel.trim()) return null;
    return { channel, peer: null };
  }
  const idx = segment.lastIndexOf(", peer ");
  if (idx < 0) return null;
  const channel = segment.slice(0, idx);
  const peer = segment.slice(idx + ", peer ".length);
  if (!channel.trim() || !peer.trim()) return null;
  return { channel, peer };
}
export function parseBindingSetSummary(summary: string): { action: "set" | "updated"; channel: string; peer: string | null; profile: string } | null {
  const m = /^Binding (set|updated): channel (.+) -> profile (\S+)$/.exec(summary);
  if (!m) return null;
  if (!profilePattern.test(m[3])) return null;
  const route = parseBindingRouteSegment(m[2]);
  if (!route) return null;
  return { action: m[1] as "set" | "updated", channel: route.channel, peer: route.peer, profile: m[3] };
}
export function parseBindingRemovedSummary(summary: string): { channel: string; peer: string | null; profile: string } | null {
  const m = /^Binding removed: channel (.+) -> profile (\S+)$/.exec(summary);
  if (!m) return null;
  if (!profilePattern.test(m[2])) return null;
  const route = parseBindingRouteSegment(m[1]);
  if (!route) return null;
  return { channel: route.channel, peer: route.peer, profile: m[2] };
}
export function parseBindingFailedSummary(summary: string): { phase: BindingPhase; channel: string | null } | null {
  const read = /^Binding read failed: (.+)$/.exec(summary);
  if (read) {
    if (!read[1].trim()) return null;
    return { phase: "read", channel: null };
  }
  const resolve = /^Binding resolve failed for channel (.+?): (.+)$/.exec(summary);
  if (resolve) {
    if (!resolve[1].trim() || !resolve[2].trim()) return null;
    return { phase: "resolve", channel: resolve[1] };
  }
  return null;
}
export function bindingHistoryScorecardText(root: string): string {
  const setLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "binding-set" });
  const removedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "binding-removed" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "binding-failed" });
  let set = 0;
  let updated = 0;
  let removed = 0;
  let failed = 0;
  let reads = 0;
  let resolves = 0;
  let unparseable = 0;
  const channelNames = new Set<string>();
  const profileNames = new Set<string>();
  for (const line of setLines) {
    const parsed = parseBindingSetSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.action === "set") set += 1; else updated += 1;
    channelNames.add(parsed.channel);
    profileNames.add(parsed.profile);
  }
  for (const line of removedLines) {
    const parsed = parseBindingRemovedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    removed += 1;
    profileNames.add(parsed.profile);
  }
  for (const line of failedLines) {
    const parsed = parseBindingFailedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    failed += 1;
    if (parsed.phase === "read") reads += 1;
    else { resolves += 1; if (parsed.channel) channelNames.add(parsed.channel); }
  }
  const total = setLines.length + removedLines.length + failedLines.length;
  const parts: string[] = [];
  parts.push("Binding history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(set) + " set");
  parts.push(String(updated) + " updated");
  parts.push(String(removed) + " removed");
  parts.push(String(failed) + " failed");
  parts.push(String(reads) + " read");
  parts.push(String(resolves) + " resolve");
  parts.push(String(channelNames.size) + " distinct channels");
  parts.push(String(profileNames.size) + " distinct profiles");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

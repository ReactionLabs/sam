import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { MemoryStore, type MemoryRecord } from "./memory.js";
import { activeSuppressions, needleMatches, recordSuppressionBlock, MemorySuppressedError, type CaptureSuppression } from "./capture-guard.js";
import { recordActivity } from "./activity.js";

// Episodic memory (program P4): a dated summary record per profile of what
// happened in its chats that day, so SAM answers from a lived history, not
// just tools. Heartbeat consolidation writes these from the messages it
// already scans; there is no model call and no second memory system - an
// episode is an ordinary MemoryStore record in missions.db, scoped exactly
// like an owner-approved note (core for sam, profile:<name> otherwise), so
// sam_memory_search / sam_memory_list reach it under the same visibleScopes
// fence as everything else and one profile's day never leaks into another's.
//
// Consolidation is incremental (it only sees messages past its watermark),
// so the day's evidence accumulates in .sam/episodes.db and the summary is
// regenerated from the full day every tick: one live record per profile per
// date, the earlier version archived, so a day reads as one story, not
// fragments. An episode is a derived summary, never a fact source about
// people: it only restates what was said in that profile's own chats, with
// provenance (episode:<profile>:<date>) stamped on the record. Facts about
// people still enter only via P1 owner-approved notes.
export interface EpisodeMessage { role: string; content: string; created_at: string }
export interface EpisodeChat { chatId: string; title: string; messages: EpisodeMessage[] }

export function episodeScope(profile: string): string {
  return profile === "sam" ? "core" : "profile:" + profile;
}
export function episodeSource(profile: string, date: string): string {
  return "episode:" + profile + ":" + date;
}
function validProfile(profile: string): boolean {
  return profile === "sam" || /^[a-z][a-z0-9._-]{0,63}$/.test(profile);
}
function excerpt(text: string, cap = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > cap ? clean.slice(0, cap - 1) + "…" : clean;
}

// Deterministic summary: counts plus the owner's own words (their excerpts
// are the substance of the day) and SAM's last reply per chat. Same input,
// same text - a re-consolidation of the same messages changes nothing.
export function summarizeEpisode(profile: string, date: string, chats: EpisodeChat[]): string {
  const live = chats.filter(c => c.messages.length);
  const total = live.reduce((n, c) => n + c.messages.length, 0);
  const owner = live.reduce((n, c) => n + c.messages.filter(m => m.role === "user").length, 0);
  const lines: string[] = [
    "Episode " + date + " · profile " + profile + " · " + live.length + (live.length === 1 ? " chat" : " chats") +
    " · " + total + (total === 1 ? " message" : " messages") + " (owner " + owner + ", SAM " + (total - owner) + ")",
  ];
  for (const chat of live) {
    const parts: string[] = [];
    const ownerMsgs = chat.messages.filter(m => m.role === "user").slice(0, 3);
    for (const m of ownerMsgs) parts.push('owner: "' + excerpt(m.content) + '"');
    const replies = chat.messages.filter(m => m.role !== "user");
    if (replies.length) parts.push("SAM replied " + replies.length + (replies.length === 1 ? " time" : " times") + ', last: "' + excerpt(replies[replies.length - 1].content) + '"');
    lines.push('- "' + excerpt(chat.title, 80) + '" [' + chat.chatId.slice(0, 8) + "]: " + parts.join(" | "));
  }
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3999) + "…" : text;
}

// Evidence store: profile:date -> the day's chats with bounded excerpts.
// Bounded on every axis (dates per profile, chats per day, messages per
// chat, excerpt length) so the store can never grow without limit.
//
// State convergence (UNIFICATION item 4, fifth store): the evidence is
// SQLite (.sam/episodes.db, the actions/jobs pattern), one keyed row per
// profile:date holding that day's chats JSON. The old episodes.json was
// rewritten whole on every writeEpisode - at 73KB live it was the largest
// remaining JSON store - and its writers overlap the heartbeat-state way:
// the systemd timer's tick and a manual CLI tick are separate processes,
// and two ticks holding the same snapshot lost the second one's evidence
// permanently (its messages were already watermarked as consolidated, so
// they never re-entered the day's episode). A malformed file threw out of
// loadEvidence and killed the tick outright. Here each write upserts
// exactly the one row it merges, plus the bounded prune of that profile's
// oldest dates, in one transaction, and connections carry a busy_timeout
// (the F1 cross-process lock seam). First open imports a legacy
// episodes.json key by key and renames it episodes.json.migrated -
// imported, never deleted; a malformed file imports nothing and is left
// in place. A pure read on an install with neither file creates nothing.
// The P9 backup snapshots every .sam/*.db generically, so the migrated
// store is carried with no backup change.
function evidenceFile(root: string) { return join(resolve(root), ".sam", "episodes.json"); }
function evidenceDbFile(root: string) { return join(resolve(root), ".sam", "episodes.db"); }
function openEvidenceStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(evidenceDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS episode_evidence (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyEvidence(db, root);
  return db;
}
function migrateLegacyEvidence(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM episode_evidence").get() as { n: number };
  if (n > 0) return;
  const file = evidenceFile(root);
  if (!existsSync(file)) return;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO episode_evidence (key, data) VALUES (?, ?)");
  const importAll = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [key, chats] of entries) {
      if (!Array.isArray(chats)) continue;
      insert.run(key, JSON.stringify(chats));
    }
  });
  importAll(Object.entries(value as Record<string, unknown>));
  renameSync(file, file + ".migrated");
}
function rowToChats(data: string): EpisodeChat[] {
  try { const value: unknown = JSON.parse(data); return Array.isArray(value) ? value as EpisodeChat[] : []; }
  catch { return []; }
}
// The store's read door (the heartbeatState precedent): one profile:date's
// accumulated evidence, or [] when none exists. A read on an install with
// neither store creates nothing.
export function episodeEvidence(root: string, profile: string, date: string): EpisodeChat[] {
  if (!validProfile(profile)) throw new Error("Invalid profile");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid episode date");
  if (!existsSync(evidenceDbFile(root)) && !existsSync(evidenceFile(root))) return [];
  const db = openEvidenceStore(root);
  try {
    const row = db.prepare("SELECT data FROM episode_evidence WHERE key = ?").get(profile + ":" + date) as { data: string } | undefined;
    return row ? rowToChats(row.data) : [];
  } finally { db.close(); }
}
function mergeEvidenceChats(existing: EpisodeChat[], chats: EpisodeChat[]): EpisodeChat[] {
  const byId = new Map<string, EpisodeChat>(existing.map(c => [c.chatId, c]));
  for (const chat of chats) {
    const prior = byId.get(chat.chatId) ?? { chatId: chat.chatId, title: chat.title, messages: [] };
    prior.title = chat.title;
    const seen = new Set(prior.messages.map(m => m.created_at + "\n" + m.role + "\n" + m.content));
    for (const m of chat.messages) {
      const stored = { role: m.role, content: excerpt(m.content, 200), created_at: m.created_at };
      const k = stored.created_at + "\n" + stored.role + "\n" + stored.content;
      if (!seen.has(k)) { prior.messages.push(stored); seen.add(k); }
    }
    prior.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    prior.messages = prior.messages.slice(-100);
    byId.set(chat.chatId, prior);
  }
  return [...byId.values()].slice(0, 50);
}

// One ledger line per corrupt evidence row met on the write
// path (record-honesty gap, Program H audit): rowToChats folds a
// parse failure to [] by design for the read door, but on the
// WRITE path that fold was silent data loss - the merge rebuilt
// the row from nothing and overwrote it, and the day's earlier
// evidence vanished with no trace anywhere. The write now
// detects the corrupt row itself and ledgers ONE episodes-failed
// line (the key and the phase, never any content) before
// rebuilding the row from the day's new messages.
export function episodesFailureSummary(phase: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Episodes evidence " + phase + " failed: " + clean).slice(0, 200);
}
export function recordEpisodesFailure(root: string, actor: string, phase: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, actor, "episodes-failed", episodesFailureSummary(phase, reason));
}

export function writeEpisode(root: string, profile: string, date: string, chats: EpisodeChat[]): MemoryRecord | null {
  if (!validProfile(profile)) throw new Error("Invalid profile");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid episode date");
  if (!chats.some(c => c.messages.length)) return null;
  const key = profile + ":" + date;
  let merged: EpisodeChat[] = [];
  let evidenceCorrupt = false;
  // The capture guard (Program H item A): a standing do-not-store
  // instruction filters this profile's messages BEFORE anything
  // is kept - the input filter keeps suppressed words out of the
  // evidence row in the first place, and filtering the merged
  // result scrubs excerpts an earlier, unguarded tick already
  // stored, so the derived cache heals on the next consolidation
  // after a suppression exists. The chat record itself is never
  // touched: suppression governs memory capture, not history.
  const suppressions = activeSuppressions(root, profile);
  const droppedHits: CaptureSuppression[] = [];
  const filterChats = (list: EpisodeChat[]): EpisodeChat[] => suppressions.length === 0 ? list : list.map(c => ({
    ...c,
    messages: c.messages.filter(m => {
      const hit = suppressions.find(s => needleMatches(s.needle, m.content));
      if (hit) { if (!droppedHits.includes(hit)) droppedHits.push(hit); return false; }
      return true;
    }),
  }));
  const db = openEvidenceStore(root);
  try {
    const prefix = profile + ":";
    // Read-merge-write in ONE immediate transaction: a peer tick merging
    // the same profile:date waits on the write lock (busy_timeout) and
    // then reads this write's result, so neither merge can revert the
    // other - the whole-file disease in miniature, closed the same way.
    const write = db.transaction(() => {
      const row = db.prepare("SELECT data FROM episode_evidence WHERE key = ?").get(key) as { data: string } | undefined;
      let existing: EpisodeChat[] = [];
      if (row) {
        try {
          const value: unknown = JSON.parse(row.data);
          if (Array.isArray(value)) existing = value as EpisodeChat[]; else evidenceCorrupt = true;
        } catch { evidenceCorrupt = true; }
      }
      merged = filterChats(mergeEvidenceChats(existing, filterChats(chats)));
      db.prepare("INSERT INTO episode_evidence (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
        .run(key, JSON.stringify(merged));
      // Keep only the newest 31 dates per profile.
      const keys = db.prepare("SELECT key FROM episode_evidence WHERE substr(key, 1, ?) = ? ORDER BY key")
        .all(prefix.length, prefix) as Array<{ key: string }>;
      const drop = db.prepare("DELETE FROM episode_evidence WHERE key = ?");
      for (const old of keys.slice(0, Math.max(0, keys.length - 31))) drop.run(old.key);
    });
    write.immediate();
  } finally { db.close(); }
  if (evidenceCorrupt) recordEpisodesFailure(root, profile, "read", new Error("stored evidence for " + key + " was not valid JSON; the row was rebuilt from the day's new messages"));
  if (!merged.some(c => c.messages.length)) {
    if (droppedHits.length) {
      // The day's whole content is suppressed: no new record is
      // written, and any live prior record for this date (from
      // an earlier, unguarded tick) is archived - the episode
      // lifecycle already archives-and-replaces derived records
      // every tick, and a summary that can no longer be honestly
      // regenerated must not keep surfacing in recall. The
      // record itself is NOT deleted; it stays in the store,
      // archived, under the owner's purge decision like
      // everything else.
      const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
      try {
        const scope = episodeScope(profile), source = episodeSource(profile, date);
        for (const prior of store.list(undefined, [scope]).filter(r => r.source === source)) store.archive(prior.id);
      } finally { store.close(); }
      recordSuppressionBlock(root, profile, "episodes", droppedHits[0]);
    }
    return null;
  }
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const scope = episodeScope(profile), source = episodeSource(profile, date);
    for (const prior of store.list(undefined, [scope]).filter(r => r.source === source)) store.archive(prior.id);
    const record = store.add({ kind: "observation", content: summarizeEpisode(profile, date, merged), source, scope });
    if (droppedHits.length) recordSuppressionBlock(root, profile, "episodes", droppedHits[0]);
    return record;
  } catch (error) {
    // The store-level backstop: a summary line that still
    // carries a needle (a chat title, a count line) is refused
    // by MemoryStore.add itself. The flush degrades to no
    // record this tick - the evidence row above is already
    // filtered, so no later tick resurrects it either.
    if (error instanceof MemorySuppressedError) {
      recordSuppressionBlock(root, profile, "episodes", error.hit);
      return null;
    }
    throw error;
  } finally { store.close(); }
}

export function listEpisodes(root: string, profile?: string): MemoryRecord[] {
  if (profile !== undefined && !validProfile(profile)) throw new Error("Invalid profile");
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const records = profile ? store.list(undefined, [episodeScope(profile)]) : store.list(undefined);
    return records.filter(r => r.source.startsWith("episode:"));
  } finally { store.close(); }
}

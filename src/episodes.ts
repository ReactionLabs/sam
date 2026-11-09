import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryStore, type MemoryRecord } from "./memory.js";

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
// so the day's evidence accumulates in .sam/episodes.json and the summary is
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
// chat, excerpt length) so the file can never grow without limit.
type EvidenceMap = Record<string, EpisodeChat[]>;
function evidencePath(root: string) { return join(resolve(root), ".sam", "episodes.json"); }
function loadEvidence(root: string): EvidenceMap {
  if (!existsSync(evidencePath(root))) return {};
  const value: unknown = JSON.parse(readFileSync(evidencePath(root), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid episodes evidence file");
  return value as EvidenceMap;
}
function saveEvidence(root: string, map: EvidenceMap) {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(evidencePath(root), JSON.stringify(map, null, 2), { mode: 0o600 });
}
function mergeEvidence(map: EvidenceMap, profile: string, date: string, chats: EpisodeChat[]): EpisodeChat[] {
  const key = profile + ":" + date;
  const byId = new Map<string, EpisodeChat>((map[key] ?? []).map(c => [c.chatId, c]));
  for (const chat of chats) {
    const existing = byId.get(chat.chatId) ?? { chatId: chat.chatId, title: chat.title, messages: [] };
    existing.title = chat.title;
    const seen = new Set(existing.messages.map(m => m.created_at + "\n" + m.role + "\n" + m.content));
    for (const m of chat.messages) {
      const stored = { role: m.role, content: excerpt(m.content, 200), created_at: m.created_at };
      const k = stored.created_at + "\n" + stored.role + "\n" + stored.content;
      if (!seen.has(k)) { existing.messages.push(stored); seen.add(k); }
    }
    existing.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    existing.messages = existing.messages.slice(-100);
    byId.set(chat.chatId, existing);
  }
  const merged = [...byId.values()].slice(0, 50);
  map[key] = merged;
  // Keep only the newest 31 dates per profile.
  const dates = Object.keys(map).filter(k => k.startsWith(profile + ":")).sort();
  for (const old of dates.slice(0, Math.max(0, dates.length - 31))) delete map[old];
  return merged;
}

export function writeEpisode(root: string, profile: string, date: string, chats: EpisodeChat[]): MemoryRecord | null {
  if (!validProfile(profile)) throw new Error("Invalid profile");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid episode date");
  if (!chats.some(c => c.messages.length)) return null;
  const map = loadEvidence(root);
  const merged = mergeEvidence(map, profile, date, chats);
  saveEvidence(root, map);
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const scope = episodeScope(profile), source = episodeSource(profile, date);
    for (const prior of store.list(undefined, [scope]).filter(r => r.source === source)) store.archive(prior.id);
    return store.add({ kind: "observation", content: summarizeEpisode(profile, date, merged), source, scope });
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

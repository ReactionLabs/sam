import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { recordActivity } from "./activity.js";
import { draftBlockedFor } from "./contacts.js";

// Outbound drafts (P12): SAM writes on the owner's behalf, but a draft is
// where its power stops. A draft is a record in SAM's own store - there is
// deliberately NO send function in this module or anywhere behind it. The
// owner reads the draft in the dashboard or by CLI, copies it, and sends it
// from their own account with their own hand. Creation refuses outright for
// a contact whose permission note says no drafts.
export interface Draft {
  id: string; actor: string; to: string; channel: string; subject: string | null;
  body: string; status: "draft"; createdAt: string; via: "cli" | "proposal";
}
const CHANNELS = ["email", "text", "message", "letter", "other"];
function draftsPath(root: string): string { return join(resolve(root), ".sam", "drafts.json"); }
function draftsDbFile(root: string): string { return join(resolve(root), ".sam", "drafts.db"); }
// State convergence (UNIFICATION item 4, nineteenth store): the drafts
// store is SQLite (.sam/drafts.db, the contacts pattern), one row per
// draft keyed by its id holding the draft's full JSON, rowid order = the
// old file order. The old drafts.json was rewritten whole on every create
// and every discard, with writers in the CLI and in every process that
// executes an approved draft proposal through the ONE gate, so two
// writers holding the same snapshot silently lost the second one's
// change: an approved draft could vanish, or a discarded draft could
// resurrect in the owner console looking sendable. Here each mutation is
// a single-row INSERT or DELETE, and connections carry a busy_timeout so
// a writer waits out a peer's transaction instead of dying on "database
// is locked". First open imports a legacy drafts.json in file order and
// renames it drafts.json.migrated - imported, never deleted; a malformed
// file or a non-array payload imports nothing and is left in place (the
// migrated shape reads it as no drafts, exactly the old forgiving
// contract). A pure read on an install with neither file creates
// nothing. The P9 backup snapshots every .sam/*.db generically, so the
// migrated store is carried with no backup change.
function openDraftsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(draftsDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyDrafts(db, root);
  return db;
}
function migrateLegacyDrafts(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number };
  if (n > 0) return;
  const file = draftsPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO drafts (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const draft = raw as Partial<Draft>;
      if (typeof draft.id !== "string" || !draft.id) continue;
      insert.run(draft.id, JSON.stringify(draft));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToDraft(data: string): Draft | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as Draft : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(draftsDbFile(root)) || existsSync(draftsPath(root));
}
export function listDrafts(root: string): Draft[] {
  if (!storeExists(root)) return [];
  const db = openDraftsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM drafts ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Draft[] = [];
    for (const row of rows) { const draft = rowToDraft(row.data); if (draft) items.push(draft); }
    return items;
  } finally { db.close(); }
}
function findDraftRow(root: string, id: string): Draft | null {
  if (!storeExists(root)) return null;
  const db = openDraftsStore(root);
  try {
    const row = db.prepare("SELECT data FROM drafts WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToDraft(row.data) : null;
  } finally { db.close(); }
}
// The store's update door (the contacts precedent): patch one draft by
// id through the store's own shape. The id and status are immutable - a
// draft stays a draft; there is still no send surface. Returns the
// updated draft, or null when no such draft exists - and a miss on an
// install with no store at all creates nothing.
export function updateDraft(root: string, id: string, patch: Partial<Draft>): Draft | null {
  if (!id || !storeExists(root)) return null;
  const current = findDraftRow(root, id);
  if (!current) return null;
  const next: Draft = { ...current, ...patch, id: current.id, status: "draft" };
  const db = openDraftsStore(root);
  try { db.prepare("UPDATE drafts SET data = ? WHERE id = ?").run(JSON.stringify(next), current.id); }
  finally { db.close(); }
  return next;
}
export function createDraft(root: string, input: { actor: string; to: string; channel?: string; subject?: string | null; body: string; via?: "cli" | "proposal" }): Draft {
  const to = (input.to ?? "").trim();
  const channel = (input.channel ?? "message").trim().toLowerCase();
  const subject = (input.subject ?? null)?.trim() || null;
  const body = (input.body ?? "").trim();
  if (!to || to.length > 120) throw new Error("Invalid draft recipient");
  if (!CHANNELS.includes(channel)) throw new Error("Invalid draft channel");
  if (subject && subject.length > 200) throw new Error("Invalid draft subject");
  if (!body || body.length > 8000) throw new Error("Invalid draft body");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const blocked = draftBlockedFor(root, to);
  if (blocked) throw new Error("Contact " + blocked.display + " is marked no-drafts by the owner");
  const draft: Draft = {
    id: randomUUID(), actor: input.actor, to, channel, subject, body,
    status: "draft", createdAt: new Date().toISOString(), via: input.via ?? "cli",
  };
  const db = openDraftsStore(root);
  try { db.prepare("INSERT INTO drafts (id, data) VALUES (?, ?)").run(draft.id, JSON.stringify(draft)); }
  finally { db.close(); }
  recordActivity(root, input.actor, "draft", "Drafted " + channel + " to " + to + (subject ? ": " + subject : ""));
  return draft;
}
export function getDraft(root: string, id: string): Draft | null {
  return findDraftRow(root, id);
}
export function removeDraft(root: string, id: string): boolean {
  if (!id || !storeExists(root)) return false;
  const db = openDraftsStore(root);
  let removed = false;
  try {
    const result = db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
    removed = result.changes > 0;
  } finally { db.close(); }
  if (!removed) return false;
  recordActivity(root, "owner", "draft", "Discarded draft " + id.slice(0, 8));
  return true;
}

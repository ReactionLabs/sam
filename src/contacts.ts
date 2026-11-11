import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { recordActivity } from "./activity.js";

// Per-contact permission notes (P12). SAM works for other people through its
// owner, and every person it might write to gets a standing note: what is
// fine, what needs care, and the hard case - noDraft, "never draft anything
// to this person" - which the drafting path refuses outright. A contact with
// no record carries no restriction; a note is how the owner teaches SAM the
// boundaries person by person. Notes are owner words (CLI / owner surfaces),
// never something a chat or a visitor can set.
export interface Contact {
  name: string; display: string; note: string; noDraft: boolean;
  createdAt: string; updatedAt: string;
}
function contactsPath(root: string): string { return join(resolve(root), ".sam", "contacts.json"); }
function contactsDbFile(root: string): string { return join(resolve(root), ".sam", "contacts.db"); }
// State convergence (UNIFICATION item 4, sixteenth store): the contacts
// registry is SQLite (.sam/contacts.db, the minis pattern), one row per
// contact keyed by its slug name holding the contact's full JSON, rowid
// order = the old file order. The old contacts.json was rewritten whole
// on every upsert and every remove, and its writers (the CLI) ran beside
// draftBlockedFor readers on every draft creation and listContacts
// readers in the dashboard status build, so two writers holding the
// same snapshot silently lost the second one's change - permission-
// shaped here: a noDraft mark (the one hard rule a note can carry) could
// vanish or revert under a concurrent save and let a draft be created
// to exactly the person the owner marked never. Here each mutation is
// a single-row INSERT, UPDATE, or DELETE, and connections carry a
// busy_timeout so a writer waits out a peer's transaction instead of
// dying on "database is locked". First open imports a legacy
// contacts.json in file order and renames it contacts.json.migrated -
// imported, never deleted; a malformed file or a non-array payload
// imports nothing and is left in place (the migrated shape reads it as
// no contacts, exactly the old forgiving contract). A pure read on an
// install with neither file creates nothing. The P9 backup snapshots
// every .sam/*.db generically, so the migrated store is carried with
// no backup change.
function openContactsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(contactsDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS contacts (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyContacts(db, root);
  return db;
}
function migrateLegacyContacts(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
  if (n > 0) return;
  const file = contactsPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO contacts (name, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const contact = raw as Partial<Contact>;
      if (typeof contact.name !== "string" || !contact.name) continue;
      insert.run(contact.name, JSON.stringify(contact));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToContact(data: string): Contact | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as Contact : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(contactsDbFile(root)) || existsSync(contactsPath(root));
}
export function contactSlug(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export function listContacts(root: string): Contact[] {
  if (!storeExists(root)) return [];
  const db = openContactsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM contacts ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Contact[] = [];
    for (const row of rows) { const contact = rowToContact(row.data); if (contact) items.push(contact); }
    return items;
  } finally { db.close(); }
}
function findContactRow(root: string, slug: string): Contact | null {
  if (!storeExists(root)) return null;
  const db = openContactsStore(root);
  try {
    const row = db.prepare("SELECT data FROM contacts WHERE name = ?").get(slug) as { data: string } | undefined;
    return row ? rowToContact(row.data) : null;
  } finally { db.close(); }
}
function insertContactRow(root: string, item: Contact): void {
  const db = openContactsStore(root);
  try { db.prepare("INSERT INTO contacts (name, data) VALUES (?, ?)").run(item.name, JSON.stringify(item)); }
  finally { db.close(); }
}
function updateContactRow(root: string, item: Contact): void {
  const db = openContactsStore(root);
  try { db.prepare("UPDATE contacts SET data = ? WHERE name = ?").run(JSON.stringify(item), item.name); }
  finally { db.close(); }
}
// The store's update door (the updateMini precedent): patch one contact
// by slug through the store's own shape. Returns the updated contact,
// or null when no such contact exists - and a miss on an install with
// no store at all creates nothing.
export function updateContact(root: string, name: string, patch: Partial<Contact>): Contact | null {
  const slug = contactSlug(name);
  if (!slug || !storeExists(root)) return null;
  const current = findContactRow(root, slug);
  if (!current) return null;
  const next: Contact = { ...current, ...patch, name: current.name };
  updateContactRow(root, next);
  return next;
}
export function getContact(root: string, name: string): Contact | null {
  const slug = contactSlug(name);
  if (!slug) return null;
  return findContactRow(root, slug);
}
export function upsertContact(root: string, input: { name: string; note?: string; noDraft?: boolean }): Contact {
  const display = (input.name ?? "").trim();
  const slug = contactSlug(display);
  if (!slug || display.length > 120) throw new Error("Invalid contact name");
  const note = (input.note ?? "").trim();
  if (note.length > 2000) throw new Error("Invalid contact note");
  const now = new Date().toISOString();
  const found = findContactRow(root, slug);
  if (found) {
    if (input.note !== undefined) found.note = note;
    if (input.noDraft !== undefined) found.noDraft = !!input.noDraft;
    found.display = display; found.updatedAt = now;
    updateContactRow(root, found);
    recordActivity(root, "owner", "contact", "Updated contact " + slug + (found.noDraft ? " (no drafts)" : ""));
    return found;
  }
  const contact: Contact = { name: slug, display, note, noDraft: !!input.noDraft, createdAt: now, updatedAt: now };
  insertContactRow(root, contact);
  recordActivity(root, "owner", "contact", "Added contact " + slug + (contact.noDraft ? " (no drafts)" : ""));
  return contact;
}
export function removeContact(root: string, name: string): boolean {
  const slug = contactSlug(name);
  if (!slug || !storeExists(root)) return false;
  const db = openContactsStore(root);
  try {
    const result = db.prepare("DELETE FROM contacts WHERE name = ?").run(slug);
    if (result.changes === 0) return false;
  } finally { db.close(); }
  recordActivity(root, "owner", "contact", "Removed contact " + slug);
  return true;
}
// The one hard rule a note can carry: this person never gets a draft.
export function draftBlockedFor(root: string, name: string): Contact | null {
  const contact = getContact(root, name);
  return contact && contact.noDraft ? contact : null;
}

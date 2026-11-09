import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
export function contactSlug(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export function listContacts(root: string): Contact[] {
  const file = contactsPath(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? data as Contact[] : []; }
  catch { return []; }
}
function saveContacts(root: string, items: Contact[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(contactsPath(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
export function getContact(root: string, name: string): Contact | null {
  const slug = contactSlug(name);
  if (!slug) return null;
  return listContacts(root).find(c => c.name === slug) ?? null;
}
export function upsertContact(root: string, input: { name: string; note?: string; noDraft?: boolean }): Contact {
  const display = (input.name ?? "").trim();
  const slug = contactSlug(display);
  if (!slug || display.length > 120) throw new Error("Invalid contact name");
  const note = (input.note ?? "").trim();
  if (note.length > 2000) throw new Error("Invalid contact note");
  const items = listContacts(root);
  const now = new Date().toISOString();
  const found = items.find(c => c.name === slug);
  if (found) {
    if (input.note !== undefined) found.note = note;
    if (input.noDraft !== undefined) found.noDraft = !!input.noDraft;
    found.display = display; found.updatedAt = now;
    saveContacts(root, items);
    recordActivity(root, "owner", "contact", "Updated contact " + slug + (found.noDraft ? " (no drafts)" : ""));
    return found;
  }
  const contact: Contact = { name: slug, display, note, noDraft: !!input.noDraft, createdAt: now, updatedAt: now };
  items.push(contact); saveContacts(root, items);
  recordActivity(root, "owner", "contact", "Added contact " + slug + (contact.noDraft ? " (no drafts)" : ""));
  return contact;
}
export function removeContact(root: string, name: string): boolean {
  const slug = contactSlug(name);
  const items = listContacts(root);
  const kept = items.filter(c => c.name !== slug);
  if (kept.length === items.length) return false;
  saveContacts(root, kept);
  recordActivity(root, "owner", "contact", "Removed contact " + slug);
  return true;
}
// The one hard rule a note can carry: this person never gets a draft.
export function draftBlockedFor(root: string, name: string): Contact | null {
  const contact = getContact(root, name);
  return contact && contact.noDraft ? contact : null;
}

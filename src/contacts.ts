import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Per-contact permission notes (P12). SAM works for other people through its
// owner, and every person it might write to gets a standing note: what is
// fine, what needs care, and the hard case - noDraft, "never draft anything
// to this person" - which the drafting path refuses outright. A contact with
// no record carries no restriction; a note is how the owner teaches SAM the
// boundaries person by person. Notes are owner words (CLI / owner surfaces),
// never something a chat or a visitor can set.
//
// The Address Book (Dip, 2026-11-16): the same store is also SAM's people
// file, modeled on Mita's people files. A record may carry who the person
// is to the owner (relationship, only ever in the owner's own words -
// never guessed), contact details the owner actually gave, fact lines
// learned in conversation (notes), a special flag for the inner circle,
// and mention bookkeeping (first / last mentioned, the source chats each
// fact came from). The store stays the source of truth; every mutation
// re-renders the human-readable face - .sam/address-book/<slug>.md per
// person plus an INDEX.md ordered by closeness, special people first -
// in the same act, so the files can never drift from the store. Unknown
// fields stay absent: a card never invents a relationship or a detail.
export interface Contact {
  name: string; display: string; note: string; noDraft: boolean;
  createdAt: string; updatedAt: string;
  relationship?: string;
  email?: string;
  phone?: string;
  handles?: string[];
  notes?: string[];
  special?: boolean;
  firstMentionedAt?: string;
  lastMentionedAt?: string;
  sourceChats?: string[];
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
  const db = openDatabase(contactsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS contacts (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS contact_offers (name TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL)");
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
// Failure visibility (gap found 2026-11-14, hourly run
// 15:04 EST): the contact store holds the per-person
// permission notes, including the one hard rule a note can
// carry (noDraft), and every touch opened it raw.
// listContacts rides the dashboard status build and the CLI
// contacts views; getContact / draftBlockedFor ride every
// draft creation; upsertContact / updateContact /
// removeContact are the CLI's owner writes. A dead
// contacts.db threw into whichever catch happened to wrap
// the call with the seam unnamed, and no contact-failed
// kind existed, so the class was uncountable - and any
// reader folding a dead store as "no contacts" would
// silently drop a noDraft mark and let a draft be created
// to exactly the person the owner marked never. Now the
// store's touches own their failure (the pairing /
// channels precedent): a failed touch ledgers ONE
// contact-failed line (phase read for listContacts /
// getContact and draftBlockedFor riding it, write for
// upsertContact / updateContact / removeContact; actor
// sam; the verbatim reason collapsed and capped; never any
// contact record - a note is the owner's words about a
// person, not failure data), tags the error, and rethrows
// exactly, so every caller's handling is unchanged and the
// permission check still fails closed (a draft whose block
// check could not run is not created). Validation errors
// (bad name / note) are not store failures and ledger
// nothing. An absent store still reads as no contacts with
// no line and creates nothing, and torn row payloads still
// parse forgiving - only the store touch is guarded.
export type ContactPhase = "read" | "write";

export function contactFailureSummary(phase: ContactPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Contact " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a contact-failed line carries (census sprint
 * 2026-11-17): recordContactFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function contactFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordContactFailure(root: string, phase: ContactPhase, error: unknown): void {
  const reason = contactFailureReason(error);
  recordActivity(root, "sam", "contact-failed", contactFailureSummary(phase, reason));
}

// The contact failed history scorecard (2026-11-23, the
// measured-proof series): the contact store's touches ledger
// every failure as a "contact-failed" line through the ONE
// writer above (contactFailureSummary, fixed shape "Contact
// <phase> failed: <reason>", capped 200; phases read / write,
// ridden by recordContactFailure from the store seams, actor
// sam) - and while self-work's classifyDefect labels single
// lines and the Address Book render failures carry their own
// fold (address-book-failed), no surface folds this kind, so
// a dead contacts store - the store holding the per-person
// permission notes, including the noDraft hard rule the
// drafting path checks on every draft - could fail every
// touch with nothing counting the class in aggregate, and a
// reader folding a dead store as "no contacts" would be
// exactly the silent failure the seam was built to prevent.
// Every failure line is by construction a store touch that
// did not complete, so the verdict is attention when any
// failure was ever recorded or any line is unparseable,
// else clear. This parser is strict: only the two phases
// the writer writes parse, and a non-empty reason is
// required and consumed, never printed - a reason can carry
// a store path and never surfaces here, and no contact
// record (a note is the owner's words about a person) ever
// enters the fold. A line from any other kind never parses.
// A pure read: it creates nothing, updates nothing, and
// reads no contact record - the store seams themselves are
// untouched.
export function parseContactFailedSummary(summary: string): { phase: ContactPhase } | null {
  const m = /^Contact (read|write) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[2] ?? "").trim()) return null;
  return { phase: m[1] as ContactPhase };
}

export function contactFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "contact-failed" });
  let failed = 0;
  let unparseable = 0;
  let read = 0;
  let write = 0;
  for (const line of lines) {
    const parsed = parseContactFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      if (parsed.phase === "read") read += 1;
      else write += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Contact failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(write) + " write");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function tagContactLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { contactLedgered?: boolean }).contactLedgered = true;
  }
}

export function isContactLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { contactLedgered?: boolean }).contactLedgered === true;
}

function failContact(root: string, phase: ContactPhase, error: unknown): never {
  if (!isContactLedgered(error)) recordContactFailure(root, phase, error);
  tagContactLedgered(error);
  throw error;
}
export function contactSlug(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export function listContacts(root: string): Contact[] {
  if (!storeExists(root)) return [];
  let db: Database.Database;
  try { db = openContactsStore(root); } catch (error) { failContact(root, "read", error); }
  try {
    const rows = db!.prepare("SELECT data FROM contacts ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Contact[] = [];
    for (const row of rows) { const contact = rowToContact(row.data); if (contact) items.push(contact); }
    return items;
  } catch (error) { failContact(root, "read", error); }
  finally { db!.close(); }
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
  try {
    const current = findContactRow(root, slug);
    if (!current) return null;
    const next: Contact = { ...current, ...patch, name: current.name };
    updateContactRow(root, next);
    renderAddressBookQuietly(root);
    return next;
  } catch (error) { failContact(root, "write", error); }
}
export function getContact(root: string, name: string): Contact | null {
  const slug = contactSlug(name);
  if (!slug) return null;
  try { return findContactRow(root, slug); }
  catch (error) { failContact(root, "read", error); }
}
export interface ContactUpsertInput {
  name: string;
  note?: string;
  noDraft?: boolean;
  relationship?: string;
  email?: string;
  phone?: string;
  handles?: string[];
  /** Fact lines to APPEND to the person's notes (never a replace). */
  notes?: string[];
  special?: boolean;
  /** The chat this save came from: stamps the mention + source. */
  sourceChat?: string;
}
function cleanField(value: string | undefined, cap: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (clean.length > cap) throw new Error("Invalid contact " + label);
  return clean ? clean : undefined;
}
export function upsertContact(root: string, input: ContactUpsertInput): Contact {
  const display = (input.name ?? "").trim();
  const slug = contactSlug(display);
  if (!slug || display.length > 120) throw new Error("Invalid contact name");
  const note = (input.note ?? "").trim();
  if (note.length > 2000) throw new Error("Invalid contact note");
  const relationship = cleanField(input.relationship, 200, "relationship");
  const email = cleanField(input.email, 200, "email");
  const phone = cleanField(input.phone, 60, "phone");
  let handles: string[] | undefined;
  if (input.handles !== undefined) {
    handles = input.handles.map(h => (h ?? "").trim()).filter(Boolean);
    if (handles.length > 10 || handles.some(h => h.length > 120)) throw new Error("Invalid contact handles");
    if (!handles.length) handles = undefined;
  }
  let newNotes: string[] | undefined;
  if (input.notes !== undefined) {
    newNotes = input.notes.map(n => (n ?? "").trim()).filter(Boolean);
    if (newNotes.some(n => n.length > 1000)) throw new Error("Invalid contact fact note");
    if (!newNotes.length) newNotes = undefined;
  }
  const now = new Date().toISOString();
  try {
    const found = findContactRow(root, slug);
    if (found) {
      if (input.note !== undefined) found.note = note;
      if (input.noDraft !== undefined) found.noDraft = !!input.noDraft;
      if (relationship !== undefined) found.relationship = relationship;
      if (email !== undefined) found.email = email;
      if (phone !== undefined) found.phone = phone;
      if (handles !== undefined) found.handles = handles;
      if (input.special !== undefined) found.special = !!input.special;
      if (newNotes) found.notes = [...(found.notes ?? []), ...newNotes].slice(-100);
      if (!found.firstMentionedAt) found.firstMentionedAt = found.createdAt;
      if (input.sourceChat) {
        found.lastMentionedAt = now;
        const chats = new Set(found.sourceChats ?? []);
        chats.add(input.sourceChat);
        found.sourceChats = [...chats].slice(-20);
      }
      found.display = display; found.updatedAt = now;
      updateContactRow(root, found);
      recordActivity(root, "owner", "contact", contactUpdatedLedgerSummary(slug, found.noDraft));
      renderAddressBookQuietly(root);
      return found;
    }
    const contact: Contact = {
      name: slug, display, note, noDraft: !!input.noDraft, createdAt: now, updatedAt: now,
      firstMentionedAt: now, lastMentionedAt: now,
      ...(relationship ? { relationship } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(handles ? { handles } : {}),
      ...(newNotes ? { notes: newNotes } : {}),
      ...(input.special !== undefined ? { special: !!input.special } : {}),
      ...(input.sourceChat ? { sourceChats: [input.sourceChat] } : {}),
    };
    insertContactRow(root, contact);
    recordActivity(root, "owner", "contact", contactAddedLedgerSummary(slug, contact.noDraft));
    renderAddressBookQuietly(root);
    return contact;
  } catch (error) { failContact(root, "write", error); }
}
export function removeContact(root: string, name: string): boolean {
  const slug = contactSlug(name);
  if (!slug || !storeExists(root)) return false;
  let db: Database.Database;
  try { db = openContactsStore(root); } catch (error) { failContact(root, "write", error); }
  try {
    const result = db!.prepare("DELETE FROM contacts WHERE name = ?").run(slug);
    if (result.changes === 0) return false;
  } catch (error) { failContact(root, "write", error); }
  finally { db!.close(); }
  recordActivity(root, "owner", "contact", contactRemovedLedgerSummary(slug));
  renderAddressBookQuietly(root);
  return true;
}
// The ONE writers for the contact ledger lines: an add, an
// update, and a remove each ledger exactly one of these
// shapes (the slug, plus the " (no drafts)" suffix on an add
// or update whose contact carries the noDraft mark; a remove
// never carries it), so the writers and the scorecard's
// parser below can never drift.
export function contactAddedLedgerSummary(slug: string, noDraft: boolean): string {
  return "Added contact " + slug + (noDraft ? " (no drafts)" : "");
}
export function contactUpdatedLedgerSummary(slug: string, noDraft: boolean): string {
  return "Updated contact " + slug + (noDraft ? " (no drafts)" : "");
}
export function contactRemovedLedgerSummary(slug: string): string {
  return "Removed contact " + slug;
}

// The contact scorecard (2026-11-19, the measured-proof
// series): contact changes have ledgered as "contact" lines
// in the three fixed shapes above since the Address Book
// landed, but the class was never folded, so how the owner's
// people file actually moves - adds against updates against
// removes, and how many of the touched contacts carry the
// one hard rule (no drafts) - was invisible in aggregate.
// This text folds the whole ledger's contact lines to counts
// only, on ONE line: the added, updated, and removed counts,
// the summed no-drafts count, and the total. The slug is
// parsed only to validate the fixed shape and is never
// printed, and no distinct-slug count is taken - a slug is a
// person's name and does not belong in a trending surface.
// A summary matching no fixed shape counts toward the total
// and the unparseable count only, and is never printed. The
// verdict is attention only when a line is unparseable, else
// clear - contact changes are the healthy case, not news by
// themselves. No stamp, no actor, no slug, and no verbatim
// summary enters the text, so a day no contact changes is
// byte-identical and P3-silent, and a malformed line or a
// mix shift is the news. A pure read: it creates nothing,
// spends no model call, and touches no contact - the ledger
// and the store are untouched.
export function parseContactSummary(summary: string): { action: "added" | "updated" | "removed"; noDraft: boolean } | null {
  const m = /^(Added|Updated|Removed) contact \S+( \(no drafts\))?$/.exec(summary);
  if (!m) return null;
  if (m[1] === "Removed" && m[2]) return null;
  const action = m[1] === "Added" ? "added" : m[1] === "Updated" ? "updated" : "removed";
  return { action, noDraft: !!m[2] };
}
export function contactScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "contact" });
  let added = 0;
  let updated = 0;
  let removed = 0;
  let noDrafts = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseContactSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.action === "added") added += 1;
    else if (parsed.action === "updated") updated += 1;
    else removed += 1;
    if (parsed.noDraft) noDrafts += 1;
  }
  const parts: string[] = [];
  parts.push("Contacts: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(added) + " added");
  parts.push(String(updated) + " updated");
  parts.push(String(removed) + " removed");
  parts.push(String(noDrafts) + " no-drafts");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

// The one hard rule a note can carry: this person never gets a draft.
export function draftBlockedFor(root: string, name: string): Contact | null {
  const contact = getContact(root, name);
  return contact && contact.noDraft ? contact : null;
}

// ----------------------------------------------------------------
// Address Book: offer bookkeeping + the people-file face of the store.
// ----------------------------------------------------------------

// The one-time offer (the ambiguous-case fallback): when a person
// comes up with a possible-but-unclear fact, SAM may offer ONCE to
// save them. The offer and the owner's answer are recorded here, in
// the same store, so "never offer again after a no" is a fact the
// runtime can check, not a hope about the model's memory. A person
// with an entry needs no offer; a person with no entry and no row
// here has never been offered.
export type ContactOfferState = "offered" | "declined";
export function contactOfferState(root: string, name: string): ContactOfferState | null {
  const slug = contactSlug(name);
  if (!slug || !storeExists(root)) return null;
  try {
    const db = openContactsStore(root);
    try {
      const row = db.prepare("SELECT state FROM contact_offers WHERE name = ?").get(slug) as { state: string } | undefined;
      return row && (row.state === "offered" || row.state === "declined") ? row.state : null;
    } finally { db.close(); }
  } catch (error) { failContact(root, "read", error); }
}
export function recordContactOffer(root: string, name: string, state: ContactOfferState): void {
  const slug = contactSlug(name);
  if (!slug) throw new Error("Invalid contact name");
  try {
    const db = openContactsStore(root);
    try {
      db.prepare("INSERT INTO contact_offers (name, state, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state, at = excluded.at")
        .run(slug, state, new Date().toISOString());
    } finally { db.close(); }
  } catch (error) { failContact(root, "write", error); }
}

// Closeness order for every people surface (index, list, recall):
// special people first, then most recently mentioned, then name.
export function addressBookOrder(items: Contact[]): Contact[] {
  const stamp = (c: Contact): string => c.lastMentionedAt ?? c.updatedAt ?? c.createdAt ?? "";
  return [...items].sort((a, b) =>
    Number(b.special ?? false) - Number(a.special ?? false)
    || stamp(b).localeCompare(stamp(a))
    || a.display.localeCompare(b.display));
}

export function addressBookDir(root: string): string { return join(resolve(root), ".sam", "address-book"); }
export function personFilePath(root: string, slug: string): string { return join(addressBookDir(root), slug + ".md"); }

function day(iso: string | undefined): string { return iso ? iso.slice(0, 10) : ""; }
export function renderPersonFile(contact: Contact): string {
  const lines: string[] = ["# " + contact.display + (contact.special ? " ★" : ""), ""];
  if (contact.special) lines.push("★ Special: inner circle", "");
  if (contact.relationship) lines.push("- Relationship: " + contact.relationship);
  if (contact.email) lines.push("- Email: " + contact.email);
  if (contact.phone) lines.push("- Phone: " + contact.phone);
  if (contact.handles?.length) lines.push("- Handles: " + contact.handles.join(", "));
  const first = contact.firstMentionedAt ?? contact.createdAt;
  if (first) lines.push("- First mentioned: " + day(first));
  const last = contact.lastMentionedAt ?? contact.updatedAt;
  if (last) lines.push("- Last mentioned: " + day(last));
  if (contact.sourceChats?.length) lines.push("- Source chats: " + contact.sourceChats.join(", "));
  if (contact.notes?.length) {
    lines.push("", "## Notes", "");
    for (const fact of contact.notes) lines.push("- " + fact);
  }
  if (contact.note || contact.noDraft) {
    lines.push("", "## Permission note", "");
    if (contact.note) lines.push(contact.note);
    if (contact.noDraft) lines.push("NO DRAFTS: never draft anything to this person.");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
export function renderAddressBookIndex(items: Contact[]): string {
  const lines: string[] = [
    "# Address Book",
    "",
    "The owner's people file: one page per person, closest first. ★ marks the special people, the inner circle, and they sit on top.",
    "",
  ];
  if (!items.length) lines.push("No one is in the Address Book yet. People land here as they come up in conversation, with the facts the owner actually stated.");
  for (const contact of addressBookOrder(items)) {
    const detail = [contact.relationship, contact.email ?? contact.phone].filter(Boolean).join(" · ");
    lines.push("- " + (contact.special ? "★ " : "") + "**" + contact.display + "**" + (detail ? " — " + detail : "") + " (" + contact.name + ".md)");
  }
  return lines.join("\n") + "\n";
}
// The files are generated, never hand-edited by any code path: a
// render rewrites every person's page plus the index from the
// store's current rows and deletes pages whose person is gone, so
// the directory can never drift from the store. The CLI export
// verb and every store mutation ride this one door.
export function writeAddressBook(root: string): { dir: string; people: number } {
  const items = listContacts(root);
  const dir = addressBookDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keep = new Set<string>(["INDEX.md"]);
  for (const contact of items) {
    keep.add(contact.name + ".md");
    writeFileSync(personFilePath(root, contact.name), renderPersonFile(contact), { mode: 0o600 });
  }
  writeFileSync(join(dir, "INDEX.md"), renderAddressBookIndex(items), { mode: 0o600 });
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".md") && !keep.has(entry)) { try { unlinkSync(join(dir, entry)); } catch { /* a stale page that will not die is untidy, not fatal */ } }
  }
  return { dir, people: items.length };
}
// Mutations re-render in the same act; a render failure never
// unmakes the store write (the store is the truth), but it is
// never silent either: one address-book-failed line, and the CLI
// export verb is the standing repair.
/** The reason an address-book-failed line carries (census
 * sprint 2026-11-17): the quiet Address Book render took
 * error.message alone, discarding error.cause. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no contact content ever enters the line. */
export function addressBookFailureReason(error: unknown): string {
  return errorReason(error);
}

/** The ONE writer for an address-book-failed line (2026-11-22):
 * the quiet render's failure summary, extracted byte-identical
 * from the inline shape renderAddressBookQuietly ledgered, so
 * the seam and the scorecard's parser below can never drift.
 * The line carries one fixed head and the reason, capped at
 * 200 chars whole; there is no phase - the render is the only
 * Address Book write that can fail quietly. */
export function addressBookFailureSummary(reason: string): string {
  return ("Address Book write failed: " + reason).slice(0, 200);
}

// The address book failed history scorecard (2026-11-22, the
// measured-proof series): the quiet Address Book render ledgers
// every failure as an "address-book-failed" line through the
// ONE writer above - but the class was never folded, so how
// often the people file's human-readable face failed to render
// (leaving the directory stale against the store, which stays
// the truth) was invisible in aggregate. The parser learns only
// the one fixed head the seam writes; a reason is consumed and
// never printed, and a line from any other kind never parses.
// The fold is counts only: no stamp, no actor, no reason, and
// no verbatim summary.
export function parseAddressBookFailedSummary(summary: string): { matched: true } | null {
  const m = /^Address Book write failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const reason = m[1] ?? "";
  if (!reason.trim()) return null;
  return { matched: true };
}

export function addressBookFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "address-book-failed" });
  let failed = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseAddressBookFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Address Book failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function renderAddressBookQuietly(root: string): void {
  try { writeAddressBook(root); }
  catch (error) {
    const reason = addressBookFailureReason(error);
    try { recordActivity(root, "sam", "address-book-failed", addressBookFailureSummary(reason)); } catch { /* the ledger never breaks a write */ }
  }
}

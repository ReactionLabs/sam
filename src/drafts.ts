import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { draftBlockedFor } from "./contacts.js";
import { errorReason } from "./error-reason.js";

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
  const db = openDatabase(draftsDbFile(root));
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
// Failure visibility (gap found 2026-11-14, hourly run
// 16:04 EST): the draft store is SAM's outbound drafting
// surface (P12: stored text the owner copies out and sends
// with their own hand; there is deliberately no send
// function), and every touch opened it raw. listDrafts
// rides the dashboard status build and the CLI drafts
// views; getDraft rides the CLI show view; createDraft is
// the CLI create path and the ONE gate's draft executor;
// updateDraft / removeDraft are the update and discard
// doors. A dead drafts.db threw into whichever catch
// happened to wrap the call with the seam unnamed, and no
// draft-failed kind existed, so the class was uncountable.
// Now the store's touches own their failure (the contacts /
// pairing precedent): a failed touch ledgers ONE
// draft-failed line (phase read for listDrafts / getDraft,
// write for createDraft / updateDraft / removeDraft; actor
// sam; the verbatim reason collapsed and capped; never any
// draft record - a draft's recipient, subject, and body are
// the owner's outbound words, not failure data), tags the
// error, and rethrows exactly, so every caller's handling
// is unchanged and reads still fail closed (never folded
// as no drafts, which would hide drafts the owner still
// means to send). Validation errors (bad recipient /
// channel / subject / body / actor) and the noDraft
// refusal are not store failures and ledger nothing, and a
// contact-tagged error from createDraft's block check
// rethrows with no draft line - that touch already
// ledgered its one contact-failed line at its own seam.
// An absent store still reads as no drafts with no line
// and creates nothing, and torn row payloads still parse
// forgiving - only the store touch is guarded.
export type DraftPhase = "read" | "write";

export function draftFailureSummary(phase: DraftPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Draft " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a draft-failed line carries (census sprint
 * 2026-11-17): recordDraftFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function draftFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordDraftFailure(root: string, phase: DraftPhase, error: unknown): void {
  const reason = draftFailureReason(error);
  recordActivity(root, "sam", "draft-failed", draftFailureSummary(phase, reason));
}

// The draft failed history scorecard (2026-11-23, the
// measured-proof series): the draft store ledgers every failed
// store touch as a "draft-failed" line through the ONE writer
// above (draftFailureSummary, one fixed shape: "Draft <phase>
// failed: <reason>", phases read / write, ledger actor sam
// always) - but the class was never folded, so how often the
// outbound drafting surface itself died was invisible in
// aggregate. The parser learns only the writer's fixed shape:
// one of the two phases and a non-empty reason, the reason
// consumed and never printed. A line from any other kind never
// parses. The fold is counts only: no stamp, no phase name
// beyond the fixed per-phase counts, no reason, no verbatim
// summary, and no draft content (a draft's recipient, subject,
// and body are the owner's outbound words, never failure data).
export function parseDraftFailedSummary(summary: string): { phase: DraftPhase } | null {
  const m = /^Draft (read|write) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const reason = m[2] ?? "";
  if (!reason.trim()) return null;
  return { phase: m[1] as DraftPhase };
}

export function draftFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "draft-failed" });
  let failed = 0;
  let read = 0;
  let write = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseDraftFailedSummary(line.summary);
    if (parsed) { failed += 1; if (parsed.phase === "read") read += 1; else write += 1; continue; }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Draft failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(write) + " write");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function tagDraftLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { draftLedgered?: boolean }).draftLedgered = true;
  }
}

export function isDraftLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { draftLedgered?: boolean }).draftLedgered === true;
}

function failDraft(root: string, phase: DraftPhase, error: unknown): never {
  if (!isDraftLedgered(error)) recordDraftFailure(root, phase, error);
  tagDraftLedgered(error);
  throw error;
}
export function listDrafts(root: string): Draft[] {
  if (!storeExists(root)) return [];
  let db: Database.Database;
  try { db = openDraftsStore(root); } catch (error) { failDraft(root, "read", error); }
  try {
    const rows = db!.prepare("SELECT data FROM drafts ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Draft[] = [];
    for (const row of rows) { const draft = rowToDraft(row.data); if (draft) items.push(draft); }
    return items;
  } catch (error) { failDraft(root, "read", error); }
  finally { db!.close(); }
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
  try {
    const current = findDraftRow(root, id);
    if (!current) return null;
    const next: Draft = { ...current, ...patch, id: current.id, status: "draft" };
    const db = openDraftsStore(root);
    try { db.prepare("UPDATE drafts SET data = ? WHERE id = ?").run(JSON.stringify(next), current.id); }
    finally { db.close(); }
    return next;
  } catch (error) { failDraft(root, "write", error); }
}
// The ONE source for the draft store's SHAPE rules, measured
// exactly as createDraft measures them (recipient trimmed,
// channel trimmed and lowercased against the five, subject
// trimmed, body trimmed). createDraft throws this text at
// write time; the proposal gate's validateDraftDetail throws
// the identical text at proposal time, so a draft detail that
// breaks a shape rule never becomes a card that can only fail
// on approval. The no-drafts contact fence is deliberately
// NOT here: a contact can be marked between proposal and
// approval, and that refusal stays an execution-time landing
// (drafts.test.ts pins it).
export function draftShapeBlocker(input: { to?: unknown; channel?: unknown; subject?: unknown; body?: unknown }): string | null {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!to || to.length > 120) return "Invalid draft recipient";
  const channel = input.channel === undefined || input.channel === null ? "message" : typeof input.channel === "string" ? input.channel.trim().toLowerCase() : "";
  if (!CHANNELS.includes(channel)) return "Invalid draft channel";
  if (input.subject !== undefined && input.subject !== null) {
    if (typeof input.subject !== "string" || input.subject.trim().length > 200) return "Invalid draft subject";
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > 8000) return "Invalid draft body";
  return null;
}
export function createDraft(root: string, input: { actor: string; to: string; channel?: string; subject?: string | null; body: string; via?: "cli" | "proposal" }): Draft {
  const to = (input.to ?? "").trim();
  const channel = (input.channel ?? "message").trim().toLowerCase();
  const subject = (input.subject ?? null)?.trim() || null;
  const body = (input.body ?? "").trim();
  const shapeBlocker = draftShapeBlocker(input);
  if (shapeBlocker) throw new Error(shapeBlocker);
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const blocked = draftBlockedFor(root, to);
  if (blocked) throw new Error("Contact " + blocked.display + " is marked no-drafts by the owner");
  const draft: Draft = {
    id: randomUUID(), actor: input.actor, to, channel, subject, body,
    status: "draft", createdAt: new Date().toISOString(), via: input.via ?? "cli",
  };
  let db: Database.Database;
  try { db = openDraftsStore(root); } catch (error) { failDraft(root, "write", error); }
  try { db!.prepare("INSERT INTO drafts (id, data) VALUES (?, ?)").run(draft.id, JSON.stringify(draft)); }
  catch (error) { failDraft(root, "write", error); }
  finally { db!.close(); }
  recordActivity(root, input.actor, "draft", draftCreatedLedgerSummary(channel, to, subject));
  return draft;
}
export function getDraft(root: string, id: string): Draft | null {
  try { return findDraftRow(root, id); }
  catch (error) { failDraft(root, "read", error); }
}
export function removeDraft(root: string, id: string): boolean {
  if (!id || !storeExists(root)) return false;
  let db: Database.Database;
  try { db = openDraftsStore(root); } catch (error) { failDraft(root, "write", error); }
  let removed = false;
  try {
    const result = db!.prepare("DELETE FROM drafts WHERE id = ?").run(id);
    removed = result.changes > 0;
  } catch (error) { failDraft(root, "write", error); }
  finally { db!.close(); }
  if (!removed) return false;
  recordActivity(root, "owner", "draft", draftDiscardedLedgerSummary(id));
  return true;
}
// The ONE writer for the draft-created activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. Its shape is byte-identical to what createDraft
// wrote inline before this writer existed.
export function draftCreatedLedgerSummary(channel: string, to: string, subject: string | null): string {
  return "Drafted " + channel + " to " + to + (subject ? ": " + subject : "");
}
// The ONE writer for the draft-discarded activity line, on
// the same terms: byte-identical to what removeDraft wrote
// inline (the id's first 8 chars, never the full id).
export function draftDiscardedLedgerSummary(id: string): string {
  return "Discarded draft " + id.slice(0, 8);
}
// The draft scorecard (2026-11-20, the measured-proof
// series): every draft SAM creates or the owner discards has
// ledgered as a "draft" line since P12 landed, but the class
// was never folded - drafts are where SAM's outbound power
// stops (there is no send surface), so the ledger is the
// only aggregate record of how much drafting happens on the
// owner's behalf and how much of it is thrown away, and in
// aggregate it was invisible. Creating and discarding drafts
// is the normal owner workflow, not an alarm, so the verdict
// is attention only when a line is unparseable, else clear.
// This text folds the class to counts only, on ONE line: the
// created and discarded counts, the created counts per fixed
// channel bucket (this module's own CHANNELS enum, in enum
// order, nonzero only), and the total. No stamp, no actor,
// no recipient, no subject, no draft id, and no verbatim
// summary enters the text - the summary carries the
// recipient and the subject, which a fold must never print.
// A pure read: it creates nothing, spends no model call,
// drafts nothing, and discards nothing - the draft seams
// themselves are untouched.
export function parseDraftSummary(summary: string): { action: "created"; channel: string } | { action: "discarded" } | null {
  const created = /^Drafted ([a-z]+) to ([\s\S]+)$/.exec(summary);
  if (created) {
    if (!CHANNELS.includes(created[1] ?? "")) return null;
    if (!(created[2] ?? "").trim()) return null;
    return { action: "created", channel: created[1] as string };
  }
  if (/^Discarded draft \S{8}$/.test(summary)) return { action: "discarded" };
  return null;
}
export function draftScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "draft" });
  let created = 0;
  let discarded = 0;
  let unparseable = 0;
  const byChannel = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseDraftSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.action === "created") {
      created += 1;
      byChannel.set(parsed.channel, (byChannel.get(parsed.channel) ?? 0) + 1);
    } else discarded += 1;
  }
  const channels = CHANNELS.filter(c => (byChannel.get(c) ?? 0) > 0).map(c => c + " " + String(byChannel.get(c)));
  const parts: string[] = [];
  parts.push("Drafts: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(created) + " created");
  parts.push(String(discarded) + " discarded");
  parts.push("channels " + (channels.length ? channels.join(" / ") : "none"));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

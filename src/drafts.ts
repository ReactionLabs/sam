import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
export function listDrafts(root: string): Draft[] {
  const file = draftsPath(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? data as Draft[] : []; }
  catch { return []; }
}
function saveDrafts(root: string, items: Draft[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(draftsPath(root), JSON.stringify(items, null, 2), { mode: 0o600 });
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
  const items = listDrafts(root); items.push(draft); saveDrafts(root, items);
  recordActivity(root, input.actor, "draft", "Drafted " + channel + " to " + to + (subject ? ": " + subject : ""));
  return draft;
}
export function getDraft(root: string, id: string): Draft | null {
  return listDrafts(root).find(d => d.id === id) ?? null;
}
export function removeDraft(root: string, id: string): boolean {
  const items = listDrafts(root);
  const kept = items.filter(d => d.id !== id);
  if (kept.length === items.length) return false;
  saveDrafts(root, kept);
  recordActivity(root, "owner", "draft", "Discarded draft " + id.slice(0, 8));
  return true;
}

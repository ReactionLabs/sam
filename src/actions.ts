import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { addHeartbeatJob } from "./heartbeat.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { installSkill } from "./skill-registry.js";
import { createDraft } from "./drafts.js";

// Hands, with a gate. SAM (any profile) can PROPOSE an action; nothing executes
// until the owner approves it in the dashboard or by CLI. The executor allowlist
// is deliberately internal-only: save a memory note, set a standing law, create
// a heartbeat job, post a message into one of SAM's own chats, or (P12, on the
// owner's own program order) save an outbound DRAFT the owner then sends
// themselves - drafting writes only to SAM's own store, there is no send path.
// No external sends, no service control, no money, no trading - widening this
// list is an owner decision, never a model decision. Every step lands in the
// activity ledger, so a proposal's whole life is auditable.
export type ActionKind = "note" | "law" | "heartbeat" | "say" | "skill" | "draft";
export type ActionStatus = "pending" | "done" | "rejected" | "failed";
export interface ActionProposal {
  id: string; actor: string; kind: ActionKind; title: string; detail: string;
  status: ActionStatus; createdAt: string; decidedAt: string | null; result: string | null;
  chatId: string | null;
  // Note PATCH (Phase B item 2): a kind "note" proposal may name the
  // memory record it supersedes. On approval the new note saves AND
  // that record is archived, so recall stops surfacing the stale text.
  supersedes: string | null;
}
const KINDS: ActionKind[] = ["note", "law", "heartbeat", "say", "skill", "draft"];
function actionsFile(root: string): string { return join(resolve(root), ".sam", "actions.json"); }
export function listActions(root: string): ActionProposal[] {
  const file = actionsFile(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? (data as ActionProposal[]).map(a => ({ ...a, chatId: a.chatId ?? null, supersedes: a.supersedes ?? null })) : []; }
  catch { return []; }
}
function saveActions(root: string, items: ActionProposal[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(actionsFile(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
// Profile-reference validation (found live 2026-11-09 on Dip's PC): a
// heartbeat proposal named profile "Second Shift" - the connector's DISPLAY
// name, not a profile - was shown as an approval card, and only on approval
// did execution die with "Invalid profile", leaving a dead card and no job.
// A proposal must never be shown in a form that cannot execute, so the
// profile a heartbeat detail names is checked against the registry at
// PROPOSAL time. "sam" is the implicit core profile (same rule as links.ts
// validMember and the dashboard's default-agent check); every other name
// must be a registered agent profile.
export function knownProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; }
  finally { db.close(); }
}
function normalizeProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// The one unambiguous correction for a bad profile name: exactly one known
// profile matches it once case and separators are folded ("Second Shift"
// -> "second-shift"). Anything else is a guess and is never applied.
export function correctedProfileName(root: string, bad: string): string | null {
  const target = normalizeProfileName(bad ?? "");
  if (!target) return null;
  const matches = knownProfileNames(root).filter(n => normalizeProfileName(n) === target);
  return matches.length === 1 ? matches[0] : null;
}
function validateHeartbeatDetail(root: string, detail: string): void {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}");
  const s = spec as { name?: unknown; minutes?: unknown; profile?: unknown; prompt?: unknown };
  const profile = typeof s.profile === "string" ? s.profile : "";
  const names = knownProfileNames(root);
  if (!names.includes(profile)) {
    const fix = correctedProfileName(root, profile);
    throw new Error("Unknown profile \"" + profile + "\" in heartbeat detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : ""));
  }
  if (typeof s.name !== "string" || !/^[a-zA-Z0-9 _-]{1,80}$/.test(s.name)) throw new Error("Invalid heartbeat name in detail");
  if (!Number.isSafeInteger(Number(s.minutes)) || Number(s.minutes) < 5 || Number(s.minutes) > 10080) throw new Error("Invalid heartbeat minutes in detail (5 to 10080)");
  if (typeof s.prompt !== "string" || !s.prompt.trim() || s.prompt.length > 2000) throw new Error("Invalid heartbeat prompt in detail");
}
export function proposeAction(root: string, input: { actor: string; kind: string; title: string; detail: string; chatId?: string | null; supersedes?: string | null }): ActionProposal {
  if (!KINDS.includes(input.kind as ActionKind)) throw new Error("Invalid action kind");
  const title = (input.title ?? "").trim();
  const detail = (input.detail ?? "").trim();
  if (!title || title.length > 200) throw new Error("Invalid action title");
  if (!detail || detail.length > 4000) throw new Error("Invalid action detail");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  if (input.kind === "heartbeat") validateHeartbeatDetail(root, detail);
  const item: ActionProposal = {
    id: randomUUID(), actor: input.actor, kind: input.kind as ActionKind, title, detail,
    status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null,
    chatId: input.chatId ?? null,
    supersedes: input.kind === "note" ? (input.supersedes ?? null) : null,
  };
  const items = listActions(root); items.push(item); saveActions(root, items);
  recordActivity(root, input.actor, "proposal", "Proposed " + item.kind + ": " + title);
  return item;
}
async function execute(root: string, a: ActionProposal): Promise<string> {
  if (a.kind === "note") {
    const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
    try {
      const scope = a.actor === "sam" ? "core" : "profile:" + a.actor;
      // PATCH execution: the superseded record must still be a live
      // record at the new note's scope, or the patch lands failed
      // rather than silently saving beside a record it cannot retire.
      let old: ReturnType<MemoryStore["get"]> = null;
      if (a.supersedes) {
        old = store.get(a.supersedes);
        if (!old) throw new Error("Cannot patch: record " + a.supersedes + " no longer exists");
        if (old.archived_at) throw new Error("Cannot patch: record " + a.supersedes + " is already archived");
        if (old.scope !== scope) throw new Error("Cannot patch: record " + a.supersedes + " is not in this profile's scope");
      }
      const rec = store.add({ kind: "observation", content: a.detail, source: "owner-approved action " + a.id, scope });
      if (a.supersedes && old) {
        if (!store.archive(old.id)) throw new Error("Cannot patch: record " + old.id + " could not be archived");
        return "Memory note saved (" + rec.id + "), superseding record archived (" + old.id + ")";
      }
      return "Memory note saved (" + rec.id + ")";
    } finally { store.close(); }
  }
  if (a.kind === "law") {
    const store = new PreferenceStore(root);
    try { store.note(a.actor, a.detail, "rule", "owner-approved action " + a.id); return "Standing law set for " + a.actor; }
    finally { store.close(); }
  }
  if (a.kind === "heartbeat") {
    const spec = JSON.parse(a.detail) as { name: string; minutes: number; profile: string; prompt: string; channelId?: string | null };
    const job = addHeartbeatJob(root, spec.name, Number(spec.minutes), spec.profile, spec.prompt, spec.channelId ?? null);
    return "Heartbeat job created (" + job.id + ")";
  }
  if (a.kind === "say") {
    const spec = JSON.parse(a.detail) as { chatId: string; text: string };
    const db = new ChatStore(root);
    try { db.add(spec.chatId, "assistant", spec.text); return "Message posted to chat " + spec.chatId; }
    finally { db.close(); }
  }
  if (a.kind === "draft") {
    // P12 outbound drafting: the approved execution writes a draft record
    // into SAM's own store and stops there. There is no send path; the
    // owner copies the draft and sends it themselves. A contact marked
    // no-drafts refuses here, so the proposal lands as failed, not sent.
    const spec = JSON.parse(a.detail) as { to: string; channel?: string; subject?: string | null; body: string };
    const draft = createDraft(root, { actor: a.actor, to: spec.to, channel: spec.channel, subject: spec.subject ?? null, body: spec.body, via: "proposal" });
    return "Draft saved for " + draft.to + " (" + draft.id + ") - the owner sends it";
  }
  const summary = await installSkill(root, a.detail, { actor: a.actor });
  if (!summary.installed.length) throw new Error("Nothing installed: " + (summary.skipped.join("; ") || "no skills found"));
  return "Installed skill(s): " + summary.installed.map(i => i.name).join(", ") + (summary.skipped.length ? " (skipped: " + summary.skipped.join("; ") + ")" : "");
}
export async function decideAction(root: string, id: string, approve: boolean): Promise<ActionProposal> {
  const items = listActions(root);
  const a = items.find(x => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "pending") throw new Error("Action already decided");
  a.decidedAt = new Date().toISOString();
  if (!approve) {
    a.status = "rejected"; a.result = "Rejected by owner";
    saveActions(root, items);
    recordActivity(root, "owner", "rejected", a.kind + ": " + a.title);
    return a;
  }
  try { a.result = await execute(root, a); a.status = "done"; }
  catch (e) {
    a.status = "failed"; a.result = e instanceof Error ? e.message : "Execution failed";
    // A failed card must not be a dead end. A heartbeat that died on an
    // unknown profile (a legacy proposal written before proposal-time
    // validation, or a profile removed after proposing) gets a corrected
    // re-proposal when the correction is unambiguous; otherwise the result
    // names the valid profiles so the owner can re-propose with full
    // information instead of guessing from "Invalid profile".
    let reproposal: { detail: string; fix: string } | null = null;
    if (a.kind === "heartbeat") {
      try {
        const spec = JSON.parse(a.detail) as { profile?: unknown };
        const bad = typeof spec?.profile === "string" ? spec.profile : "";
        const names = knownProfileNames(root);
        if (bad && !names.includes(bad)) {
          const fix = correctedProfileName(root, bad);
          if (fix) reproposal = { detail: JSON.stringify({ ...(spec as object), profile: fix }), fix };
          else a.result += ". Valid profiles: " + names.join(", ");
        }
      } catch { /* detail was not JSON; the failure result stands as-is */ }
    }
    saveActions(root, items);
    recordActivity(root, "owner", "failed", a.kind + ": " + a.title + " - " + (a.result ?? ""));
    if (reproposal) {
      const existing = listActions(root).find(x => x.status === "pending" && x.kind === "heartbeat" && x.actor === a.actor && x.detail === reproposal!.detail);
      const np = existing ?? proposeAction(root, { actor: a.actor, kind: a.kind, title: a.title, detail: reproposal.detail, chatId: a.chatId });
      const fresh = listActions(root); const self = fresh.find(x => x.id === a.id);
      if (self) {
        self.result = (self.result ?? "") + " Corrected re-proposal pending approval: " + np.id + " (profile " + reproposal.fix + ")";
        saveActions(root, fresh); a.result = self.result;
      }
      if (!existing) recordActivity(root, "owner", "reproposal", "Corrected re-proposal for failed " + a.kind + ": " + a.title + " -> profile " + reproposal.fix);
    }
    return a;
  }
  saveActions(root, items);
  recordActivity(root, "owner", a.status === "done" ? "approved" : "failed", a.kind + ": " + a.title + " - " + (a.result ?? ""));
  return a;
}

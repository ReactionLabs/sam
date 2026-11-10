import { join, resolve } from "node:path";
import { MemoryStore, type MemoryKind, type MemoryRecord } from "./memory.js";
import { ChatStore } from "./chats.js";
import { proposeAction, type ActionProposal } from "./actions.js";
import { recordActivity } from "./activity.js";

// Two-tier note saves (Dip ruling 2026-11-09 14:10 EST, refined 14:11;
// Plan Phase B item 1). SAM saves HELPFUL notes freely; HARD changes
// still get approval. The tier is decided HERE, deterministically, by
// the content - never by the model asking nicely - because a gate the
// model can talk its way past is not a gate.
//
// SOFT (saves immediately, no card): observations, useful facts, what
// worked, project context. Written through MemoryStore.add at the
// actor's scope (core for sam, profile:<name> otherwise - the same
// scope rule as an approved note action), source "sam-saved", one
// ledger line, and the tool result tells the model to state the save
// in its reply: ungated, never silent. Notes stay owner-revocable -
// they are ordinary memory records, so `memory archive <id>` retires
// one and recall excludes archived records.
//
// HARD (routed to the P1 proposal gate as a kind "note" proposal -
// the ONE gate, no second ledger): anything that supersedes or
// contradicts an existing record, identity or addressing facts about
// the owner or a person, and anything law-like (standing-rule
// phrasing). When in doubt, gate it: the classifier errs toward hard.
// Model-proposed LAW, heartbeats, skills, drafts, and say are
// untouched by this - they stay proposal-only, as before.
//
// Visitor chats save NOTHING (P12): a visitor is not the owner, so
// their conversation cannot write memory on either tier.
export type NoteTier = "soft" | "hard";
export interface NoteClassification { tier: NoteTier; reason: string | null }

const SUPERSESSION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsupersed\w*\b/i, "it says it supersedes an existing record"],
  [/\breplac\w*\b/i, "it says it replaces an existing record"],
  [/\binstead of\b/i, "it corrects one thing with another (instead of)"],
  [/\bno longer\b/i, "it retires something (no longer)"],
  [/\bnot\b[^.]{1,60}\banymore\b/i, "it retires something (not ... anymore)"],
  [/\bchanged (his|her|their|my|the owner'?s) mind\b/i, "it records a changed mind, which supersedes the earlier record"],
  [/\bcontradict\w*\b/i, "it says it contradicts an existing record"],
  [/\boverrid\w*\b/i, "it says it overrides an existing record"],
  [/\bcorrection\b/i, "it calls itself a correction"],
];
const IDENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(call|address|refer to) (me|the owner|him|her|them|us)\b/i, "it states how a person is addressed"],
  [/\b(goes by|known as|prefers to be called)\b/i, "it states what a person goes by"],
  [/\b(my|his|her|their|the owner'?s) name is\b/i, "it states a person's name"],
  [/\bname is now\b/i, "it states a person's name"],
  [/\bowner'?s (name|email|phone|address)\b/i, "it states an identity fact about the owner"],
];
const LAW_PATTERNS: Array<[RegExp, string]> = [
  [/\b(always|never|must|shall)\b/i, "it is phrased as a standing rule (always/never/must)"],
  [/^(do not|don't|never|always|stop|only)\b/i, "it opens with a standing-rule imperative"],
  [/\bfrom now on\b/i, "it sets a rule from now on"],
  [/\bevery time\b/i, "it sets a rule for every time"],
  [/\brule is\b/i, "it calls itself a rule"],
];

export function classifyNote(content: string, opts?: { supersedes?: string | null }): NoteClassification {
  if (opts?.supersedes) return { tier: "hard", reason: "it names a record it supersedes (" + opts.supersedes + ")" };
  for (const [pattern, reason] of SUPERSESSION_PATTERNS) if (pattern.test(content)) return { tier: "hard", reason };
  for (const [pattern, reason] of IDENTITY_PATTERNS) if (pattern.test(content)) return { tier: "hard", reason };
  for (const [pattern, reason] of LAW_PATTERNS) if (pattern.test(content)) return { tier: "hard", reason };
  return { tier: "soft", reason: null };
}

export type SaveNoteResult =
  | { status: "saved"; tier: "soft"; record: MemoryRecord }
  | { status: "pending_owner_approval"; tier: "hard"; reason: string; proposal: ActionProposal };

// --- Note PATCH, the supersession verb (Plan Phase B item 2, Hermes'
// add/patch/remove shape). A patch names ONE existing record and the
// text that replaces it. It is a hard change by definition, so it
// always routes through the ONE proposal gate; on approval the
// executor saves the new note AND archives the old record, so recall
// (list/search/episode surfaces all exclude archived records) stops
// surfacing the stale text beside its replacement. The target is
// validated at PROPOSAL time - it must exist, still be live, and sit
// at the actor's own scope (core for sam, profile:<name> otherwise) -
// so a card that cannot execute is never shown (the heartbeat
// dead-card lesson). A profile can never patch another profile's
// record, not even by knowing its id.
export function actorScope(actor: string): string { return actor === "sam" ? "core" : "profile:" + actor; }

export function validatePatchTarget(root: string, actor: string, id: string): MemoryRecord {
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const rec = store.get(id);
    if (!rec) throw new Error("Cannot patch: no memory record with id " + id);
    if (rec.archived_at) throw new Error("Cannot patch: record " + id + " is already archived");
    if (rec.scope !== actorScope(actor)) throw new Error("Cannot patch: record " + id + " belongs to scope " + rec.scope + ", not this profile's scope (" + actorScope(actor) + ")");
    return rec;
  } finally { store.close(); }
}

function refuseVisitor(root: string, chatId: string): void {
  const chats = new ChatStore(root);
  try { if (chats.isVisitor(chatId)) throw new Error("Visitors cannot save notes: a visitor is not the owner, and their words never become memory"); }
  finally { chats.close(); }
}

export type PatchNoteResult = { status: "pending_owner_approval"; tier: "hard"; reason: string; proposal: ActionProposal; supersedes: string };

export function patchNote(root: string, input: { actor: string; id: string; content: string; chatId?: string | null }): PatchNoteResult {
  const content = (input.content ?? "").trim();
  if (!content || content.length > 2000) throw new Error("Invalid note content (1 to 2000 characters)");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const id = (input.id ?? "").trim();
  if (!id) throw new Error("Invalid patch target: a record id is required");
  if (input.chatId) refuseVisitor(root, input.chatId);
  const old = validatePatchTarget(root, input.actor, id);
  const reason = "it patches (supersedes) record " + id;
  const proposal = proposeAction(root, {
    actor: input.actor, kind: "note",
    title: "Patch note: " + content.slice(0, 80),
    detail: content, chatId: input.chatId ?? null, supersedes: id,
  });
  recordActivity(root, input.actor, "note-gated", "Note patch routed to owner approval (" + reason + ", was: " + old.content.slice(0, 80) + "): " + content.slice(0, 120));
  return { status: "pending_owner_approval", tier: "hard", reason, proposal, supersedes: id };
}

export function saveNote(root: string, input: { actor: string; content: string; kind?: string; chatId?: string | null; supersedes?: string | null }): SaveNoteResult {
  const content = (input.content ?? "").trim();
  if (!content || content.length > 2000) throw new Error("Invalid note content (1 to 2000 characters)");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const kind = (input.kind ?? "observation") as MemoryKind;
  if (!["observation", "decision", "failure", "procedure"].includes(kind)) throw new Error("Invalid note kind. Choose observation, decision, failure, or procedure.");
  if (input.chatId) refuseVisitor(root, input.chatId);
  const { tier, reason } = classifyNote(content, { supersedes: input.supersedes ?? null });
  if (tier === "hard") {
    // Through the one gate: a kind "note" proposal. Approving it saves
    // exactly this text as an owner-approved note (actions.ts execute).
    // When the note names a record it supersedes, that target is
    // validated NOW (patchNote's rule) and carried on the proposal, so
    // approval retires the old record in the same act - the approved
    // note never lands beside a stale record it was meant to replace.
    if (input.supersedes) validatePatchTarget(root, input.actor, input.supersedes);
    const proposal = proposeAction(root, {
      actor: input.actor, kind: "note",
      title: "Note: " + content.slice(0, 80),
      detail: content, chatId: input.chatId ?? null, supersedes: input.supersedes ?? null,
    });
    recordActivity(root, input.actor, "note-gated", "Hard note routed to owner approval (" + reason + "): " + content.slice(0, 120));
    return { status: "pending_owner_approval", tier, reason: reason ?? "hard change", proposal };
  }
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const scope = input.actor === "sam" ? "core" : "profile:" + input.actor;
    const record = store.add({ kind, content, source: "sam-saved", scope });
    recordActivity(root, input.actor, "note-saved", "Saved note (" + record.id + ", " + scope + "): " + content.slice(0, 120));
    return { status: "saved", tier, record };
  } finally { store.close(); }
}

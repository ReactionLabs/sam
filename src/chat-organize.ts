import { ChatStore, type ChatRecord } from "./chats.js";
import { archiveManagedChat, isManagedChat } from "./chat-manage.js";
import { autotitleChat, provisionalTitle, type TitleCompleter } from "./chat-title.js";
import { readActivity, recordActivity } from "./activity.js";

/**
 * The chat organize pass (Dip ask 2026-11-14: "clean up the chats and
 * make it where sam can organize them"). One run tidies the acting
 * profile's OWN chats, through the same fence as sam_manage_chats
 * (isManagedChat: own profile only, visitor chats never):
 *
 * - TITLES: a chat still carrying a placeholder title gets a real
 *   name from its first exchange, through the shipped auto-title
 *   machinery (autotitleChat: the cheap-model completer plus
 *   sanitizeChatTitle, renaming only while the stored title is still
 *   the placeholder, so an owner rename mid-pass always wins). A
 *   title counts as a placeholder when it is a generic shell ("New
 *   conversation", "Web chat", ...) or when it is exactly the
 *   provisional title the dashboard computed from the first message.
 *   Any other title is treated as owner-given and is NEVER touched.
 * - ARCHIVES: a chat is archived only when it is stale (no message
 *   activity for ORGANIZE_STALE_DAYS days or more) AND matches an
 *   identifiable scratch shape: an empty chat, a scratch/test/proof
 *   title pattern, or a single-message test chat. A multi-message
 *   conversation with a real title is never archived, however old.
 * - NEVER: no pinning (that is the owner's taste), no deleting (chat
 *   deletion is owner-only and does not exist on this surface), and
 *   the chat the owner is speaking in is never archived. Every
 *   archive is reversible through the ordinary unarchive door.
 *
 * One run writes ONE activity record and returns one chat-visible
 * summary naming everything it did, so the owner can check the pass
 * against the resulting list exactly.
 */

export const ORGANIZE_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface OrganizeRenamed { chatId: string; from: string; to: string }
export interface OrganizeArchived { chatId: string; title: string; reason: string }
export interface OrganizeResult {
  scanned: number;
  renamed: OrganizeRenamed[];
  archived: OrganizeArchived[];
  kept: number;
  summary: string;
}

const GENERIC_TITLE = /^(new conversation|new chat|untitled|chat|conversation|web chat|terminal|daily chat)$/i;
// Identifiable scratch shapes in a title. Deliberately narrow: a bare
// "proof" does NOT match (real work is full of banner proofs and
// proof emails) - only proof chats/runs/tests, plus smoke, scratch,
// seeded, fixture, and probe wording, and titles that LEAD with a
// test/eval marker.
const SCRATCH_TITLE = /\b(smoke|scratch|seeded|fixture|probe)\b/i;
const PROOF_TITLE = /\bproof[-\s]?(chat|run|test|check)\b/i;
const TEST_TITLE = /^(test|eval|qa)\b/i;

export function isPlaceholderTitle(chat: ChatRecord, firstUserContent: string | null): boolean {
  const title = (chat.title ?? "").trim();
  if (!title) return true;
  if (GENERIC_TITLE.test(title)) return true;
  if (firstUserContent && provisionalTitle(firstUserContent) === title) return true;
  return false;
}

function archiveReason(chat: ChatRecord, messageCount: number, lastActivityAt: string | null, nowMs: number): string | null {
  if (chat.pinned) return null;
  const last = Date.parse(lastActivityAt ?? chat.updated_at);
  const ageDays = Math.floor((nowMs - last) / DAY_MS);
  if (!(ageDays >= ORGANIZE_STALE_DAYS)) return null;
  const idle = "no activity for " + ageDays + " days";
  if (messageCount === 0) return "empty chat, " + idle;
  if (SCRATCH_TITLE.test(chat.title) || PROOF_TITLE.test(chat.title) || TEST_TITLE.test(chat.title)) {
    return "stale scratch/test chat (title pattern), " + idle;
  }
  if (messageCount === 1) return "one-message test chat, " + idle;
  return null;
}

export function organizeSummary(scanned: number, renamed: OrganizeRenamed[], archived: OrganizeArchived[]): string {
  if (!renamed.length && !archived.length) {
    return "Organized my chats: nothing to do. Scanned " + scanned + " chats: every kept chat already has a real title, and no stale scratch/test chats were found (stale means no activity for " + ORGANIZE_STALE_DAYS + "+ days). Nothing was renamed or archived.";
  }
  const lines = ["Organized my chats: scanned " + scanned + ", renamed " + renamed.length + ", archived " + archived.length + "."];
  for (const r of renamed) lines.push("Renamed: \"" + r.from + "\" -> \"" + r.to + "\".");
  for (const a of archived) lines.push("Archived: \"" + a.title + "\" (" + a.reason + ").");
  lines.push("Archiving is reversible: ask me to unarchive any of these. Nothing was deleted, and no pinned chat was touched.");
  return lines.join("\n");
}

export async function organizeChats(
  root: string,
  actor: string,
  opts?: { now?: Date; currentChatId?: string; env?: NodeJS.ProcessEnv; complete?: TitleCompleter },
): Promise<OrganizeResult> {
  const nowMs = (opts?.now ?? new Date()).getTime();
  // Plan under one store read: which chats archive (and why), and
  // which still carry a placeholder title worth naming. Writes then
  // go through the existing fenced doors (autotitleChat re-checks
  // the placeholder at write time; archiveManagedChat re-checks the
  // fence), so a concurrent owner action always wins.
  const archivePlan: Array<{ chat: ChatRecord; reason: string }> = [];
  const renamePlan: Array<{ chat: ChatRecord }> = [];
  let scanned = 0;
  const store = new ChatStore(root);
  try {
    const mine = store.list({ includeArchived: true }).filter(c => isManagedChat(root, actor, c) && !c.archived);
    scanned = mine.length;
    const activity = new Map(store.lastActivity().map(a => [a.chat_id, a] as const));
    for (const chat of mine) {
      const act = activity.get(chat.id);
      const reason = chat.id === opts?.currentChatId
        ? null
        : archiveReason(chat, act?.messages ?? 0, act?.last_message_at ?? null, nowMs);
      if (reason) { archivePlan.push({ chat, reason }); continue; }
      const firstUser = store.messages(chat.id).find(m => m.role === "user") ?? null;
      if (isPlaceholderTitle(chat, firstUser?.content ?? null)) renamePlan.push({ chat });
    }
  } finally { store.close(); }

  const renamed: OrganizeRenamed[] = [];
  for (const { chat } of renamePlan) {
    const to = await autotitleChat(root, chat.id, chat.title, opts?.env ?? process.env, opts?.complete);
    if (to) renamed.push({ chatId: chat.id, from: chat.title, to });
  }
  const archived: OrganizeArchived[] = [];
  for (const { chat, reason } of archivePlan) {
    try {
      const done = archiveManagedChat(root, actor, chat.id);
      archived.push({ chatId: chat.id, title: done.title, reason });
    } catch { /* the fence moved under the pass; the chat simply stays */ }
  }

  const summary = organizeSummary(scanned, renamed, archived);
  recordActivity(root, actor, "chat-organize", chatOrganizeLedgerSummary(scanned, renamed.length, archived.length));
  return { scanned, renamed, archived, kept: scanned - archived.length, summary };
}

// The chat-organize ledger shape has ONE writer here (the
// measured-proof series, 2026-11-21): the line lived as inline
// concatenation at the organizeChats seam, and any drift was
// invisible. The shape is byte-identical to what that seam
// wrote inline before this writer existed.
export function chatOrganizeLedgerSummary(scanned: number, renamed: number, archived: number): string {
  return "Organized chats: scanned " + scanned + ", renamed " + renamed + ", archived " + archived +
    " (stale threshold " + ORGANIZE_STALE_DAYS + " days; nothing deleted, nothing pinned)";
}

// Organize history fold (2026-11-21): an organize pass is an
// act, not a store - nothing persists its outcome except this
// ledger line (the chats it archived read back as ordinary
// archived chats, indistinguishable from single-chat
// archives), so the ledger is the only place the history of
// passes survives. This family has no failure class of its
// own (a failed pass surfaces through the chat tool's error
// path, not a ledger kind), so the verdict is attention only
// when a line is unparseable. The parser validates the stale
// threshold against the module's own ORGANIZE_STALE_DAYS, so
// a threshold change in code reads older lines as drift,
// never silently as the new shape.
export function parseChatOrganizeSummary(summary: string): { scanned: number; renamed: number; archived: number } | null {
  const m = /^Organized chats: scanned (\d+), renamed (\d+), archived (\d+) \(stale threshold (\d+) days; nothing deleted, nothing pinned\)$/.exec(summary);
  if (!m) return null;
  if (Number(m[4]) !== ORGANIZE_STALE_DAYS) return null;
  return { scanned: Number(m[1]), renamed: Number(m[2]), archived: Number(m[3]) };
}

export function chatOrganizeHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "chat-organize" });
  let passes = 0;
  let unparseable = 0;
  let scanned = 0;
  let renamed = 0;
  let archived = 0;
  const actorSet = new Set<string>();
  for (const line of lines) {
    const parsed = parseChatOrganizeSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    passes += 1;
    scanned += parsed.scanned;
    renamed += parsed.renamed;
    archived += parsed.archived;
    actorSet.add(line.actor);
  }
  const parts: string[] = [];
  parts.push("Chat organize history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(passes) + " passes");
  parts.push(String(scanned) + " scanned");
  parts.push(String(renamed) + " renamed");
  parts.push(String(archived) + " archived");
  parts.push(String(actorSet.size) + " distinct actors");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

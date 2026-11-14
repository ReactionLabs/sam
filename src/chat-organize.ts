import { ChatStore, type ChatRecord } from "./chats.js";
import { archiveManagedChat, isManagedChat } from "./chat-manage.js";
import { autotitleChat, provisionalTitle, type TitleCompleter } from "./chat-title.js";
import { recordActivity } from "./activity.js";

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
  recordActivity(root, actor, "chat-organize",
    "Organized chats: scanned " + scanned + ", renamed " + renamed.length + ", archived " + archived.length +
    " (stale threshold " + ORGANIZE_STALE_DAYS + " days; nothing deleted, nothing pinned)");
  return { scanned, renamed, archived, kept: scanned - archived.length, summary };
}

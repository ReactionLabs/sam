import { ChatStore, type ChatRecord } from "./chats.js";
import { readDashboardConfig } from "./dashboard-config.js";

/**
 * Chat management (Dip ask 2026-11-09 22:13: "I want him to be
 * able to manage its chats"). SAM tidies its own conversation
 * space from chat or CLI instead of the owner doing it in the
 * dashboard: list, create, rename, pin, branch, archive, and
 * search across a profile's chats. CLI parity first - every
 * function here is one shared core used by the CLI verbs and
 * the sam_manage_chats own tool alike.
 *
 * The fence, enforced here and nowhere else:
 * - A profile manages chats bound to itself. Chats with no
 *   binding belong to the workspace's default agent (the same
 *   resolution runChatTurn uses), so the core SAM manages the
 *   unbound chats and a scoped SAM never sees them.
 * - Visitor chats are NEVER managed through this surface, by
 *   anyone: they belong to the door, and the dashboard is
 *   their surface.
 * - There is no delete. Archive retires a chat (it leaves the
 *   dashboard rail and this list); the record stays.
 */

/** The sam_manage_chats tool's action registry: the ten
 *  actions the dispatch in own-tools.ts can run (list,
 *  create, rename, pin, unpin, branch, archive, unarchive,
 *  organize, search). The tool definition's enum names the
 *  same ten; this constant is the runtime source the
 *  refusal reads, because a type-level enum is invisible
 *  to a caller whose action arrives as a plain string. */
export const chatActions = ["list", "create", "rename", "pin", "unpin", "branch", "archive", "unarchive", "organize", "search"] as const;
export type ChatAction = (typeof chatActions)[number];

function foldChatAction(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The ONE source for why the sam_manage_chats tool cannot
 *  run this action: the action is not in the chatActions
 *  registry, so the dispatch would have to guess which
 *  chat operation the caller meant. The dispatch refused
 *  an unknown action with the bare "Unknown chat action:
 *  X" - echoing the value but naming none of the ten
 *  actions and offering no fold correction, so the model's
 *  "List", "Re-name", or "un_archive" dead-ended even
 *  though the intended action is unambiguous (the
 *  sam_senses dispatch got its ONE source in the previous
 *  sweep run; this dispatch was the remaining bare one on
 *  the chat-management door). The dispatch now returns
 *  this source as the tool's error before any chat is
 *  touched. The standing "Unknown chat action" prefix is
 *  kept. When exactly one action matches the bad name
 *  folded for case and separators, the refusal names it.
 *  Null means the action can be named. */
export function chatActionBlocker(value: unknown): string | null {
  if (typeof value === "string" && (chatActions as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldChatAction(value) : "";
  const matches = target ? chatActions.filter(a => foldChatAction(a) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown chat action \"" + String(value) + "\". Actions: " + chatActions.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

export function coreActor(root: string): string {
  // The dashboard config's one read door (dashboard-config.ts):
  // this surface used to read the raw JSON file itself, with its
  // own sanitization that already disagreed with the dashboard
  // reader at the edges. A broken config reads as the default
  // through the store, which is what this fallback always
  // claimed to mirror. The resolve phase names this caller's
  // shape in the store's failure line: a dead store ledgers
  // ONE dashboard-config-failed:resolve line in the reader
  // (tagged, so this catch records nothing more) and this
  // fallback to "sam" - the designed answer for no config -
  // is now countable instead of indistinguishable from it.
  try { return readDashboardConfig(root, "resolve").defaultAgent || "sam"; } catch { return "sam"; }
}

function boundProfile(root: string, chat: ChatRecord): string {
  return chat.agent_name ?? coreActor(root);
}

export function isManagedChat(root: string, actor: string, chat: ChatRecord): boolean {
  if (chat.visitor) return false;
  return boundProfile(root, chat) === actor;
}

function withStore<T>(root: string, fn: (store: ChatStore) => T): T {
  const store = new ChatStore(root);
  try { return fn(store); } finally { store.close(); }
}

function requireManaged(root: string, actor: string, store: ChatStore, chatId: string): ChatRecord {
  const chat = store.get(chatId);
  if (!chat) throw new Error("Chat not found: " + chatId);
  if (chat.visitor) throw new Error("Visitor chats are not managed here; they belong to the door and its dashboard");
  if (!isManagedChat(root, actor, chat)) throw new Error("That chat belongs to profile '" + boundProfile(root, chat) + "', not '" + actor + "' - a SAM manages only its own chats");
  return chat;
}

export function listManagedChats(root: string, actor: string, opts?: { includeArchived?: boolean }): ChatRecord[] {
  return withStore(root, store => store.list({ includeArchived: true })
    .filter(c => isManagedChat(root, actor, c) && (opts?.includeArchived || !c.archived)));
}

export function createManagedChat(root: string, actor: string, title: string): ChatRecord {
  return withStore(root, store => store.create(title, actor === coreActor(root) ? null : actor));
}

export function renameManagedChat(root: string, actor: string, chatId: string, title: string): ChatRecord {
  return withStore(root, store => { requireManaged(root, actor, store, chatId); store.rename(chatId, title); return store.get(chatId) as ChatRecord; });
}

export function pinManagedChat(root: string, actor: string, chatId: string, pinned: boolean): ChatRecord {
  return withStore(root, store => { requireManaged(root, actor, store, chatId); store.pin(chatId, pinned); return store.get(chatId) as ChatRecord; });
}

export function branchManagedChat(root: string, actor: string, chatId: string, title: string): ChatRecord {
  return withStore(root, store => { requireManaged(root, actor, store, chatId); const branch = store.branch(chatId, title); if (boundProfile(root, branch) !== actor) store.setAgent(branch.id, actor === coreActor(root) ? null : actor); return store.get(branch.id) as ChatRecord; });
}

export function archiveManagedChat(root: string, actor: string, chatId: string): ChatRecord {
  return withStore(root, store => { requireManaged(root, actor, store, chatId); store.archive(chatId, true); return store.get(chatId) as ChatRecord; });
}

export function unarchiveManagedChat(root: string, actor: string, chatId: string): ChatRecord {
  return withStore(root, store => { requireManaged(root, actor, store, chatId); store.archive(chatId, false); return store.get(chatId) as ChatRecord; });
}

export interface ChatSearchHit { chatId: string; messageId: string; title: string; role: string; snippet: string; created_at: string; rank: number }

export function searchManagedChats(root: string, actor: string, query: string, limit = 20): ChatSearchHit[] {
  return withStore(root, store => {
    const mine = store.list({ includeArchived: false }).filter(c => isManagedChat(root, actor, c));
    const titles = new Map(mine.map(c => [c.id, c.title] as const));
    // FTS (Phase B item 4): relevance-ranked multi-term prefix search
    // over the whole message store, with the snippet cut by FTS around
    // the match. The fence is unchanged - only the actor's own
    // non-visitor, non-archived chats are ever in the id list.
    return store.searchMessagesFts(query, mine.map(c => c.id), limit).map(h => ({
      chatId: h.chat_id, messageId: h.message_id, title: titles.get(h.chat_id) ?? "", role: h.role,
      snippet: h.snippet || h.content.slice(0, 200), created_at: h.created_at, rank: h.rank,
    }));
  });
}

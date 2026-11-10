import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore, type ChatRecord } from "./chats.js";

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

export function coreActor(root: string): string {
  try {
    const file = join(resolve(root), ".sam", "dashboard-config.json");
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as { defaultAgent?: unknown };
      if (typeof data.defaultAgent === "string" && data.defaultAgent) return data.defaultAgent;
    }
  } catch { /* a broken config reads as the default, like the dashboard's own reader */ }
  return "sam";
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

export interface ChatSearchHit { chatId: string; title: string; role: string; snippet: string; created_at: string }

export function searchManagedChats(root: string, actor: string, query: string, limit = 20): ChatSearchHit[] {
  return withStore(root, store => {
    const mine = store.list({ includeArchived: false }).filter(c => isManagedChat(root, actor, c));
    const titles = new Map(mine.map(c => [c.id, c.title] as const));
    return store.searchMessages(query, mine.map(c => c.id), limit).map(h => {
      const at = h.content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, at - 60);
      return { chatId: h.chat_id, title: titles.get(h.chat_id) ?? "", role: h.role, snippet: (start > 0 ? "..." : "") + h.content.slice(start, start + 200), created_at: h.created_at };
    });
  });
}

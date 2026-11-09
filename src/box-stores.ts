import { provisionBoxStorage, type BoxStorage } from "./box-storage.js";
import { MissionStore } from "./storage.js";
import { MemoryStore } from "./memory.js";
import { ChatStore } from "./chats.js";

/**
 * Opens durable state for one trusted owner/instance pair.
 * Mission and memory tables share the box's private SQLite database;
 * chats and agent profiles use a separate database under that box's workspace.
 * Caller MUST authenticate identity and enforce tool permissions separately.
 * This provides storage namespace separation, not OS/process isolation.
 * Legacy workspace-level data is deliberately not imported or migrated.
 */
export function openBoxStores(workspaceRoot: string, ownerId: string, instanceId: string): {
  storage: BoxStorage;
  missions: MissionStore;
  memory: MemoryStore;
  chats: ChatStore;
  close: () => void;
} {
  const storage = provisionBoxStorage(workspaceRoot, ownerId, instanceId);
  const missions = new MissionStore(storage.database);
  let memory: MemoryStore | undefined;
  let chats: ChatStore | undefined;
  try {
    memory = new MemoryStore(storage.database);
    chats = new ChatStore(storage.workspace);
  } catch (error) {
    try { chats?.close(); } finally {
      try { memory?.close(); } finally { missions.close(); }
    }
    throw error;
  }
  let closed = false;
  return {
    storage,
    missions,
    memory,
    chats,
    close: () => {
      if (closed) return;
      closed = true;
      try { chats!.close(); } finally {
        try { memory!.close(); } finally { missions.close(); }
      }
    }
  };
}

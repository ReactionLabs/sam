import { provisionBoxStorage, type BoxStorage } from "./box-storage.js";
import { MissionStore } from "./storage.js";
import { MemoryStore } from "./memory.js";

/**
 * Opens mission and memory stores for a single trusted owner/instance pair.
 * Caller MUST authenticate identity and enforce tool permissions separately.
 * This provides database namespace separation, not OS/process isolation.
 * Legacy workspace-level data is deliberately not imported or migrated.
 */
export function openBoxStores(workspaceRoot: string, ownerId: string, instanceId: string): {
  storage: BoxStorage;
  missions: MissionStore;
  memory: MemoryStore;
  close: () => void;
} {
  const storage = provisionBoxStorage(workspaceRoot, ownerId, instanceId);
  const missions = new MissionStore(storage.database);
  let memory: MemoryStore;
  try {
    memory = new MemoryStore(storage.database);
  } catch (error) {
    missions.close();
    throw error;
  }
  let closed = false;
  return {
    storage,
    missions,
    memory,
    close: () => {
      if (closed) return;
      closed = true;
      memory.close();
      missions.close();
    }
  };
}

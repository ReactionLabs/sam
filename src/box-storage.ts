import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** Storage layout only. This is NOT a process sandbox or authorization check. */
export type BoxStorage = Readonly<{
  root: string;
  database: string;
  workspace: string;
  vault: string;
}>;

const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validateId(id: string, label: string): void {
  if (typeof id !== "string" || !identifier.test(id) || reserved.test(id)) {
    throw new Error(`Invalid ${label}`);
  }
}

function checkedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe SAM box storage directory");
}

function existingOrCreate(parent: string, child: string): string {
  checkedDirectory(parent);
  const path = join(parent, child);
  try { mkdirSync(path, { mode: 0o700, recursive: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkedDirectory(path);
  return path;
}

/**
 * Allocate non-overlapping local paths for a trusted owner/instance pair.
 * Callers MUST authenticate these IDs, enforce capabilities, and isolate
 * OS processes and credentials separately. Not safe against a malicious
 * same-user process racing filesystem changes.
 */
export function provisionBoxStorage(workspaceRoot: string, ownerId: string, instanceId: string): BoxStorage {
  validateId(ownerId, "owner ID");
  validateId(instanceId, "instance ID");
  const workspaceRootReal = realpathSync(resolve(workspaceRoot));
  checkedDirectory(workspaceRootReal);
  const state = existingOrCreate(workspaceRootReal, ".sam");
  const boxes = existingOrCreate(state, "boxes");
  const owner = existingOrCreate(boxes, ownerId);
  const root = existingOrCreate(owner, instanceId);
  const workspace = existingOrCreate(root, "workspace");
  const vault = existingOrCreate(root, "vault");
  return { root, database: join(root, "missions.db"), workspace, vault };
}

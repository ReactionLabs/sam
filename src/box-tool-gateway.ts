import { capabilityAllowed, type CapabilityGrant, type CapabilityRequest } from "./box-capabilities.js";

/** A denied operation never invokes the supplied executor. */
export class CapabilityDeniedError extends Error {
  constructor() {
    super("SAM capability denied");
    this.name = "CapabilityDeniedError";
  }
}

/**
 * Execute only after a fresh capability check. Callers must derive `request`
 * from authenticated runtime identity and trusted tool metadata, never model
 * arguments. `grants` must come from an owner-controlled grant store.
 *
 * This is a reusable execution boundary, not a live-tool integration.
 */
export async function executeWithCapability<T>(
  request: CapabilityRequest,
  grants: readonly CapabilityGrant[],
  execute: () => T | Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  if (!capabilityAllowed(request, grants, now)) throw new CapabilityDeniedError();
  return await execute();
}

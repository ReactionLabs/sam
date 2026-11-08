import { CapabilityDeniedError, executeWithCapability } from "./box-tool-gateway.js";
import type { CapabilityGrant, CapabilityRequest } from "./box-capabilities.js";

/** Trusted, authenticated context supplied by the runtime, never by the model. */
export type BoxIdentity = Readonly<Pick<CapabilityRequest, "instanceId" | "ownerId" | "tenantId">>;
/** Tool metadata is registered by the host, not supplied in a model tool call. */
export type BoxTool = Readonly<{
  name: string;
  connector: string;
  resource: string;
  action: string;
  run: (args: unknown) => unknown | Promise<unknown>;
}>;

/**
 * Binds model-visible tool names to trusted identity and host-controlled
 * capability metadata. Unknown tools fail closed; the model may only provide
 * the tool name and opaque arguments. Grants are loaded afresh per call so
 * revocations can take effect without restarting the dispatcher.
 *
 * The caller must authenticate identity, control tools, and keep the grant
 * provider owner-controlled. This adapter alone does not authenticate callers.
 */
export function createBoxDispatcher(
  identity: BoxIdentity,
  tools: readonly BoxTool[],
  loadGrants: () => readonly CapabilityGrant[] | Promise<readonly CapabilityGrant[]>,
  now: () => number = Date.now,
): (name: string, args: unknown) => Promise<unknown> {
  const trustedIdentity = Object.freeze({
    instanceId: identity.instanceId,
    ownerId: identity.ownerId,
    tenantId: identity.tenantId,
  });
  const registry = new Map<string, BoxTool>();
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !/^[a-zA-Z][\w.-]{0,127}$/.test(tool.name) || registry.has(tool.name))
      throw new Error("Invalid or duplicate SAM tool name");
    registry.set(tool.name, Object.freeze({ ...tool }));
  }
  return async (name, args) => {
    const tool = registry.get(name);
    if (!tool) throw new CapabilityDeniedError();
    const request: CapabilityRequest = {
      ...trustedIdentity, connector: tool.connector, resource: tool.resource, action: tool.action,
    };
    const grants = await loadGrants();
    return executeWithCapability(request, grants, () => tool.run(args), now());
  };
}

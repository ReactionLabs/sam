/** Local deny-by-default policy for a future MCP tool executor.
 * This module does not perform network requests or grant credentials.
 * An owner-reviewed allowlist must contain exact server-advertised tool names.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
}
export type McpDecision =
  | { allowed: true; tool: string }
  | { allowed: false; reason: "not-allowlisted" | "invalid-tool" | "duplicate-tool" | "untrusted-server" };

const VALID_TOOL = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

/** Never use fuzzy, prefix, wildcard, or description-based permission matching. */
export function authorizeMcpTool(
  toolName: unknown,
  advertised: readonly McpToolDescriptor[],
  ownerApprovedReadOnlyTools: ReadonlySet<string>,
  serverTrusted: boolean,
): McpDecision {
  if (!serverTrusted) return { allowed: false, reason: "untrusted-server" };
  if (typeof toolName !== "string" || !VALID_TOOL.test(toolName))
    return { allowed: false, reason: "invalid-tool" };
  const matches = advertised.filter(t => t.name === toolName);
  if (matches.length > 1) return { allowed: false, reason: "duplicate-tool" };
  if (matches.length !== 1 || !ownerApprovedReadOnlyTools.has(toolName))
    return { allowed: false, reason: "not-allowlisted" };
  return { allowed: true, tool: toolName };
}

/** Explicitly reject unexpected arguments before any transport is connected. */
export function assertJsonToolArguments(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP tool arguments must be a JSON object");
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32) throw new Error("MCP tool arguments too deeply nested");
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object" || Array.isArray(node) === false && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null)
      throw new Error("MCP tool arguments must be plain JSON");
    if (seen.has(node)) throw new Error("MCP tool arguments contain a cycle");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(node)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          throw new Error("MCP tool arguments contain a forbidden key");
        walk(item, depth + 1);
      }
    }
    seen.delete(node);
  };
  walk(value, 0);
  return value as Record<string, unknown>;
}

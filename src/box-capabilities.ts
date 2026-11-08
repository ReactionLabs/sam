/** Pure, fail-closed capability checks. No persistence, grants, or tool wiring yet. */
export type CapabilityRequest = Readonly<{
  instanceId: string;
  ownerId: string;
  tenantId: string;
  connector: string;
  resource: string;
  action: string;
}>;

export type CapabilityGrant = CapabilityRequest & Readonly<{
  expiresAt: number;
}>;

const valid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f*]/.test(value);

const fields = ["instanceId", "ownerId", "tenantId", "connector", "resource", "action"] as const;

/**
 * Returns true only for an exact, non-expired match. Unknown/malformed
 * requests and grants are denied. The runtime must authenticate owner
 * and instance identities before constructing requests.
 */
export function capabilityAllowed(
  request: CapabilityRequest,
  grants: readonly CapabilityGrant[],
  now: number,
): boolean {
  if (!Number.isSafeInteger(now) || now < 0 || !request || !Array.isArray(grants)) return false;
  if (!fields.every((field) => valid(request[field]))) return false;
  return grants.some((grant) =>
    grant !== null &&
    typeof grant === "object" &&
    Number.isSafeInteger(grant.expiresAt) &&
    grant.expiresAt > now &&
    fields.every((field) => valid(grant[field]) && grant[field] === request[field]),
  );
}

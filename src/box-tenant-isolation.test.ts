import test from "node:test";
import assert from "node:assert/strict";
import { createBoxDispatcher, type BoxIdentity, type BoxTool } from "./box-dispatch.js";
import { CapabilityDeniedError } from "./box-tool-gateway.js";
import type { CapabilityGrant } from "./box-capabilities.js";

// Offline Second Shift-shaped fixture: no network, credentials, or customer data.
// Tool handlers derive tenant from trusted runtime context, never model arguments.
test("two SAM boxes read only their own test-tenant leads across dispatcher restart and revocation", async () => {
  const leads = new Map([
    ["test-tenant-a", [{ id: "lead-a", stage: "new" }]],
    ["test-tenant-b", [{ id: "lead-b", stage: "contacted" }]],
  ]);
  const alice: BoxIdentity = { ownerId: "owner-1", instanceId: "website-sam", tenantId: "test-tenant-a" };
  const bob: BoxIdentity = { ownerId: "owner-1", instanceId: "research-sam", tenantId: "test-tenant-b" };
  const grantFor = (identity: BoxIdentity): CapabilityGrant => ({
    ...identity, connector: "second-shift", resource: "leads", action: "read", expiresAt: 2000,
  });
  let grants: CapabilityGrant[] = [grantFor(alice), grantFor(bob)];
  let executions = 0;
  const tool: BoxTool = {
    name: "list_leads", connector: "second-shift", resource: "leads", action: "read",
    run: (_args, trusted) => { executions++; return leads.get(trusted.tenantId) ?? []; },
  };
  const start = (identity: BoxIdentity) => createBoxDispatcher(identity, [tool], () => grants, () => 1000);
  let a = start(alice);
  let b = start(bob);
  assert.deepEqual(await a("list_leads", { stage: "new" }), [{ id: "lead-a", stage: "new" }]);
  assert.deepEqual(await b("list_leads", {}), [{ id: "lead-b", stage: "contacted" }]);
  await assert.rejects(a("list_leads", { tenantId: "test-tenant-b" }), CapabilityDeniedError);
  await assert.rejects(b("list_leads", { nested: { owner_id: "owner-2" } }), CapabilityDeniedError);
  assert.equal(executions, 2, "spoofed requests must not invoke connector");
  // Simulate dispatcher reconstruction after service restart. Grants remain owner-controlled.
  a = start(alice);
  b = start(bob);
  assert.deepEqual(await a("list_leads", {}), [{ id: "lead-a", stage: "new" }]);
  assert.deepEqual(await b("list_leads", {}), [{ id: "lead-b", stage: "contacted" }]);
  grants = [grantFor(alice)];
  await assert.rejects(b("list_leads", {}), CapabilityDeniedError);
  assert.deepEqual(await a("list_leads", {}), [{ id: "lead-a", stage: "new" }]);
  assert.equal(executions, 5, "revoked box must never reach connector");
});

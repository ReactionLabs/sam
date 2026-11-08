import test from "node:test";
import assert from "node:assert/strict";
import { capabilityAllowed, type CapabilityGrant, type CapabilityRequest } from "./box-capabilities.js";

const request: CapabilityRequest = {
  instanceId: "sam-website",
  ownerId: "owner-1",
  tenantId: "second-shift-test",
  connector: "second-shift",
  resource: "leads",
  action: "read",
};
const grant: CapabilityGrant = { ...request, expiresAt: 2000 };

test("default deny and explicit exact-match read grant", () => {
  assert.equal(capabilityAllowed(request, [], 1000), false);
  assert.equal(capabilityAllowed(request, [grant], 1000), true);
});

test("isolation across instance, owner, tenant, connector, resource and action", () => {
  for (const field of ["instanceId", "ownerId", "tenantId", "connector", "resource", "action"] as const) {
    const changed = { ...request, [field]: "different" };
    assert.equal(capabilityAllowed(changed, [grant], 1000), false, field);
  }
  assert.equal(capabilityAllowed({ ...request, action: "send" }, [grant], 1000), false);
});

test("expires exactly at deadline, rejects invalid clocks and malformed grants", () => {
  assert.equal(capabilityAllowed(request, [grant], 2000), false);
  assert.equal(capabilityAllowed(request, [grant], Number.NaN), false);
  assert.equal(capabilityAllowed(request, [{ ...grant, expiresAt: Infinity }], 1000), false);
  assert.equal(capabilityAllowed(request, [{ ...grant, expiresAt: -1 }], 1000), false);
  assert.equal(capabilityAllowed(request, [null as unknown as CapabilityGrant], 1000), false);
});

test("rejects wildcard and empty identities, no prefix grants", () => {
  assert.equal(capabilityAllowed({ ...request, instanceId: "*" }, [grant], 1000), false);
  assert.equal(capabilityAllowed({ ...request, tenantId: "" }, [grant], 1000), false);
  assert.equal(capabilityAllowed(request, [{ ...grant, resource: "*" }], 1000), false);
  assert.equal(capabilityAllowed(request, [{ ...grant, resource: "lead" }], 1000), false);
  assert.equal(capabilityAllowed(request, [{ ...grant, ownerId: "owner-1\n" }], 1000), false);
});

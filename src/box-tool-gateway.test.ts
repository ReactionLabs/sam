import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityDeniedError, executeWithCapability } from "./box-tool-gateway.js";
import type { CapabilityRequest, CapabilityGrant } from "./box-capabilities.js";

const request: CapabilityRequest = {
  instanceId: "sam-site", ownerId: "owner-a", tenantId: "tenant-a",
  connector: "second-shift", resource: "leads", action: "read",
};
const grant: CapabilityGrant = { ...request, expiresAt: 2000 };

test("denied by default without invoking executor", async () => {
  let calls = 0;
  await assert.rejects(executeWithCapability(request, [], () => { calls++; }, 1000), CapabilityDeniedError);
  assert.equal(calls, 0);
});

test("exact scoped grant invokes executor once and returns result", async () => {
  let calls = 0;
  const result = await executeWithCapability(request, [grant], async () => { calls++; return "ok"; }, 1000);
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("cross-box and cross-tenant calls never reach executor", async () => {
  let calls = 0;
  for (const altered of [{ ...request, instanceId: "sam-crypto" }, { ...request, tenantId: "tenant-b" }, { ...request, action: "send" }]) {
    await assert.rejects(executeWithCapability(altered, [grant], () => { calls++; }, 1000), CapabilityDeniedError);
  }
  assert.equal(calls, 0);
});

test("expired and revoked grants fail before execution", async () => {
  let calls = 0;
  await assert.rejects(executeWithCapability(request, [grant], () => { calls++; }, 2000), CapabilityDeniedError);
  await assert.rejects(executeWithCapability(request, [], () => { calls++; }, 1000), CapabilityDeniedError);
  assert.equal(calls, 0);
});

test("executor failures propagate without retry", async () => {
  let calls = 0;
  await assert.rejects(executeWithCapability(request, [grant], () => { calls++; throw new Error("tool failed"); }, 1000), /tool failed/);
  assert.equal(calls, 1);
});

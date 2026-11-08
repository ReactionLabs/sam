import test from "node:test";
import assert from "node:assert/strict";
import { createBoxDispatcher } from "./box-dispatch.js";
import { CapabilityDeniedError } from "./box-tool-gateway.js";
import type { CapabilityGrant } from "./box-capabilities.js";

const identity = { ownerId: "owner-a", instanceId: "sam-a", tenantId: "tenant-a" };
const permission = { ...identity, connector: "second-shift", resource: "leads", action: "read" };
const grant: CapabilityGrant = { ...permission, expiresAt: 2000 };

test("authorized read uses trusted identity and tool metadata, not model arguments", async () => {
  let calls = 0;
  const dispatch = createBoxDispatcher(identity, [
    { name: "leads", connector: "second-shift", resource: "leads", action: "read", run: args => { calls++; return args; } },
  ], () => [grant], () => 1000);
  const result = await dispatch("leads", { ownerId: "owner-b", tenantId: "tenant-b", action: "send" });
  assert.deepEqual(result, { ownerId: "owner-b", tenantId: "tenant-b", action: "send" });
  assert.equal(calls, 1);
});

test("missing, expired and revoked grants deny without invoking tool", async () => {
  let calls = 0, grants: CapabilityGrant[] = [];
  const dispatch = createBoxDispatcher(identity, [
    { name: "leads", connector: "second-shift", resource: "leads", action: "read", run: () => { calls++; } },
  ], () => grants, () => 1000);
  await assert.rejects(dispatch("leads", {}), CapabilityDeniedError);
  grants = [{ ...grant, expiresAt: 1000 }];
  await assert.rejects(dispatch("leads", {}), CapabilityDeniedError);
  grants = [grant];
  await dispatch("leads", {});
  grants = [];
  await assert.rejects(dispatch("leads", {}), CapabilityDeniedError);
  assert.equal(calls, 1);
});

test("cross-instance, cross-tenant and unknown tools are denied", async () => {
  let calls = 0;
  const tools = [{ name: "leads", connector: "second-shift", resource: "leads", action: "read", run: () => { calls++; } }];
  const other = createBoxDispatcher({ ...identity, instanceId: "sam-b" }, tools, () => [grant], () => 1000);
  const tenant = createBoxDispatcher({ ...identity, tenantId: "tenant-b" }, tools, () => [grant], () => 1000);
  const valid = createBoxDispatcher(identity, tools, () => [grant], () => 1000);
  for (const action of [
    () => other("leads", {}), () => tenant("leads", {}), () => valid("send", {}), () => valid("__proto__", {}),
  ]) await assert.rejects(action(), CapabilityDeniedError);
  assert.equal(calls, 0);
});

test("tool registry is copied at creation and rejects duplicate names", async () => {
  let calls = 0;
  const tool = { name: "leads", connector: "second-shift", resource: "leads", action: "read", run: () => { calls++; } };
  const dispatch = createBoxDispatcher(identity, [tool], () => [grant], () => 1000);
  tool.action = "send";
  await dispatch("leads", {});
  assert.equal(calls, 1);
  assert.throws(() => createBoxDispatcher(identity, [tool, tool], () => [], () => 1000), /duplicate/);
});

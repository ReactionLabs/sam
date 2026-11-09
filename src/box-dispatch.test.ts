import test from "node:test";
import assert from "node:assert/strict";
import { createBoxDispatcher } from "./box-dispatch.js";
import { CapabilityDeniedError } from "./box-tool-gateway.js";
import type { CapabilityGrant } from "./box-capabilities.js";

const identity = { ownerId: "owner-a", instanceId: "sam-a", tenantId: "tenant-a" };
const permission = { ...identity, connector: "second-shift", resource: "leads", action: "read" };
const grant: CapabilityGrant = { ...permission, expiresAt: 2000 };

test("authorized read receives trusted identity and never uses model-supplied scope", async () => {
  let calls = 0;
  const dispatch = createBoxDispatcher(identity, [
    { name: "leads", connector: "second-shift", resource: "leads", action: "read", run: (args, trusted) => { calls++; return { args, trusted }; } },
  ], () => [grant], () => 1000);
  const result = await dispatch("leads", { query: "recent" });
  assert.deepEqual(result, { args: { query: "recent" }, trusted: identity });
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


test("model cannot override owner, instance or tenant through nested arguments", async () => {
  let calls = 0;
  const dispatch = createBoxDispatcher(identity, [
    { name: "leads", connector: "second-shift", resource: "leads", action: "read", run: () => { calls++; } },
  ], () => [grant], () => 1000);
  const forbidden = [
    { tenantId: "tenant-b" },
    { owner_id: "owner-b" },
    { filter: { instanceId: "sam-b" } },
    [{ payload: { tenant_id: "tenant-b" } }],
    JSON.parse('{"__proto__":{"isAdmin":true}}'),
  ];
  for (const args of forbidden) await assert.rejects(dispatch("leads", args), CapabilityDeniedError);
  assert.equal(calls, 0);
  await dispatch("leads", { filter: { stage: "new" } });
  assert.equal(calls, 1);
});

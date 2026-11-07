import test from "node:test";
import assert from "node:assert/strict";
import { authorizeMcpTool, assertJsonToolArguments } from "./mcp-policy.js";

const advertised = [
  { name: "secondshift.leads.list" },
  { name: "secondshift.leads.delete" },
];
const allowed = new Set(["secondshift.leads.list"]);

test("MCP permissions are exact, explicit, and default-deny", () => {
  assert.deepEqual(authorizeMcpTool("secondshift.leads.list", advertised, allowed, true),
    { allowed: true, tool: "secondshift.leads.list" });
  for (const name of ["secondshift.leads.delete", "secondshift.leads.list.extra", "secondshift.*", "unknown"]) {
    assert.equal(authorizeMcpTool(name, advertised, allowed, true).allowed, false);
  }
  assert.deepEqual(authorizeMcpTool("secondshift.leads.list", advertised, allowed, false),
    { allowed: false, reason: "untrusted-server" });
  assert.deepEqual(authorizeMcpTool("secondshift.leads.list", [advertised[0], advertised[0]], allowed, true),
    { allowed: false, reason: "duplicate-tool" });
  assert.equal(authorizeMcpTool("", advertised, allowed, true).allowed, false);
});

test("MCP argument validation rejects cycles, special objects, and unsafe values", () => {
  assert.deepEqual(assertJsonToolArguments({ limit: 10, filters: ["new", null] }), { limit: 10, filters: ["new", null] });
  for (const value of [null, [], new Date(), { limit: Infinity }, { invalid: undefined }, { nested: () => 1 }]) {
    assert.throws(() => assertJsonToolArguments(value));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => assertJsonToolArguments(cycle), /cycle/);
  assert.throws(() => assertJsonToolArguments(JSON.parse('{"__proto__":1}')), /forbidden key/);
});

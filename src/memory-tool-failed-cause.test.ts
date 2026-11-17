import test from "node:test";
import assert from "node:assert/strict";
import { memoryToolFailureError } from "./memory-tool.js";

// The memory-tool dispatch failure census (sprint 2026-11-17):
// the dispatch catch returned error.message alone, so a tool
// failure that arrived wrapped (the common shape: a store or
// network call under a generic wrapper) reached the model with
// no diagnosis. memoryToolFailureError composes through
// errorReason; these tests pin the cause in, the plain cases
// byte-identical, and bot-token-shaped segments out.

function dnsErr(): Error {
  const cause = new Error("getaddrinfo ENOTFOUND models.invalid") as Error & { code?: string };
  cause.code = "ENOTFOUND";
  return new Error("fetch failed", { cause });
}

test("memoryToolFailureError names the wrapped cause", () => {
  assert.equal(memoryToolFailureError(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("memoryToolFailureError appends an errno riding on the cause", () => {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1:9") as Error & { code?: string };
  cause.code = "ECONNREFUSED";
  assert.equal(memoryToolFailureError(new Error("request failed", { cause })), "request failed: connect ECONNREFUSED 127.0.0.1:9");
});

test("memoryToolFailureError keeps a causeless error byte-identical and a non-Error on the label", () => {
  assert.equal(memoryToolFailureError(new Error("plain failure")), "plain failure");
  assert.equal(memoryToolFailureError("boom"), "Tool failed");
  assert.equal(memoryToolFailureError(null), "Tool failed");
});

test("memoryToolFailureError redacts a bot-token-shaped segment", () => {
  const token = "123456789:" + "A".repeat(35);
  const reason = memoryToolFailureError(new Error("request to https://api.telegram.org/bot" + token + "/sendMessage failed"));
  assert.match(reason, /bot<redacted>/);
  assert.ok(!reason.includes(token));
});

import test from "node:test";
import assert from "node:assert/strict";
import { childToolFailureError } from "./subagents.js";

// Child tool failures carry their cause (gap found 2026-11-17,
// hourly run 07:04 EST): runChild's dispatch catch in
// subagents.ts took error.message alone for an Error and the
// bare "Tool failed" label for a non-Error, discarding
// error.cause, so a child's tool dying on transport or a store
// death carrying an errno-style code read back to the child
// model as the wrapper alone - and the tool result is the only
// record of that death. The error now composes through
// errorReason (the 04:04 bridge seam) via
// childToolFailureError: the prefix stays, the reason follows
// it, a non-Error throw keeps String(error), no bot token
// leaks, and the tool's arguments never enter the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND store.invalid"), { code: "ENOTFOUND" }),
});

test("a child tool failure reason names the cause behind the wrapper", () => {
  assert.equal(childToolFailureError(dnsErr()), "Tool failed: fetch failed: getaddrinfo ENOTFOUND store.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(childToolFailureError(err), "Tool failed: fetch failed: read (ECONNRESET)");
});

test("an errno code riding on the error itself is appended when the message omits it", () => {
  const err = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
  assert.equal(childToolFailureError(err), "Tool failed: unable to open database file (SQLITE_CANTOPEN)");
});

test("causeless errors surface their message after the prefix; a non-Error throw keeps String(error)", () => {
  assert.equal(childToolFailureError(new Error("database is locked")), "Tool failed: database is locked");
  assert.equal(childToolFailureError("plain string failure"), "Tool failed: plain string failure");
});

test("no bot token leaks through a child tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = childToolFailureError(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a child tool failure reason is built from the error alone, never the tool's arguments", () => {
  const err = new Error("connection refused");
  const reason = childToolFailureError(err);
  assert.equal(reason, "Tool failed: connection refused");
  assert.equal(reason.includes("secret prompt"), false);
});

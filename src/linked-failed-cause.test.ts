import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { createLink } from "./links.js";
import { executeOwnToolAsync, linkedExchangeFailureError } from "./own-tools.js";

// Linked exchange failures carry their cause (gap found
// 2026-11-17, hourly run 03:04 EST): the sam_ask_linked
// catch bound no error at all and returned {error:"Linked
// exchange failed"} for every death of the linked profile's
// turn, discarding even the message, let alone the
// transport cause behind the "fetch failed" wrapper. The
// tool result is the only record of the death and the
// asking model is the voice that reports it, so the error
// now composes through errorReason (the 04:04 bridge seam)
// via linkedExchangeFailureError: the prefix stays, the
// reason follows it, a non-Error throw keeps String(error),
// no bot token leaks, and the asked message never enters
// the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a linked exchange failure reason names the transport cause behind the wrapper", () => {
  assert.equal(linkedExchangeFailureError(dnsErr()), "Linked exchange failed: fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(linkedExchangeFailureError(err), "Linked exchange failed: fetch failed: read (ECONNRESET)");
});

test("causeless errors surface their message after the prefix; a non-Error throw keeps String(error)", () => {
  assert.equal(linkedExchangeFailureError(new Error("Model not configured")), "Linked exchange failed: Model not configured");
  assert.equal(linkedExchangeFailureError("plain string failure"), "Linked exchange failed: plain string failure");
});

test("no bot token leaks through a linked exchange failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = linkedExchangeFailureError(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

function seededLink(root: string): void {
  const db = new ChatStore(root);
  try { db.createAgent("alex", "A."); db.createAgent("blair", "B."); } finally { db.close(); }
  createLink(root, "project", ["alex", "blair"]);
}

test("a linked turn dying on transport hands the asking model the cause, and the guard releases for the next ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-linked-cause-"));
  try {
    seededLink(root);
    const failing = async (): Promise<string> => { throw dnsErr(); };
    const failed = await executeOwnToolAsync(root, "alex", "sam_ask_linked", { profile: "blair", message: "What is the secret launch date?" }, failing) as { error?: string };
    assert.equal(failed.error, "Linked exchange failed: fetch failed: getaddrinfo ENOTFOUND models.invalid");
    assert.equal(failed.error?.includes("secret launch date"), false, "the asked message never enters the error");
    const working = async (_chatId: string, content: string): Promise<string> => "reply to: " + content;
    const ok = await executeOwnToolAsync(root, "alex", "sam_ask_linked", { profile: "blair", message: "Draft the launch plan?" }, working) as { from?: string; reply?: string; error?: string };
    assert.equal(ok.error, undefined, "the in-flight guard released after the failure");
    assert.equal(ok.from, "blair");
    assert.match(ok.reply ?? "", /reply to: \[alex\] Draft the launch plan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a linked turn dying on a plain error hands the asking model its message", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-linked-cause-"));
  try {
    seededLink(root);
    const failing = async (): Promise<string> => { throw new Error("Model not configured"); };
    const failed = await executeOwnToolAsync(root, "alex", "sam_ask_linked", { profile: "blair", message: "Hello?" }, failing) as { error?: string };
    assert.equal(failed.error, "Linked exchange failed: Model not configured");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

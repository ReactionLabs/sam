import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOwnTool, chatToolFailureError } from "./own-tools.js";
import { ChatStore } from "./chats.js";

// Sync chat-family failures carry their cause (gap found
// 2026-11-17, hourly run 06:04 EST): the inner catches for
// sam_search_chats, sam_manage_chats, and sam_open_loop in
// executeOwnToolInner returned the bare message for an Error
// and String(e) for a non-Error, discarding error.cause and
// any errno-style code riding on the error itself. The tool
// result is the only record of the death and the model
// reading it is the voice that reports it, so each catch now
// composes through errorReason (the 04:04 bridge seam) via
// chatToolFailureError: no prefix is added (the error was the
// message alone), causeless errors read byte-identically, a
// non-Error throw keeps String(error), no bot token leaks,
// and the tool's arguments never enter the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND store.invalid"), { code: "ENOTFOUND" }),
});

test("a chat tool failure reason names the cause behind the wrapper", () => {
  assert.equal(chatToolFailureError(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND store.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(chatToolFailureError(err), "fetch failed: read (ECONNRESET)");
});

test("causeless errors surface their plain message; a non-Error throw keeps String(error)", () => {
  assert.equal(chatToolFailureError(new Error("database is locked")), "database is locked");
  assert.equal(chatToolFailureError("plain string failure"), "plain string failure");
});

test("no bot token leaks through a chat tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = chatToolFailureError(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a chat search dying on a planted store hands the model the composed reason, not the bare message", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-chat-cause-"));
  try {
    // A directory where the chats database file belongs: the
    // store cannot open, and the death carries a code the bare
    // message alone would not name in full.
    mkdirSync(join(root, ".sam", "chats.db"), { recursive: true });
    const failed = executeOwnTool(root, "sam", "sam_search_chats", { query: "the secret query wording" }) as { error?: string };
    assert.ok(failed.error, "the dispatch returned an error");
    assert.match(failed.error ?? "", /unable to open|not a database|directory/i);
    assert.equal((failed.error ?? "").includes("secret query wording"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy chat search is untouched by the failure seam", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-chat-cause-"));
  try {
    const cs = new ChatStore(root);
    const chat = cs.create("cortado decision");
    cs.add(chat.id, "user", "we picked the cortado");
    cs.close();
    const ok = executeOwnTool(root, "sam", "sam_search_chats", { query: "cortado" }) as { error?: string; hits?: unknown[] };
    assert.equal(ok.error, undefined);
    assert.ok((ok.hits ?? []).length >= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

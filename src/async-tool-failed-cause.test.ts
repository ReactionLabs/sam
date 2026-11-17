import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOwnToolAsync, asyncToolFailureError } from "./own-tools.js";
import { ChatStore } from "./chats.js";

// Async tool failures carry their cause (gap found 2026-11-17,
// hourly run 05:04 EST): the inner catches in
// executeOwnToolAsyncInner returned the bare message for an
// Error and a bare label for a non-Error (search, handoff,
// spawn, orchestrate, coding, parallel, reach, organize),
// and sam_code / sam_brief / sam_senses returned the message
// alone with no label at all - every one discarding
// error.cause. The tool result is the only record of the
// death and the model reading it is the voice that reports
// it, so each catch now keeps its own prefix and composes
// the reason through errorReason (the 04:04 bridge seam) via
// asyncToolFailureError: the prefix stays, the reason follows
// it, a non-Error throw keeps String(error), no bot token
// leaks, and the tool's arguments never enter the error. The
// dispatch wrapper in both chat loops rides toolFailureError
// for anything escaping the dispatch itself.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND registry.invalid"), { code: "ENOTFOUND" }),
});

test("an async tool failure reason names the cause behind the wrapper", () => {
  assert.equal(asyncToolFailureError("Search failed", dnsErr()), "Search failed: fetch failed: getaddrinfo ENOTFOUND registry.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(asyncToolFailureError("Reach failed", err), "Reach failed: fetch failed: read (ECONNRESET)");
});

test("causeless errors surface their message after the prefix; a non-Error throw keeps String(error)", () => {
  assert.equal(asyncToolFailureError("Handoff failed", new Error("database is locked")), "Handoff failed: database is locked");
  assert.equal(asyncToolFailureError("Handoff failed", "plain string failure"), "Handoff failed: plain string failure");
});

test("no bot token leaks through an async tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = asyncToolFailureError("Orchestration failed", err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a handoff dying in the async dispatch hands the model the store cause, not the bare label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-async-cause-"));
  const fileRoot = join(dir, "not-a-dir");
  try {
    writeFileSync(fileRoot, "hello");
    const failed = await executeOwnToolAsync(fileRoot, "sam", "sam_handoff_task", { prompt: "do the thing" }, undefined, "chat-1") as { error?: string };
    assert.ok(failed.error, "the dispatch returned an error");
    assert.notEqual(failed.error, "Handoff failed");
    assert.match(failed.error ?? "", /^Handoff failed: /);
    assert.match(failed.error ?? "", /ENOTDIR|not a directory/);
    assert.equal((failed.error ?? "").includes("do the thing"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a healthy async tool call is untouched by the failure seam", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-async-cause-"));
  try {
    const cs = new ChatStore(root);
    const chat = cs.create("handoff proof");
    cs.close();
    const ok = await executeOwnToolAsync(root, "sam", "sam_handoff_task", { prompt: "do the thing" }, undefined, chat.id) as { status?: string; error?: string };
    assert.equal(ok.error, undefined);
    assert.equal(ok.status, "queued");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

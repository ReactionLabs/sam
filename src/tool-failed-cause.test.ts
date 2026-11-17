import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOwnTool, toolFailureError } from "./own-tools.js";

// Sync tool failures carry their cause (gap found 2026-11-17,
// hourly run 04:04 EST): the sync dispatch's outer catch in
// executeOwnToolInner bound no error at all and returned
// {error:"Tool failed"} for every death outside the inner
// per-tool catches - the memory store, the workspace
// filesystem reads, and the artifact store ride that catch -
// discarding even the message, let alone the cause behind it.
// The tool result is the only record of the death and the
// model reading it is the voice that reports it, so the error
// now composes through errorReason (the 04:04 bridge seam)
// via toolFailureError: the prefix stays, the reason follows
// it, a non-Error throw keeps String(error), no bot token
// leaks, and the tool's arguments never enter the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND store.invalid"), { code: "ENOTFOUND" }),
});

test("a sync tool failure reason names the cause behind the wrapper", () => {
  assert.equal(toolFailureError(dnsErr()), "Tool failed: fetch failed: getaddrinfo ENOTFOUND store.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(toolFailureError(err), "Tool failed: fetch failed: read (ECONNRESET)");
});

test("causeless errors surface their message after the prefix; a non-Error throw keeps String(error)", () => {
  assert.equal(toolFailureError(new Error("database is locked")), "Tool failed: database is locked");
  assert.equal(toolFailureError("plain string failure"), "Tool failed: plain string failure");
});

test("no bot token leaks through a sync tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = toolFailureError(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a workspace read dying in the sync dispatch hands the model the filesystem cause, not the bare label", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tool-cause-"));
  try {
    writeFileSync(join(root, "plain.txt"), "hello");
    const failed = executeOwnTool(root, "sam", "sam_workspace_list", { path: "plain.txt" }) as { error?: string };
    assert.ok(failed.error, "the dispatch returned an error");
    assert.notEqual(failed.error, "Tool failed");
    assert.match(failed.error ?? "", /^Tool failed: /);
    assert.match(failed.error ?? "", /ENOTDIR|not a directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy sync tool call is untouched by the failure seam", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tool-cause-"));
  try {
    writeFileSync(join(root, "plain.txt"), "hello");
    const ok = executeOwnTool(root, "sam", "sam_workspace_list", { path: "." }) as { entries?: Array<{ name: string }>; error?: string };
    assert.equal(ok.error, undefined);
    assert.equal(ok.entries?.some((e) => e.name === "plain.txt"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyModel, verifyAndSaveSetup, readSetupRecord } from "./config-wizard.js";

// Verify failures carry their cause (gap found 2026-11-16,
// hourly run 06:04 EST, recorded as the next sibling; built
// 07:04 EST): verifyModel took err.message alone, so a
// `config verify --live` or first-run setup against an
// unreachable endpoint reported "Verification failed: fetch
// failed" and named nothing - DNS, connect, socket, and TLS
// failures all wore the same wrapper, with the real reason
// on error.cause. The reason now composes through errorReason
// (the 04:04 bridge seam).

function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog",
    SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "test-key",
    ...extra,
  };
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a transport failure's verify reason names its cause", async () => {
  const v = await verifyModel(configuredEnv(), async () => { throw dnsErr(); });
  assert.equal(v.ok, false);
  assert.equal(v.model, "MiniMax-M2.5");
  assert.equal(v.reason, "Verification failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("an errno code riding only on the cause is appended when the message omits it", async () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  const v = await verifyModel(configuredEnv(), async () => { throw err; });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "Verification failed: fetch failed: read (ECONNRESET)");
});

test("causeless errors read exactly as before", async () => {
  const http = await verifyModel(configuredEnv(), async () => { throw new Error("HTTP 401"); });
  assert.equal(http.reason, "Verification failed: HTTP 401");
  const bare = await verifyModel(configuredEnv(), async () => { throw new TypeError("fetch failed"); });
  assert.equal(bare.reason, "Verification failed: fetch failed");
  const nonError = await verifyModel(configuredEnv(), async () => { throw "plain string failure"; });
  assert.equal(nonError.reason, "Verification failed: plain string failure");
});

test("no bot token leaks through a verify reason", async () => {
  const url = "https://api.telegram.org/bot123456:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const v = await verifyModel(configuredEnv(), async () => { throw err; });
  assert.equal(v.reason.includes("AAE-secret_token"), false);
  assert.equal(v.reason.includes("123456"), false);
  assert.match(v.reason, /bot<redacted>/);
});

test("a failed setup verification names its cause and still saves nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-verify-cause-"));
  try {
    const bad = await verifyAndSaveSetup(root, configuredEnv(), async () => { throw dnsErr(); });
    assert.equal(bad.saved, null);
    assert.equal(bad.verify.ok, false);
    assert.equal(bad.verify.reason, "Verification failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

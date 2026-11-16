import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProbeError, probeAuth, readProbeStore } from "./auth-status.js";

// Probe verdicts carry their cause (gap found 2026-11-16,
// hourly run 06:04 EST): classifyProbeError took err.message
// alone, so an undici transport failure bucketed as network
// but persisted the bare "fetch failed" as its reason - the
// verdict `models status` reads back named nothing, and a
// signal riding only on error.cause could never move the
// bucket. The classifier now composes its text through
// errorReason (the 04:04 bridge seam).

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a transport failure's verdict names its cause", () => {
  const v = classifyProbeError(dnsErr());
  assert.equal(v.bucket, "network");
  assert.equal(v.reason, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  const v = classifyProbeError(err);
  assert.equal(v.bucket, "network");
  assert.equal(v.reason, "fetch failed: read (ECONNRESET)");
});

test("a cause-carried signal can move the bucket", () => {
  // The wrapper names nothing at all; only the cause says the
  // request timed out, so message-only classification read
  // "error" where the composed text reads "timeout".
  const err = new Error("Model request failed", { cause: new Error("The operation timed out after 30000ms") });
  const v = classifyProbeError(err);
  assert.equal(v.bucket, "timeout");
  assert.match(v.reason, /timed out/);
});

test("causeless errors classify and read exactly as before", () => {
  assert.deepEqual(classifyProbeError(new Error("Model request failed (HTTP 401)")), { bucket: "auth", reason: "Model request failed (HTTP 401)" });
  assert.deepEqual(classifyProbeError(new Error("HTTP 429 too many requests")), { bucket: "rate_limit", reason: "HTTP 429 too many requests" });
  assert.deepEqual(classifyProbeError(new TypeError("fetch failed")), { bucket: "network", reason: "fetch failed" });
  assert.deepEqual(classifyProbeError(new Error("something else entirely")), { bucket: "error", reason: "something else entirely" });
});

test("no bot token leaks through a probe verdict", () => {
  const url = "https://api.telegram.org/bot123456:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const v = classifyProbeError(err);
  assert.equal(v.reason.includes("AAE-secret_token"), false);
  assert.equal(v.reason.includes("123456"), false);
  assert.match(v.reason, /bot<redacted>/);
});

test("a probe run persists the cause-named verdict and status reads it back", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-probe-cause-"));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog",
      SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "test-key",
    };
    const run = await probeAuth(root, env, async () => { throw dnsErr(); });
    assert.equal(run.ok, false);
    const chat = run.results.find(r => r.target === "route:chat")!;
    assert.equal(chat.bucket, "network");
    assert.equal(chat.reason, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    const stored = readProbeStore(root);
    assert.equal(stored?.results.find(r => r.target === "route:chat")?.reason, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

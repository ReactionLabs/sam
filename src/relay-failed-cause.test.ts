import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayFailureReason, relayPrompt } from "./relay.js";
import { readActivity } from "./activity.js";

// Relay answer failures carry their cause (gap found
// 2026-11-16, hourly run 22:04 EST): relayPrompt's per-target
// catch took error.message alone over provider.complete, so a
// route dying on transport labeled its row with the bare
// "fetch failed" wrapper, which formatRelay renders as the
// FAILED line beside the other models' answers - the only
// record of that route's death. The reason now composes
// through errorReason (the 04:04 bridge seam) via
// relayFailureReason: causeless errors keep their plain
// message, a non-Error throw keeps String(error), no bot
// token leaks, and the prompt text never enters the error.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-relay-cause-")); }

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

const routes = [
  { provider: "openai", model: "gpt-4.1" },
  { provider: "minimax", model: "MiniMax-M2.5" },
];

test("a relay failure reason names the transport cause behind the wrapper", () => {
  assert.equal(relayFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(relayFailureReason(err), "fetch failed: read (ECONNRESET)");
});

test("causeless relay errors keep their plain message; a non-Error throw keeps String(error)", () => {
  assert.equal(relayFailureReason(new Error("Model request failed (HTTP 401)")), "Model request failed (HTTP 401)");
  assert.equal(relayFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a relay failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = relayFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a relay route dying on transport labels its row with the cause beside the surviving answer", async () => {
  const root = scratch();
  try {
    const result = await relayPrompt(root, "compare the secret widget", routes, {
      complete: async (target) => {
        if (target.provider === "minimax") throw dnsErr();
        return { content: "openai answer", usage: null };
      },
    });
    assert.equal(result.answers[0].ok, true);
    assert.equal(result.answers[1].ok, false);
    assert.equal(result.answers[1].error, "fetch failed: getaddrinfo ENOTFOUND models.invalid");
    assert.match(result.text, /FAILED: fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
    assert.match(result.text, /openai answer/);
    assert.equal((result.answers[1].error ?? "").includes("secret widget"), false, "the prompt text never enters the failure error");
    const lines = readActivity(root, 10).filter(l => l.kind === "relay");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /1\/2 answered/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a relay route dying on a causeless error reads byte-identically", async () => {
  const root = scratch();
  try {
    const result = await relayPrompt(root, "compare", routes, {
      complete: async (target) => {
        if (target.provider === "minimax") throw new Error("Model request failed (HTTP 401)");
        return { content: "openai answer", usage: null };
      },
    });
    assert.equal(result.answers[1].error, "Model request failed (HTTP 401)");
    assert.match(result.text, /FAILED: Model request failed \(HTTP 401\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failoverSummary, runChatTurn } from "./agent-turn.js";
import { addProvider } from "./providers.js";
import { addFallbackRoute } from "./failover.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";

// Failover hop lines carry their cause (gap found 2026-11-16,
// hourly run 19:04 EST): agent-turn ledgered the hop's
// parenthesized reason from error.message alone, the last
// e.message-alone seam in the turn path, so a primary route
// dying on transport read "(Model network request failed)"
// and dropped the sanitized code-only cause the provider
// attached at 09:04. When the failover succeeds the hop line
// is the ONLY record of the first route's death (no
// turn-failed line is written for a rescued turn), so its
// blindness hid the cause entirely. The reason now composes
// through errorReason (the 04:04 bridge seam) via the
// exported failoverSummary; the eligibility check, the hop
// itself, the prefix, and the 160-char reason slice are
// untouched.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-failover-cause-")); }

const dnsCause = () => Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" });

test("a failover summary names the sanitized transport cause the provider attached", () => {
  const converted = new Error("Model network request failed", { cause: new Error("ENOTFOUND") });
  assert.equal(
    failoverSummary("12345678abcdef", "minimax/MiniMax-M2.5", "openai/gpt-4.1", converted),
    "Failover in chat 12345678: minimax/MiniMax-M2.5 -> openai/gpt-4.1 (Model network request failed: ENOTFOUND)",
  );
});

test("a failover summary names a raw fetch cause chain, code appended once", () => {
  const raw = new TypeError("fetch failed", { cause: dnsCause() });
  assert.equal(
    failoverSummary("12345678abcdef", "minimax/MiniMax-M2.5", "openai/gpt-4.1", raw),
    "Failover in chat 12345678: minimax/MiniMax-M2.5 -> openai/gpt-4.1 (fetch failed: getaddrinfo ENOTFOUND api.minimax.io)",
  );
});

test("causeless errors and plain strings read exactly as before", () => {
  assert.equal(
    failoverSummary("12345678abcdef", "minimax/MiniMax-M2.5", "openai/gpt-4.1", new Error("Unsafe model output")),
    "Failover in chat 12345678: minimax/MiniMax-M2.5 -> openai/gpt-4.1 (Unsafe model output)",
  );
  assert.equal(
    failoverSummary("12345678abcdef", "minimax/(none)", "openai/gpt-4.1", "Empty model response"),
    "Failover in chat 12345678: minimax/(none) -> openai/gpt-4.1 (Empty model response)",
  );
});

test("the 160-char reason slice still caps the parenthesized reason", () => {
  const summary = failoverSummary("12345678abcdef", "a/b", "c/d", new Error("x".repeat(500)));
  assert.equal(summary, "Failover in chat 12345678: a/b -> c/d (" + "x".repeat(160) + ")");
});

test("no bot token leaks through a failover summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new Error("Model network request failed", { cause: new Error("request to " + url + " failed") });
  const summary = failoverSummary("12345678abcdef", "a/b", "c/d", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

function env(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    SAM_ENGINE_BIN: "/nonexistent/claude",
    SAM_GOG_BIN: "/nonexistent/gog",
    SAM_MODEL_PROVIDER: "minimax",
    SAM_MODEL: "MiniMax-M2.5",
    MINIMAX_API_KEY: "test-minimax-key",
    OPENAI_API_KEY: "test-openai-key",
  };
}

function installEnv(next: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
  return saved;
}
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
}

test("a turn failing over on a transport death ledgers one hop line naming the cause, and no trace of the ask", async () => {
  const root = scratch();
  const saved = installEnv(env());
  const oldFetch = globalThis.fetch;
  try {
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" });
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("minimax")) throw new TypeError("fetch failed", { cause: dnsCause() });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fallback answer." } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const db = new ChatStore(root);
    const chat = db.create("Failover cause");
    db.close();
    const reply = await runChatTurn(root, chat.id, "my secret zebra phrase");
    assert.equal(reply, "Fallback answer.");
    const hops = readActivity(root, 50).filter(l => l.kind === "failover");
    assert.equal(hops.length, 1, "exactly one failover line for one hop");
    assert.match(hops[0].summary, /minimax\/MiniMax-M2\.5 -> openai\/gpt-4\.1/);
    assert.match(hops[0].summary, /Model connector network error: ENOTFOUND/);
    assert.doesNotMatch(hops[0].summary, /zebra/, "the person's message content never enters the hop line");
    assert.equal(readActivity(root, 50).filter(l => l.kind === "turn-failed").length, 0, "a rescued turn writes no turn-failed line - the hop line is the only record");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

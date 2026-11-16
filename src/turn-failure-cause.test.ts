import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnFailure, runChatTurn, turnFailureSummary } from "./agent-turn.js";
import { OpenAICompatibleProvider, transportCause } from "./openai-compatible.js";
import { ChatStore } from "./chats.js";

// Turn failures carry their cause (gap found 2026-11-16,
// hourly run 09:04 EST, scoped from the candidate the 08:04
// run recorded): turnFailureSummary took error.message alone,
// so a turn dying on a transport failure ledgered the bare
// wrapper and named nothing. The summary now composes through
// errorReason (the 04:04 bridge seam). The deeper half the
// scoping found: the provider converts TypeError transport
// failures into plain Errors and discarded the original error
// entirely (deliberately - network errors can contain
// secrets), so its conversions now attach a SANITIZED cause
// carrying only the errno-style codes from the original chain,
// never a message, a URL, or a body.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turncause-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a turn failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    turnFailureSummary("12345678-abcd", "chat", dnsErr()),
    "Turn failed in chat 12345678 (chat): fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    turnFailureSummary("12345678-abcd", "heartbeat", err),
    "Turn failed in chat 12345678 (heartbeat): fetch failed: read (ECONNRESET)",
  );
});

test("causeless errors and plain strings read exactly as before", () => {
  assert.equal(
    turnFailureSummary("12345678-abcd", "heartbeat", new Error("Unsafe model output")),
    "Turn failed in chat 12345678 (heartbeat): Unsafe model output",
  );
  assert.equal(
    turnFailureSummary("12345678-abcd", "chat", new Error("Model not configured")),
    "Turn failed in chat 12345678 (chat): Model not configured",
  );
  assert.equal(
    turnFailureSummary("12345678-abcd", "chat", "plain string failure"),
    "Turn failed in chat 12345678 (chat): plain string failure",
  );
});

test("no bot token leaks through a turn failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = turnFailureSummary("12345678-abcd", "chat", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("transportCause extracts only codes, never messages", () => {
  const cause = transportCause(dnsErr());
  assert.equal(cause?.message, "ENOTFOUND");
  assert.equal(cause?.message.includes("getaddrinfo"), false);
  assert.equal(cause?.message.includes("api.minimax.io"), false);
  assert.equal(transportCause(new TypeError("fetch failed")), undefined);
  assert.equal(transportCause(new Error("plain")), undefined);
  const multi = transportCause(new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
  }));
  assert.equal(multi?.message, "ECONNREFUSED");
});

test("a provider transport death rejects with the plain message and a code-only cause", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw dnsErr(); };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    await assert.rejects(
      () => provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Model network request failed");
        const cause = (err as { cause?: unknown }).cause;
        assert.ok(cause instanceof Error);
        assert.equal(cause.message, "ENOTFOUND");
        assert.equal(String(cause.message).includes("api.minimax.io"), false);
        return true;
      },
    );
  } finally { globalThis.fetch = oldFetch; }
});

test("a turn dying on a provider transport failure ledgers the code and nothing secret-shaped", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    globalThis.fetch = async () => { throw dnsErr(); };
    const store = new ChatStore(root);
    const chat = store.create("Transport death");
    store.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "my secret zebra phrase"), /Model connector network error/);
    const failures = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(failures.length, 1, "exactly one failure line for one dead turn");
    assert.match(failures[0].summary, /Model connector network error: ENOTFOUND/);
    assert.doesNotMatch(failures[0].summary, /getaddrinfo/, "the sanitized cause carries the code only, never the original message");
    assert.doesNotMatch(failures[0].summary, /api\.minimax\.io/, "no endpoint text enters the failure line");
    assert.doesNotMatch(failures[0].summary, /zebra/, "the person's message content never enters the failure line");
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordTurnFailure ledgers a cause-carrying failure under the chat's profile", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    store.createAgent("trading", "Watch the stack.");
    const chat = store.create("Stack watch", "trading");
    store.close();
    recordTurnFailure(root, chat.id, "heartbeat", dnsErr());
    const lines = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "trading");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRateLimitEpisode,
  isRateLimitError,
  openRateLimitEpisode,
  rateLimitEpisode,
  rateLimitStatus,
  RATE_LIMIT_GRACE_MESSAGE,
} from "./rate-limit.js";
import { runChatTurn } from "./agent-turn.js";
import { ChatStore } from "./chats.js";
import { addChannel } from "./channels.js";
import { handleTelegramUpdate, loadBridgeState, type SamClient } from "./telegram.js";

// Rate-limit grace (Dip via main, 2026-11-12 ~20:25 EST): when the
// provider cap maxed out, SAM answered Dip on Telegram with a raw
// platform failure. These tests pin the spec: only rate-limit /
// quota failures classify, the first capped chat turn answers
// with the one plain grace message (zero platform error text),
// a second capped message produces silence (stored, unanswered),
// the first successful model call closes the episode so the next
// cap speaks again, other errors keep their old handling, machine
// routes and visitor turns never take the grace path, and the
// Telegram bridge sends nothing for a silent reply.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-ratelimit-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

test("isRateLimitError takes only the rate-limit / quota class", () => {
  // The three provider shapes for a 429, as the turn boundary sees them.
  assert.equal(isRateLimitError(new Error("Model request failed (HTTP 429)")), true);
  assert.equal(isRateLimitError(new Error("Model connector request failed (HTTP 429)")), true);
  assert.equal(isRateLimitError(new Error("Model tool request failed (HTTP 429)")), true);
  assert.equal(isRateLimitError(new Error("All models are temporarily rate-limited")), true);
  assert.equal(isRateLimitError(new Error("Too many requests")), true);
  assert.equal(isRateLimitError(new Error("insufficient_quota: quota exceeded for this billing period")), true);
  assert.equal(isRateLimitError(new Error("Quota exhausted")), true);
  // Everything else keeps its current handling.
  assert.equal(isRateLimitError(new Error("Model request failed (HTTP 401)")), false);
  assert.equal(isRateLimitError(new Error("Model request failed (HTTP 402)")), false, "billing without quota wording is not the grace class");
  assert.equal(isRateLimitError(new Error("Model request timed out")), false);
  assert.equal(isRateLimitError(new Error("Model network request failed")), false);
  assert.equal(isRateLimitError(new Error("Empty model response")), false);
  assert.equal(isRateLimitError(new Error("Unsafe model output")), false);
  assert.equal(isRateLimitError(new Error("Model not configured")), false);
});

test("the grace message is the approved wording, with zero platform error text", () => {
  assert.equal(
    RATE_LIMIT_GRACE_MESSAGE,
    "Heads up, I am out of tokens right now, so I cannot think straight until the cap resets. Anything you send is saved, and I will pick it back up when I am back.",
  );
  assert.doesNotMatch(RATE_LIMIT_GRACE_MESSAGE, /HTTP|429|Something went wrong|error code|try \/new/i);
});

test("the episode opens once, reads back, closes on success, and a pure read creates nothing", () => {
  const root = scratch();
  try {
    assert.equal(rateLimitEpisode(root), null);
    assert.deepEqual(rateLimitStatus(root), { open: false, since: null });
    assert.equal(existsSync(join(root, ".sam", "rate-limit.db")), false, "a pure read created no store");
    assert.equal(closeRateLimitEpisode(root), false);
    assert.equal(openRateLimitEpisode(root, "chat-1"), true, "the first open speaks");
    assert.equal(openRateLimitEpisode(root, "chat-2"), false, "a second open is the silence signal, even from another chat - the cap is account-wide");
    const episode = rateLimitEpisode(root);
    assert.equal(episode?.chatId, "chat-1");
    assert.deepEqual(rateLimitStatus(root), { open: true, since: episode?.since ?? null });
    assert.equal(closeRateLimitEpisode(root), true);
    assert.equal(rateLimitEpisode(root), null);
    assert.equal(openRateLimitEpisode(root), true, "after a close, a new episode can open and speak again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// One full chat-path scenario against a stubbed provider, the
// turn-failure.test.ts harness pattern: 429, 429, success, 429.
test("a capped chat turn speaks once, then stays silent, then speaks again after a success", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    const store = new ChatStore(root);
    const chat = store.create("Capped");
    store.close();

    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    const first = await runChatTurn(root, chat.id, "are you there?");
    assert.equal(first, RATE_LIMIT_GRACE_MESSAGE, "the first capped message gets the grace message, not the raw HTTP 429");
    assert.doesNotMatch(first, /429|HTTP|Something went wrong/);

    const second = await runChatTurn(root, chat.id, "hello? again");
    assert.equal(second, "", "the second capped message produces silence");

    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["are you there?", "hello? again"], "both capped messages are still stored");
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [RATE_LIMIT_GRACE_MESSAGE], "exactly one assistant reply exists - the grace message");
    assert.equal(rateLimitStatus(root).open, true);
    assert.equal(ledger(root).filter(l => l.kind === "rate-limit").length, 2, "open + silent are both ledgered, counts only");
    assert.equal(ledger(root).filter(l => l.kind === "turn-failed").length, 0, "a capped turn is not a failed turn");

    // The cap resets: a real answer closes the episode.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "Back now." } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
    const third = await runChatTurn(root, chat.id, "and now?");
    assert.equal(third, "Back now.");
    assert.equal(rateLimitStatus(root).open, false, "the first successful model call closed the episode");

    // A fresh cap is a fresh episode: it speaks again.
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    const fourth = await runChatTurn(root, chat.id, "there?");
    assert.equal(fourth, RATE_LIMIT_GRACE_MESSAGE);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-rate-limit failure keeps its old handling, and machine + visitor turns never take the grace path", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    const store = new ChatStore(root);
    const chat = store.create("Auth death");
    const visitorChat = store.create("Door chat", null, { visitor: true });
    store.close();

    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    await assert.rejects(() => runChatTurn(root, chat.id, "hello"), /HTTP 401/);
    assert.equal(ledger(root).filter(l => l.kind === "turn-failed").length, 1, "the 401 still ledgers as a failed turn");
    assert.equal(rateLimitStatus(root).open, false);

    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    await assert.rejects(() => runChatTurn(root, chat.id, "tick", { route: "heartbeat" }), /HTTP 429/, "a heartbeat turn keeps its throw + job-failed isolation");
    await assert.rejects(() => runChatTurn(root, visitorChat.id, "hi there"), /HTTP 429/, "a visitor turn never hears about the owner's token state");
    assert.equal(rateLimitStatus(root).open, false, "neither machine nor visitor turns open an episode");
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Telegram bridge sends nothing for a silent (empty) reply", async () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    const sent: Array<{ chat: number; text: string }> = [];
    const sam: SamClient = {
      ensureChat: async () => "sam-chat-1",
      postMessage: async (_id, content) => (content === "again" ? "" : "Reply to: " + content),
    };
    const state = loadBridgeState(root);
    const deps = { channel, sam, send: async (chat: number, text: string) => { sent.push({ chat, text }); }, state, root };
    await handleTelegramUpdate(deps, { update_id: 1, message: { chat: { id: 555 }, from: { id: 111 }, text: "stack health?" } });
    assert.deepEqual(sent, [{ chat: 555, text: "Reply to: stack health?" }]);
    await handleTelegramUpdate(deps, { update_id: 2, message: { chat: { id: 555 }, from: { id: 111 }, text: "again" } });
    assert.equal(sent.length, 1, "the capped follow-up produced no Telegram message at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

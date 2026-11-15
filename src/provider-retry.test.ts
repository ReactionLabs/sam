import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  isProviderOverloadError,
  isTransientProviderError,
  providerHttpStatus,
  PROVIDER_OVERLOAD_MESSAGE,
  TRANSIENT_RETRY_DELAYS_MS,
  TRANSIENT_RETRY_LIMIT,
} from "./provider-retry.js";
import { RATE_LIMIT_GRACE_MESSAGE, rateLimitStatus } from "./rate-limit.js";
import { OWNER_TURN_DEADLINE_MS } from "./turn-control.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { runChatTurn, TURN_FAILURE_MESSAGE } from "./agent-turn.js";
import { ChatStore } from "./chats.js";
import { awaitChatQueue, enqueueChatMessage, listChatQueue } from "./chat-queue.js";

// Provider overload resilience (Dip live defect, 2026-11-15):
// a MiniMax 529 ate the owner's turn on the spot, twice, and
// his only signal was a "failed" tag. These tests pin the fix:
// transient statuses (429 + 5xx) retry in place with bounded
// backoff inside the turn; a persistent 5xx closes with the
// plain outage note in the chat while the queue's failed
// marking stays exactly as it was; a 429 still belongs to the
// rate-limit grace and never sees the note; a non-transient
// status never retries; and a Reset / deadline abort cancels a
// pending retry immediately.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-provider-retry-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

function installEnv(): () => void {
  const saved = { ...process.env };
  process.env.SAM_MODEL_PROVIDER = "minimax";
  process.env.SAM_MODEL = "MiniMax-M2.5";
  process.env.MINIMAX_API_KEY = "test-key";
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

test("the classifiers split transient, overload, and neither by status alone", () => {
  // The three provider shapes, as the turn boundary sees them.
  for (const shape of ["Model request failed", "Model connector request failed", "Model tool request failed"]) {
    assert.equal(providerHttpStatus(new Error(shape + " (HTTP 529)")), 529);
    assert.equal(isTransientProviderError(new Error(shape + " (HTTP 529)")), true);
    assert.equal(isProviderOverloadError(new Error(shape + " (HTTP 529)")), true);
    assert.equal(isTransientProviderError(new Error(shape + " (HTTP 503)")), true);
    assert.equal(isProviderOverloadError(new Error(shape + " (HTTP 500)")), true);
    // 429 is transient (it retries) but it is NOT the overload
    // class: the rate-limit grace owns it, the note never fires.
    assert.equal(isTransientProviderError(new Error(shape + " (HTTP 429)")), true);
    assert.equal(isProviderOverloadError(new Error(shape + " (HTTP 429)")), false);
    // Non-transient statuses never retry and never note.
    for (const status of [400, 401, 403, 404]) {
      assert.equal(isTransientProviderError(new Error(shape + " (HTTP " + status + ")")), false);
      assert.equal(isProviderOverloadError(new Error(shape + " (HTTP " + status + ")")), false);
    }
  }
  // Errors with no status are not this module's class at all.
  for (const message of ["Model request timed out", "Model connector network error", "Model network request failed", "Empty model response", "Unsafe model output", "Model not configured"]) {
    assert.equal(providerHttpStatus(new Error(message)), null);
    assert.equal(isTransientProviderError(new Error(message)), false);
    assert.equal(isProviderOverloadError(new Error(message)), false);
  }
});

test("the retry budget is bounded and the note is the approved plain wording", () => {
  assert.equal(TRANSIENT_RETRY_LIMIT, 3);
  assert.deepEqual([...TRANSIENT_RETRY_DELAYS_MS], [500, 1000, 2000]);
  const totalBackoff = TRANSIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(totalBackoff < OWNER_TURN_DEADLINE_MS / 10, "the whole backoff schedule stays far inside the interactive deadline");
  assert.equal(
    PROVIDER_OVERLOAD_MESSAGE,
    "Heads up, the model I think with is overloaded right now and could not answer. Your message is saved here and nothing is lost. Give it a short moment and send again, and I will pick it back up.",
  );
  assert.doesNotMatch(PROVIDER_OVERLOAD_MESSAGE, /HTTP|529|error code|Something went wrong|platform/i);
  assert.notEqual(PROVIDER_OVERLOAD_MESSAGE, RATE_LIMIT_GRACE_MESSAGE, "the overload note and the token grace are different words for different failures");
});

test("a turn rides out 529, 529, then answers - one saved answer, the retries ledgered", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Artifact ask");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls <= 2) return new Response("overloaded", { status: 529 });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "One artifact, coming up." } }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const reply = await runChatTurn(root, chat.id, "Can u make an artifact?");
    assert.equal(reply, "One artifact, coming up.");
    assert.equal(calls, 3, "two transient failures, one success - no more, no fewer");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["Can u make an artifact?"]);
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), ["One artifact, coming up."], "exactly one saved answer");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "provider-retry").length, 2, "each retry ledgered one line");
    assert.equal(lines.filter(l => l.kind === "provider-overload").length, 0);
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 0, "a recovered turn is not a failed turn");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persistent 529 closes with the note in the chat and the turn still fails", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Artifact ask");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("overloaded", { status: 529 }); };
    await assert.rejects(() => runChatTurn(root, chat.id, "Can u make an artifact?"), /HTTP 529/, "the failure still surfaces - the queue's failed marking rides this throw");
    assert.equal(calls, 1 + TRANSIENT_RETRY_LIMIT, "the first attempt plus the bounded retries, then it gives up");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["Can u make an artifact?"], "the owner's message is saved");
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [PROVIDER_OVERLOAD_MESSAGE], "exactly one assistant row - the note, no duplicate answer");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "provider-retry").length, TRANSIENT_RETRY_LIMIT);
    assert.equal(lines.filter(l => l.kind === "provider-overload").length, 1);
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 1);
    assert.equal(rateLimitStatus(root).open, false, "an overload never opens the rate-limit episode");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("through the queue, a persistent 529 marks the message failed and the note is in the chat", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Queued artifact ask");
    store.close();
    globalThis.fetch = async () => new Response("overloaded", { status: 529 });
    const queued = enqueueChatMessage(root, { chatId: chat.id, content: "Can u make an artifact?", source: "dashboard" });
    await awaitChatQueue(root, chat.id, 60_000);
    const item = listChatQueue(root, chat.id).find(i => i.id === queued.id);
    assert.equal(item?.status, "failed", "the queue's failed marking is exactly as it was - marked failed, not lost");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [PROVIDER_OVERLOAD_MESSAGE], "the owner reads the note, not a bare failed tag");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "message-failed").length, 1);
    assert.equal(lines.filter(l => l.kind === "provider-overload").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persistent 429 still belongs to the grace path after its retries - never the overload note", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Capped ask");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("rate limited", { status: 429 }); };
    const reply = await runChatTurn(root, chat.id, "are you there?");
    assert.equal(reply, RATE_LIMIT_GRACE_MESSAGE, "quota exhaustion speaks the grace message, not the overload note");
    assert.equal(calls, 1 + TRANSIENT_RETRY_LIMIT, "the 429 retried first - a per-minute limit could have cleared - then the grace took it");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [RATE_LIMIT_GRACE_MESSAGE], "no overload note anywhere in the chat");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "provider-overload").length, 0);
    assert.equal(lines.filter(l => l.kind === "provider-retry").length, TRANSIENT_RETRY_LIMIT);
    assert.equal(rateLimitStatus(root).open, true, "the episode opened, as it always has");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 400 fails immediately - no retry, no overload note", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Bad request");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("bad request", { status: 400 }); };
    await assert.rejects(() => runChatTurn(root, chat.id, "hello"), /HTTP 400/);
    assert.equal(calls, 1, "a non-transient status is never retried");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    // Chat trust sprint (2026-11-15): the overload NOTE stays
    // overload-only, but a failed owner send is never silent -
    // the chat carries the one general failure sentence instead.
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [TURN_FAILURE_MESSAGE], "no overload note - the general failure note instead");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "provider-retry").length, 0);
    assert.equal(lines.filter(l => l.kind === "provider-overload").length, 0);
    assert.equal(lines.filter(l => l.kind === "turn-failure-note").length, 1);
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an abort during the backoff cancels the pending retry at once", async () => {
  let hits = 0;
  const retries: Array<{ status: number; retry: number }> = [];
  const server = createServer((_req, res) => { hits++; res.writeHead(529); res.end("overloaded"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const controller = new AbortController();
    provider.abortSignal = controller.signal;
    provider.onProviderRetry = info => { retries.push({ status: info.status, retry: info.retry }); };
    const started = Date.now();
    setTimeout(() => controller.abort(), 120);
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /HTTP 529/, "the original provider error surfaces, so the turn layer's control checks close the turn");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, "the abort cut the backoff short instead of waiting out the schedule (took " + elapsed + "ms)");
    assert.equal(hits, 1, "no retry fired into an aborted turn");
    assert.deepEqual(retries, [{ status: 529, retry: 1 }], "the one scheduled retry was reported before it was cancelled");
  } finally { server.close(); await once(server, "close"); }
});

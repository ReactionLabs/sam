import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnFailure, runChatTurn, turnFailureSummary } from "./agent-turn.js";
import { ChatStore } from "./chats.js";

// Turn failures are ledgered (hourly run 2026-11-10 18:04 EST): a
// turn that threw used to record nothing in the activity ledger -
// only the dashboard server log saw it (7 live failures against 0
// ledger lines) - so the narration-death class was uncountable
// from the owner's own surfaces. These tests pin the one seam in
// runChatTurn: exactly one turn-failed line per dead turn, the
// verbatim error, the acting profile, the route - and never the
// person's message content - while the error itself rethrows
// unchanged and a successful turn ledgers no failure.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turnfail-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

test("turnFailureSummary names the chat, the route, and the verbatim error", () => {
  assert.equal(
    turnFailureSummary("12345678-abcd", "heartbeat", new Error("Unsafe model output")),
    "Turn failed in chat 12345678 (heartbeat): Unsafe model output",
  );
  assert.match(turnFailureSummary("12345678-abcd", "chat", "plain string failure"), /plain string failure/);
});

test("recordTurnFailure resolves the actor from the chat's profile", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    store.createAgent("trading", "Watch the stack.");
    const chat = store.create("Stack watch", "trading");
    store.close();
    recordTurnFailure(root, chat.id, "heartbeat", new Error("Model connector request timed out"));
    const lines = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "trading");
    assert.match(lines[0].summary, /Model connector request timed out/);
    // An unknown chat still lands a line, under the core actor.
    recordTurnFailure(root, "no-such-chat", "chat", new Error("Chat not found"));
    const all = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(all.length, 2);
    assert.equal(all[1].actor, "sam");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a turn that dies on unsafe model output ledgers one turn-failed line and rethrows", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    // Every completion is leak-only machinery: the provider retries
    // and then surfaces "Unsafe model output" - the live
    // narration-death class from the box dashboard log.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "<tool_call>junk</tool_call>" } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
    const store = new ChatStore(root);
    const chat = store.create("Narration death");
    store.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "my secret zebra phrase"), /Unsafe model output/);
    const failures = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(failures.length, 1, "exactly one failure line for one dead turn");
    assert.equal(failures[0].actor, "sam");
    assert.match(failures[0].summary, /Unsafe model output/);
    assert.match(failures[0].summary, /\(chat\)/);
    assert.doesNotMatch(failures[0].summary, /zebra/, "the person's message content never enters the failure line");
    assert.equal(ledger(root).filter(l => l.kind === "turn").length, 0, "no success line for a dead turn");
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured turn ledgers its failure too, and a good turn ledgers none", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Config gap");
    store.close();
    delete process.env.SAM_MODEL_ENDPOINT;
    delete process.env.SAM_MODEL_PROVIDER;
    delete process.env.SAM_MODEL;
    await assert.rejects(() => runChatTurn(root, chat.id, "hello"), /Model not configured/);
    assert.equal(ledger(root).filter(l => l.kind === "turn-failed").length, 1);

    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "Answer." } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
    const reply = await runChatTurn(root, chat.id, "hello again");
    assert.equal(reply, "Answer.");
    assert.equal(ledger(root).filter(l => l.kind === "turn-failed").length, 1, "the good turn added no failure line");
    assert.equal(ledger(root).filter(l => l.kind === "turn").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

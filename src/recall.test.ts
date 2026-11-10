import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecallBlock, recallTerms } from "./recall.js";
import { MemoryStore } from "./memory.js";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-recall-"));
}

function seed(root: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const store = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    store.add({ kind: "observation", source: "episode:sam:2026-11-09", scope: "core", content: "Episode 2026-11-09 · profile sam · 1 chat · Main chat: owner asked how many coins you see, and what tools you have; SAM summed up the harness base." });
    store.add({ kind: "observation", source: "sam-saved", scope: "core", content: "The owner drinks a cortado, not a latte." });
    store.add({ kind: "observation", source: "sam-saved", scope: "profile:other", content: "Another profile's private zebra fact." });
  } finally { store.close(); }
}

test("recall terms: content words only, deduped, capped", () => {
  assert.deepEqual(recallTerms("What did we say about the coins and the Coins market?"), ["say", "coins", "market"]);
  assert.deepEqual(recallTerms("hi ok go"), []);
});

test("recall block: episodes always ride, relevant records join, other profiles stay invisible", () => {
  const root = scratch();
  try {
    seed(root);
    const about = buildRecallBlock(root, { actor: "sam", message: "what did I ask about the coins last time?" });
    assert.match(about, /What you already know/);
    assert.match(about, /how many coins you see/);
    assert.doesNotMatch(about, /cortado/);
    assert.doesNotMatch(about, /zebra/);
    const drink = buildRecallBlock(root, { actor: "sam", message: "remind me, do I drink a cortado?" });
    assert.match(drink, /cortado, not a latte/);
    assert.ok(drink.length <= 1800);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall block: an empty memory reads as no block", () => {
  const root = scratch();
  try {
    assert.equal(buildRecallBlock(root, { actor: "sam", message: "anything at all today" }), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall wiring: a chat turn carries the block, a heartbeat turn does not", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  try {
    seed(root);
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "dummy-key-not-real";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.includes("minimax")) throw new Error("unexpected fetch " + url);
      bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Answer." } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const store = new ChatStore(root);
    const chat = store.create("Recall wiring");
    const beat = store.create("Recall wiring heartbeat");
    store.close();
    const reply = await runChatTurn(root, chat.id, "what did we talk about last time?");
    assert.equal(reply, "Answer.");
    const chatSystems = bodies[0].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.match(chatSystems, /What you already know/);
    assert.match(chatSystems, /how many coins you see/);
    await runChatTurn(root, beat.id, "standing job prompt", { route: "heartbeat" });
    const beatSystems = bodies[1].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    // The block itself (directive + episode content) is absent on the
    // heartbeat route; the loops' one-line pointer to the section may
    // still appear, so the assertions target the block's own text.
    assert.doesNotMatch(beatSystems, /ANSWER FROM THIS FIRST/);
    assert.doesNotMatch(beatSystems, /how many coins you see/);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

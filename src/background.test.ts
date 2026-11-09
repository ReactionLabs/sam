import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { toolBudget } from "./budgets.js";
import { drainBackgroundTasks, listBackgroundTasks, queueBackgroundTask } from "./background.js";
import { executeOwnToolAsync, ownToolsChat } from "./own-tools.js";
import { readActivity } from "./activity.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", "trading").id; } finally { db.close(); }
}

test("tool budgets tier by route: poll cheapest, chat keeps the legacy tier, background deepest", () => {
  assert.deepEqual(toolBudget("chat"), { rounds: 3, maxCalls: 6 });
  assert.deepEqual(toolBudget(), { rounds: 3, maxCalls: 6 });
  const hb = toolBudget("heartbeat");
  assert.ok(hb.rounds < toolBudget("chat").rounds && hb.maxCalls < toolBudget("chat").maxCalls);
  const bg = toolBudget("background");
  assert.ok(bg.rounds > toolBudget("chat").rounds && bg.maxCalls > toolBudget("chat").maxCalls);
});

test("queue validates actor, chat, and prompt; a queued task is listed open", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg-"));
  try {
    const chatId = scratchChat(root);
    assert.throws(() => queueBackgroundTask(root, { actor: "Bad Actor", chatId, prompt: "x" }), /Invalid actor/);
    assert.throws(() => queueBackgroundTask(root, { actor: "trading", chatId: "nope", prompt: "x" }), /Chat not found/);
    assert.throws(() => queueBackgroundTask(root, { actor: "trading", chatId, prompt: " " }), /Invalid background prompt/);
    assert.throws(() => queueBackgroundTask(root, { actor: "trading", chatId, prompt: "x".repeat(4001) }), /Invalid background prompt/);
    const task = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "Compare the last three stack reports in depth" });
    assert.equal(task.status, "queued");
    assert.equal(task.title, "Compare the last three stack reports in depth");
    assert.equal(listBackgroundTasks(root).length, 1);
    assert.ok(readActivity(root).some(a => a.kind === "background-queued"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drain runs a queued task as a turn in its own chat and marks it done", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg2-"));
  try {
    const chatId = scratchChat(root);
    const task = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "deep dive please", title: "Deep dive" });
    // Stand-in for runChatTurn: persists both sides of the exchange, returns the reply.
    const runTurn = async (cid: string, content: string) => {
      const db = new ChatStore(root);
      try { db.add(cid, "user", content); db.add(cid, "assistant", "the deep answer"); } finally { db.close(); }
      return "the deep answer";
    };
    const out = await drainBackgroundTasks(root, { runTurn });
    assert.deepEqual(out.ran, [task.id]);
    assert.deepEqual(out.failed, []);
    const done = listBackgroundTasks(root)[0];
    assert.equal(done.status, "done");
    assert.equal(done.result, "the deep answer");
    assert.ok(done.startedAt && done.finishedAt);
    const db = new ChatStore(root);
    try {
      const msgs = db.messages(chatId);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1].content, "the deep answer");
    } finally { db.close(); }
    // A second drain finds nothing to do.
    assert.deepEqual(await drainBackgroundTasks(root, { runTurn }), { ran: [], failed: [], recovered: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drain failure marks the task failed and posts the failure into its chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg3-"));
  try {
    const chatId = scratchChat(root);
    const task = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "boom", title: "Boom task" });
    const out = await drainBackgroundTasks(root, { runTurn: async () => { throw new Error("Model not configured"); } });
    assert.deepEqual(out.failed, [task.id]);
    const bad = listBackgroundTasks(root)[0];
    assert.equal(bad.status, "failed");
    assert.match(bad.result ?? "", /Model not configured/);
    const db = new ChatStore(root);
    try {
      const msgs = db.messages(chatId);
      assert.equal(msgs.length, 1);
      assert.match(msgs[0].content, /Background task failed: Boom task/);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale running task is recovered as failed by the next drain, never wedged", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg4-"));
  try {
    const chatId = scratchChat(root);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const stale = {
      id: "11111111-1111-4111-8111-111111111111", actor: "trading", chatId, title: "Died mid-run", prompt: "x",
      status: "running", createdAt: new Date(Date.now() - 3600000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(), finishedAt: null, result: null,
    };
    writeFileSync(join(root, ".sam", "background.json"), JSON.stringify([stale], null, 2));
    const out = await drainBackgroundTasks(root, { runTurn: async () => "never" });
    assert.deepEqual(out.recovered, [stale.id]);
    assert.equal(listBackgroundTasks(root)[0].status, "failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sam_handoff_task queues work bound to the current chat and actor", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg5-"));
  try {
    const chatId = scratchChat(root);
    const out = await executeOwnToolAsync(root, "trading", "sam_handoff_task", { prompt: "research this properly", title: "Research" }, undefined, chatId) as { status: string; id: string };
    assert.equal(out.status, "queued");
    const tasks = listBackgroundTasks(root);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, out.id);
    assert.equal(tasks[0].chatId, chatId);
    assert.equal(tasks[0].actor, "trading");
    const noChat = await executeOwnToolAsync(root, "trading", "sam_handoff_task", { prompt: "x" }) as { error: string };
    assert.match(noChat.error, /needs a chat/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the heartbeat budget stops a tool-hungry loop sooner than the background budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bg6-"));
  try {
    let calls = 0; let seq = 0;
    const greedy = {
      async completeConnectorTurn() {
        calls++;
        return { content: null, calls: [0, 1, 2].map(() => ({ id: "c" + (++seq), name: "sam_memory_list", args: {} })) };
      },
    } as unknown as OpenAICompatibleProvider;
    // Exhaustion is graceful since the budget fix: the turn RESOLVES with a
    // partial answer instead of rejecting, but the heartbeat tier still runs
    // out sooner (fewer model rounds) than the background tier.
    const heartbeatAnswer = await ownToolsChat(root, "sam", greedy, "m", [{ role: "user", content: "go" }], undefined, undefined, toolBudget("heartbeat"));
    assert.match(heartbeatAnswer, /tool budget/i);
    const heartbeatCalls = calls;
    calls = 0;
    const backgroundAnswer = await ownToolsChat(root, "sam", greedy, "m", [{ role: "user", content: "go" }], undefined, undefined, toolBudget("background"));
    assert.match(backgroundAnswer, /tool budget/i);
    assert.ok(calls > heartbeatCalls, "background tier must allow more tool rounds than a heartbeat poll");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

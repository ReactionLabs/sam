import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatTurnBudget } from "./budgets.js";
import { ownToolsChat } from "./own-tools.js";
import { readActivity } from "./activity.js";
import { LOADER_TOOL_NAME } from "./tool-tiers.js";
import {
  advanceSpawnPoolTranche, isPoolRefusal, listSubagents, ownerSpawnPool,
  smallSpawnPool, spawnSubagent, updateSubagent, withSpawnPool, type SubagentCompleter,
} from "./subagents.js";
import { OrchestrationFitError, laneBudget, planJob, remainingPool } from "./orchestration.js";
import { enqueueChatMessage, listChatQueue } from "./chat-queue.js";
import { ChatStore } from "./chats.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// Turn behavior (Dip live catches, 2026-11-14): the tool-load loop
// (Defect 1), message bursts (Defect 2), and the budget-starved
// spawn pool (Defect 3 / issue #96). These tests pin the mechanisms;
// the dashboard-path harness with a stubbed model server lives in
// turn-behavior-harness.test.ts.

type Turn = { content: string | null; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> };
function stubProvider(handler: (invocation: number, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) => Turn) {
  let invocations = 0;
  const seen: Array<Array<Record<string, unknown>>> = [];
  const provider = {
    async completeConnectorTurn(_model: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) {
      invocations++;
      seen.push(messages.map(m => ({ ...m })));
      return handler(invocations, messages, tools);
    },
  } as unknown as OpenAICompatibleProvider;
  return { provider, seen, count: () => invocations };
}
let seq = 0;
function call(name: string, args: Record<string, unknown>): Turn["calls"][number] {
  return { id: "c" + (++seq), name, args };
}
function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-turns-")); }
function toolContents(messages: Array<Record<string, unknown>>): string[] {
  return messages.filter(m => m.role === "tool").map(m => String(m.content));
}

test("defect 1: a repeat load is a free no-op - already-loaded ack, no budget, invisible to the loop guard", async () => {
  const root = scratch();
  try {
    const run = stubProvider((invocation) => {
      if (invocation === 1) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task"] })] };
      if (invocation === 2) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task"] })] };
      if (invocation === 3) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task"] })] };
      return { content: "done, no reload needed", calls: [] };
    });
    const { budget } = chatTurnBudget({ route: "chat", surface: "scoped" });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "hi" }], undefined, "chat-repeat-load", budget);
    assert.equal(answer, "done, no reload needed", "three loads of one tool never trip the guard and never end the turn");
    const results = toolContents(run.seen[run.seen.length - 1]);
    assert.equal(results.filter(c => c.includes("\"status\":\"loaded\"")).length, 1, "exactly one real load happened");
    assert.equal(results.filter(c => c.includes("\"status\":\"already-loaded\"")).length, 2, "both repeats returned the cached acknowledgement");
    assert.equal(readActivity(root, 20, { kind: "loader-loop" }).length, 0, "no loader loop was ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 1: on an owner turn the preparation-loop trip steers and disables the loader instead of ending the turn", async () => {
  const root = scratch();
  try {
    const run = stubProvider((invocation, _messages, tools) => {
      if (invocation === 1) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task"] })] };
      if (invocation === 2) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_ask_linked"] })] };
      if (invocation === 3) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_brief"] })] };
      if (invocation === 4) return { content: null, calls: [call("sam_workspace_list", {})] };
      if (!tools.length) return { content: "the finished answer", calls: [] };
      return { content: "the finished answer", calls: [] };
    });
    const { budget, ceiling } = chatTurnBudget({ route: "chat" });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "what is new" }], undefined, "chat-owner-prep", budget, undefined, undefined, undefined, ceiling);
    assert.equal(answer, "the finished answer", "the owner turn continued past the trip and answered");
    assert.doesNotMatch(answer, /Ask me to continue/);
    const loops = readActivity(root, 20, { kind: "loader-loop" });
    assert.equal(loops.length, 1, "the trip is ledgered once");
    assert.match(loops[0].summary, /turn continues with the tools already loaded/);
    const seenText = run.seen.flatMap(ms => ms.map(m => String(m.content ?? ""))).join("\n");
    assert.match(seenText, /Preparation-loop guard/, "the hard steer reached the model");
    const results = toolContents(run.seen[run.seen.length - 1]);
    assert.ok(results.some(c => c.includes("Tool loading is off for the rest of this turn")), "a load after the trip is stubbed, not executed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 1: preparation-only classification - loads and no-progress hires are preparation, real work is progress", async () => {
  const { isPreparationOnlyRound } = await import("./tool-tiers.js");
  assert.equal(isPreparationOnlyRound(["sam_load_tools"], false), true);
  assert.equal(isPreparationOnlyRound(["sam_load_tools", "sam_orchestrate"], false), true, "a hire that created nothing does not reset the streak");
  assert.equal(isPreparationOnlyRound(["sam_orchestrate"], true), false, "a hire that created lanes is progress");
  assert.equal(isPreparationOnlyRound(["sam_memory_search"], false), false);
  assert.equal(isPreparationOnlyRound([], false), false);
});

test("defect 1: history trim folds whole rounds - the request never crosses the provider's 50-message limit", async () => {
  const { trimRoundBlocks, REQUEST_MESSAGE_CAP } = await import("./tool-tiers.js");
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: "sys" }, { role: "user", content: "ask" },
  ];
  for (let r = 0; r < 30; r++) {
    msgs.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + r }] });
    msgs.push({ role: "tool", content: "result " + r, tool_call_id: "c" + r });
  }
  const dropped = trimRoundBlocks(msgs.map(m => ({ ...m })));
  assert.ok(dropped > 0);
  const trimmed = msgs.slice(0, 2);
  const copy = msgs.map(m => ({ ...m }));
  trimRoundBlocks(copy);
  assert.ok(copy.length <= REQUEST_MESSAGE_CAP, "the history fits the cap");
  assert.equal(copy[0].content, "sys"); assert.equal(copy[1].content, "ask");
  // Well-formed: every tool message is answered by the assistant
  // block directly before it, and the newest round survives.
  for (let i = 0; i < copy.length; i++) if (copy[i].role === "tool") assert.equal(copy[i - 1].role, "assistant");
  assert.equal(copy[copy.length - 1].content, "result 29");
  void trimmed; void dropped;
});

test("defect 1: a 30-round owner turn completes - request sizes stay inside the provider limit throughout", async () => {
  const root = scratch();
  try {
    let step = 0;
    const run = stubProvider((_invocation, messages) => {
      step++;
      if (step <= 30) return { content: null, calls: [call("sam_workspace_list", { marker: "round-" + step })] };
      return { content: "thirty rounds, one answer", calls: [] };
    });
    const { budget, ceiling } = chatTurnBudget({ route: "chat" });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "long check" }], undefined, "chat-long-turn", budget, undefined, undefined, undefined, ceiling);
    assert.equal(answer, "thirty rounds, one answer");
    for (const seen of run.seen) assert.ok(seen.length <= 50, "every request stayed inside the 50-message provider limit (saw " + seen.length + ")");
    assert.ok(readActivity(root, 20, { kind: "turn-history-trimmed" }).length >= 1, "the trim is ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 1: the load window carries the newest loads, the gate honors the loaded set, re-loading rotates", async () => {
  const { partitionTools, CORE_OWN_TOOLS, recordToolLoad, touchToolLoads, loadedTools, toolNameOf } = await import("./tool-tiers.js");
  const def = (name: string) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
  const all = [...CORE_OWN_TOOLS.map(def), def("sam_handoff_task"), def("sam_ask_linked"), def("sam_brief"), def("sam_orchestrate")];
  const loaded = new Set(["sam_handoff_task", "sam_ask_linked", "sam_brief"]);
  const part = partitionTools(all as never, loaded);
  assert.ok(part.upfrontNames.has("sam_brief"), "the newest load is in the window");
  assert.ok(!part.upfrontNames.has("sam_handoff_task"), "the oldest load rotated out of the window (window is bounded)");
  // The store rotation door: touching a name moves it newest.
  const root = scratch();
  try {
    const valid = new Set(all.map(d => toolNameOf(d as never)));
    recordToolLoad(root, "chat-w", ["sam_handoff_task", "sam_ask_linked", "sam_brief"], valid);
    assert.deepEqual(loadedTools(root, "chat-w"), ["sam_handoff_task", "sam_ask_linked", "sam_brief"]);
    touchToolLoads(root, "chat-w", ["sam_handoff_task"]);
    assert.deepEqual(loadedTools(root, "chat-w"), ["sam_ask_linked", "sam_brief", "sam_handoff_task"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 1: a loaded tool outside the window still executes - the gate reads the loaded set, not the window", async () => {
  const root = scratch();
  try {
    const run = stubProvider((invocation) => {
      if (invocation === 1) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task", "sam_ask_linked", "sam_brief"] })] };
      if (invocation === 2) return { content: null, calls: [call("sam_handoff_task", { title: "window check", prompt: "check the window" })] };
      return { content: "called the first-loaded tool fine", calls: [] };
    });
    const { budget } = chatTurnBudget({ route: "chat", surface: "scoped" });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "hi" }], undefined, "chat-window-gate", budget);
    assert.equal(answer, "called the first-loaded tool fine");
    const results = toolContents(run.seen[run.seen.length - 1]);
    assert.ok(!results.some(c => c.includes("Tool not loaded in this chat session")), "no loaded call was refused by the gate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const text = (t: string): SubagentCompleter => async () => ({ content: t, calls: [] });

test("defect 3: the spawn pool is scoped to the hiring context - one scope's history never starves another", async () => {
  const root = scratch();
  try {
    await withSpawnPool(smallSpawnPool("job:dead"), async () => {
      await spawnSubagent(root, { prompt: "old worker one", rounds: 2, maxCalls: 5 }, { complete: text("x") });
      await spawnSubagent(root, { prompt: "old worker two", rounds: 2, maxCalls: 5 }, { complete: text("x") });
      await spawnSubagent(root, { prompt: "old worker three", rounds: 2, maxCalls: 6 }, { complete: text("x") });
    });
    // The dead scope spent {6, 16} - the whole small pool. A fresh
    // scope must see a full pool anyway (the live defect read 0/1
    // forever, from exactly this kind of history).
    await withSpawnPool(smallSpawnPool("job:fresh"), async () => {
      assert.deepEqual(remainingPool(root, "sam"), { rounds: 6, maxCalls: 16 });
      const hired = await spawnSubagent(root, { prompt: "fresh worker", rounds: 2, maxCalls: 5 }, { complete: text("y") });
      assert.equal(hired.status, "done");
      assert.deepEqual(remainingPool(root, "sam"), { rounds: 4, maxCalls: 11 });
    });
    // An owner context is sized from the owner turn budget, not {6,16}.
    await withSpawnPool(ownerSpawnPool("turn:probe"), async () => {
      assert.deepEqual(remainingPool(root, "sam"), { rounds: 30, maxCalls: 120 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 3: owner tranches refill the pool, and the turn ceiling caps cumulative carves", async () => {
  const root = scratch();
  try {
    const ctx = ownerSpawnPool("turn:tranches");
    await withSpawnPool(ctx, async () => {
      for (let i = 0; i < 5; i++) await spawnSubagent(root, { prompt: "worker " + i, rounds: 6, maxCalls: 16 }, { complete: text("x") });
      // Tranche 0 is spent on rounds ({30, 80} carved of {30, 120}).
      await assert.rejects(() => spawnSubagent(root, { prompt: "one too many", rounds: 6, maxCalls: 16 }, { complete: text("x") }), /remaining pool/);
      // The Lane F continuation: advance a tranche, the pool refills.
      assert.equal(advanceSpawnPoolTranche(ctx), true);
      const hired = await spawnSubagent(root, { prompt: "next tranche worker", rounds: 6, maxCalls: 16 }, { complete: text("x") });
      assert.equal(hired.status, "done");
      for (let i = 0; i < 4; i++) await spawnSubagent(root, { prompt: "filler " + i, rounds: 6, maxCalls: 16 }, { complete: text("x") });
      // Cumulative carves are now {60, 160}: the ceiling's rounds bind.
      assert.equal(advanceSpawnPoolTranche(ctx), true);
      let refusal: unknown = null;
      try { await spawnSubagent(root, { prompt: "past the ceiling", rounds: 6, maxCalls: 16 }, { complete: text("x") }); }
      catch (e) { refusal = e; }
      assert.ok(isPoolRefusal(refusal), "the ceiling refusal is a typed pool refusal");
      assert.equal((refusal as { ceilingHit?: boolean }).ceilingHit, true, "and it names the ceiling, not the tranche");
    });
    assert.equal(listSubagents(root, "sam").filter(s => s.status === "done").length, 10);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("issue 96: per-lane budgets are priced exactly as given, and an unsupported budget is refused by name", () => {
  assert.deepEqual(laneBudget({ kind: "research" } as never), { rounds: 2, maxCalls: 5 }, "no budget field: the kind default");
  assert.deepEqual(laneBudget({ kind: "research", budget: { rounds: 1, maxCalls: 2 } } as never), { rounds: 1, maxCalls: 2 }, "an explicit budget is honored as given");
  assert.throws(() => laneBudget({ kind: "research", budget: { rounds: 7, maxCalls: 2 } } as never), /unsupported budget/);
  assert.throws(() => laneBudget({ kind: "research", budget: { rounds: 2, maxCalls: 99 } } as never), /unsupported budget/);
  const root = scratch();
  try {
    // Two lanes explicitly priced {3, 9} ask {6, 18}: over the small
    // pool on calls. Had the prices been silently replaced by the
    // kind defaults, the ask would read {4, 8} and fit - the recorded
    // failure. The refusal must carry the GIVEN totals.
    let thrown: unknown = null;
    withSpawnPool(smallSpawnPool("job:pricing"), () => {
      try {
        planJob(root, {
          ask: "priced as given",
          lanes: [
            { name: "alpha", kind: "general", goal: "g", doneLooksLike: "d", notDoneLooksLike: "n", landsAt: "the result", budget: { rounds: 3, maxCalls: 9 } },
            { name: "beta", kind: "general", goal: "g", doneLooksLike: "d", notDoneLooksLike: "n", landsAt: "the result", budget: { rounds: 3, maxCalls: 9 } },
          ],
        });
      } catch (e) { thrown = e; }
    });
    assert.ok(thrown instanceof OrchestrationFitError, "the fit refusal is typed");
    assert.deepEqual((thrown as OrchestrationFitError).asks, { rounds: 6, maxCalls: 18 }, "the plan was priced from the given budgets");
    assert.deepEqual((thrown as OrchestrationFitError).remaining, { rounds: 6, maxCalls: 16 });
    // And a plan priced to fit lands with its given budgets intact.
    withSpawnPool(smallSpawnPool("job:pricing-2"), () => {
      const { lanes } = planJob(root, {
        ask: "priced to fit",
        lanes: [{ name: "alpha", kind: "general", goal: "g", doneLooksLike: "d", notDoneLooksLike: "n", landsAt: "the result", budget: { rounds: 1, maxCalls: 2 } }],
      });
      assert.deepEqual(lanes[0].budget, { rounds: 1, maxCalls: 2 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 2: queue control accounting - a nevermind and a stop are consumed by the queue, ledgered, never lost", async () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const chat = store.create("Burst chat", null);
    store.close();
    const nvm = enqueueChatMessage(root, { chatId: chat.id, content: "nevermind", source: "dashboard" });
    assert.equal(nvm.status, "consumed");
    assert.equal(nvm.effect, "nevermind");
    const stop = enqueueChatMessage(root, { chatId: chat.id, content: "stop", source: "dashboard" });
    assert.equal(stop.status, "consumed");
    assert.equal(stop.effect, "stop");
    const items = listChatQueue(root, chat.id);
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.status === "consumed"), "both control messages are accounted for in the queue");
    assert.equal(readActivity(root, 20, { kind: "message-nevermind" }).length, 1);
    assert.equal(readActivity(root, 20, { kind: "message-stop" }).length, 1);
    // A normal message queues (its drain turn fails here - no model
    // is configured in this process - and the row must end accounted
    // for as failed, never stuck at queued or silently gone).
    const work = enqueueChatMessage(root, { chatId: chat.id, content: "do the thing", source: "dashboard" });
    assert.equal(work.status, "queued");
    const { awaitChatQueue } = await import("./chat-queue.js");
    await awaitChatQueue(root, chat.id, 15000);
    const settled = listChatQueue(root, chat.id).find(i => i.id === work.id);
    assert.equal(settled?.status, "failed", "a turn that cannot run marks its messages failed, not lost");
    assert.equal(readActivity(root, 20, { kind: "message-failed" }).length, 1);
    // updateSubagent exists for the harness's legacy-record seeding.
    assert.equal(typeof updateSubagent, "function");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

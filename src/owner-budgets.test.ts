import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatTurnBudget, toolBudget, OWNER_CHAT_BUDGET, OWNER_CHAT_CEILING } from "./budgets.js";
import { ownToolsChat } from "./own-tools.js";
import { readActivity } from "./activity.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// Owner-turn budgets (Dip ruling 2026-11-14): the owner's surfaces
// effectively never run out, scoped surfaces keep the legacy leash,
// duplicates never re-spend, and the hard ceiling closes a turn
// with a synthesis - never the incomplete-answer text.

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
function toolContents(messages: Array<Record<string, unknown>>): string[] {
  return messages.filter(m => m.role === "tool").map(m => String(m.content));
}
let seq = 0;
function call(name: string, args: Record<string, unknown>): Turn["calls"][number] {
  return { id: "c" + (++seq), name, args };
}

test("chat turn budgets resolve by route and surface: owner deep with a ceiling, scoped and machine tiers unchanged", () => {
  const owner = chatTurnBudget({ route: "chat" });
  assert.deepEqual(owner.budget, OWNER_CHAT_BUDGET);
  assert.deepEqual(owner.ceiling, OWNER_CHAT_CEILING);
  assert.ok(owner.budget.rounds >= 10 * toolBudget("chat").rounds - 1, "owner budget is an order of magnitude past the legacy chat tier");
  assert.deepEqual(chatTurnBudget({ route: "chat", visitor: true }), { budget: toolBudget("chat"), ceiling: null });
  assert.deepEqual(chatTurnBudget({ route: "chat", surface: "scoped" }), { budget: toolBudget("chat"), ceiling: null });
  assert.deepEqual(chatTurnBudget({ route: "chat", surface: "scoped", visitor: false }).budget, { rounds: 3, maxCalls: 6 });
  assert.deepEqual(chatTurnBudget({ route: "heartbeat" }), { budget: toolBudget("heartbeat"), ceiling: null });
  assert.deepEqual(chatTurnBudget({ route: "background" }), { budget: toolBudget("background"), ceiling: null });
});

test("an owner turn runs far past the old chat budget and answers; the same hunger on the scoped tier ends in the old fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ob1-"));
  try {
    // Ten rounds of one distinct search each, then an answer. The
    // model demands tools even in the tool-free synthesis (until it
    // is ready to answer), which is what drives the scoped tier
    // into its fallback while the owner tier just keeps going.
    const hungry = (invocation: number) => {
      if (invocation > 10) return { content: "the finished answer", calls: [] };
      return { content: null, calls: [call("sam_memory_search", { query: "q" + invocation })] };
    };
    const ownerRun = stubProvider(hungry);
    const { budget, ceiling } = chatTurnBudget({ route: "chat" });
    const ownerAnswer = await ownToolsChat(root, "sam", ownerRun.provider, "m", [{ role: "user", content: "dig" }], undefined, undefined, budget, undefined, undefined, undefined, ceiling);
    assert.equal(ownerAnswer, "the finished answer");
    assert.doesNotMatch(ownerAnswer, /Ask me to continue/);
    const scopedRun = stubProvider(hungry);
    const scoped = chatTurnBudget({ route: "chat", surface: "scoped" });
    const scopedAnswer = await ownToolsChat(root, "sam", scopedRun.provider, "m", [{ role: "user", content: "dig" }], undefined, undefined, scoped.budget, undefined, undefined, undefined, scoped.ceiling);
    assert.match(scopedAnswer, /Ask me to continue/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicate calls return the earlier result marked as a repeat and never re-execute; a state change in between re-arms execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ob2-"));
  try {
    writeFileSync(join(root, "a.txt"), "alpha contents");
    const script: Turn[] = [
      { content: null, calls: [call("sam_workspace_read", { path: "a.txt" })] },
      { content: null, calls: [call("sam_workspace_read", { path: "a.txt" })] },
      { content: null, calls: [call("sam_save_note", { content: "a helpful observation about alpha", kind: "observation" })] },
      { content: null, calls: [call("sam_workspace_read", { path: "a.txt" })] },
      { content: null, calls: [call("sam_workspace_read", { path: "a.txt" })] },
      { content: "done", calls: [] },
    ];
    const run = stubProvider(invocation => script[invocation - 1] ?? { content: "overflow", calls: [] });
    const { budget, ceiling } = chatTurnBudget({ route: "chat" });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "read it" }], undefined, undefined, budget, undefined, undefined, undefined, ceiling);
    assert.equal(answer, "done");
    const finalMessages = run.seen[run.seen.length - 1];
    const reads = toolContents(finalMessages).filter(c => c.includes("alpha contents"));
    assert.equal(reads.length, 4, "four read results reached the model (two executions, two repeats)");
    const repeats = reads.filter(c => c.includes("\"repeatedCall\":true"));
    assert.equal(repeats.length, 2, "read 2 repeats (nothing changed), read 3 re-executes (the save changed state), read 4 repeats again");
    assert.ok(readActivity(root).some(a => a.kind === "tool-repeat"), "suppressed duplicates are ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("independent calls in one step run as one step: three calls, one round", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ob3-"));
  try {
    const run = stubProvider((invocation, _m, tools) => {
      if (!tools.length) return { content: "synthesis answer", calls: [] };
      if (invocation === 1) return { content: null, calls: [call("sam_memory_search", { query: "one" }), call("sam_memory_search", { query: "two" }), call("sam_memory_search", { query: "three" })] };
      return { content: "one-round answer", calls: [] };
    });
    // A single tool round in the budget: three serial rounds would die here.
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "go" }], undefined, undefined, { rounds: 1, maxCalls: 6 });
    assert.equal(answer, "synthesis answer");
    assert.equal(run.count(), 2, "one tool round plus the synthesis, not three rounds");
    const synthesisMessages = run.seen[1];
    assert.equal(toolContents(synthesisMessages).length, 3, "all three results landed from the one step");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the hard ceiling ledgers budget-guardrail, forces a synthesis, and never produces the incomplete-answer text", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ob4-"));
  try {
    let n = 0;
    const run = stubProvider((_invocation, _m, tools) => {
      // A model that always wants more tools, even tool-free.
      const calls = [0, 1, 2].map(() => call("sam_memory_search", { query: "g" + (++n) }));
      if (!tools.length) return { content: null, calls };
      return { content: null, calls };
    });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "go" }], undefined, undefined, { rounds: 2, maxCalls: 4 }, undefined, undefined, undefined, { rounds: 3, maxCalls: 6 });
    assert.match(answer, /internal safety limit/);
    assert.doesNotMatch(answer, /Ask me to continue/);
    assert.doesNotMatch(answer, /incomplete/);
    const activity = readActivity(root);
    assert.ok(activity.some(a => a.kind === "budget-guardrail"), "the ceiling trip is ledgered as budget-guardrail");
    assert.ok(activity.some(a => a.kind === "budget-continued"), "crossing the soft budget in tranches is ledgered as continuation, not failure");
    const executedReal = toolContents(run.seen[run.seen.length - 1]).filter(c => !c.includes("Internal safety limit reached") && !c.includes("repeatedCall"));
    assert.equal(executedReal.length, 6, "execution continued past the soft cap of 4 up to the ceiling of 6");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("at the ceiling a synthesis that composes is the answer, and the guardrail line still lands", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ob5-"));
  try {
    let n = 0; let syntheses = 0;
    const run = stubProvider((_invocation, _m, tools) => {
      if (!tools.length) {
        syntheses++;
        if (syntheses === 1) return { content: null, calls: [call("sam_memory_search", { query: "late" })] };
        return { content: "composed from what was gathered", calls: [] };
      }
      return { content: null, calls: [0, 1, 2].map(() => call("sam_memory_search", { query: "h" + (++n) })) };
    });
    const answer = await ownToolsChat(root, "sam", run.provider, "m", [{ role: "user", content: "go" }], undefined, undefined, { rounds: 2, maxCalls: 4 }, undefined, undefined, undefined, { rounds: 3, maxCalls: 6 });
    assert.equal(answer, "composed from what was gathered");
    assert.ok(readActivity(root).some(a => a.kind === "budget-guardrail"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

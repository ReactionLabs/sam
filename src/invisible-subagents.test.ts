import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listActions } from "./actions.js";
import { readActivity } from "./activity.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { listSubagents, startBackgroundSubagent, whenSubagentSettled, setSubagentRunnerForTests, type SubagentCompleter } from "./subagents.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-invisible-")); }
function chat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Owner chat").id; }
  finally { db.close(); }
}
function messages(root: string, id: string): string[] {
  const db = new ChatStore(root);
  try { return db.messages(id).map(m => m.content); }
  finally { db.close(); }
}

test("a chat turn starts a helper without waiting, and the chat never shows helper chatter", async () => {
  const root = scratch();
  try {
    const id = chat(root);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let sawReviewPrompt = false;
    const complete: SubagentCompleter = async (_model, messages) => {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("internal reviewer")) {
        sawReviewPrompt = true;
        return { content: "VERDICT: approve\nThe change holds.\nsecret-chatter from the helper", calls: [] };
      }
      await gate;
      return { content: "secret-chatter from the helper", calls: [] };
    };
    setSubagentRunnerForTests({
      complete,
      fold: async () => "The widget is ready.",
    });
    const started = await executeOwnToolAsync(root, "sam", "sam_spawn_subagent", { prompt: "Look up the widget notes", role: "research" }, undefined, id) as { status: string; ownerLine: string; id: string };
    assert.equal(started.status, "working");
    assert.equal(started.ownerLine, "Working on it.");
    assert.deepEqual(messages(root, id), []);
    assert.equal(listSubagents(root).some(s => s.id === started.id && s.status === "running"), true);
    release();
    const done = await whenSubagentSettled(started.id);
    assert.equal(done.status, "done");
    assert.match(done.result ?? "", /secret-chatter/);
    const visible = messages(root, id);
    assert.deepEqual(visible, ["The widget is ready."]);
    assert.equal(visible.join("\n").includes("secret-chatter"), false);
    assert.equal(visible.join("\n").includes("Look up the widget notes"), false);
    assert.equal(visible.join("\n").includes("VERDICT:"), false);
    const kinds = readActivity(root, 20).map(l => l.kind).join(",");
    assert.match(kinds, /subagent-spawn/);
    assert.match(kinds, /subagent-done/);
    assert.match(kinds, /subagent-folded/);
    assert.match(readActivity(root, 20).map(l => l.summary).join("\n"), /secret-chatter/);

    const review = await executeOwnToolAsync(root, "sam", "sam_spawn_subagent", { prompt: "Review the widget change before it is called done", role: "review" }, undefined, id) as { status: string; id: string };
    const reviewed = await whenSubagentSettled(review.id);
    assert.equal(sawReviewPrompt, true);
    assert.equal(reviewed.role, "review");
    assert.match(reviewed.result ?? "", /VERDICT: approve/);
    assert.equal(reviewed.tools.includes("sam_code"), false);
    assert.equal(messages(root, id).some(line => line.includes("VERDICT:") || line.includes("secret-chatter")), false);
  } finally {
    setSubagentRunnerForTests(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a helper cannot widen tools, a proposal stays a card, and a nested reviewer returns to its parent", async () => {
  const root = scratch();
  try {
    const id = chat(root);
    await assert.rejects(async () => startBackgroundSubagent(root, { prompt: "nope", chatId: id, tools: ["not_a_tool"] }, { complete: async () => ({ content: "no", calls: [] }) }), /cannot widen/);
    let step = 0;
    const complete: SubagentCompleter = async (_model, messages) => {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("internal reviewer")) return { content: "VERDICT: request-changes\nThe test is missing.", calls: [] };
      step++;
      if (step === 1) return { content: null, calls: [{ id: "p", name: "sam_propose_action", args: { kind: "law", title: "Be brief", detail: "Always be brief" } }] };
      if (step === 2) return { content: null, calls: [{ id: "r", name: "sam_spawn_subagent", args: { prompt: "Review the rule before calling it done", role: "review" } }] };
      return { content: "Rule proposed and reviewed", calls: [] };
    };
    setSubagentRunnerForTests({ complete, fold: async () => "The rule is waiting for your approval." });
    const started = startBackgroundSubagent(root, {
      prompt: "Propose the rule, then review it",
      chatId: id,
      role: "build",
      tools: ["sam_propose_action", "sam_spawn_subagent"],
      rounds: 4,
      maxCalls: 4,
    });
    const done = await whenSubagentSettled(started.id);
    assert.equal(done.status, "done");
    assert.match(done.result ?? "", /reviewed/);
    const pending = listActions(root).filter(a => a.kind === "law");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    const visible = messages(root, id).join("\n");
    assert.equal(visible, "The rule is waiting for your approval.");
    assert.equal(visible.includes("VERDICT:"), false);
    assert.equal(visible.includes("Always be brief"), false);
    const nested = listSubagents(root).find(s => s.parentId === started.id);
    assert.equal(nested?.role, "review");
    assert.equal(nested?.depth, 2);
    assert.match(nested?.result ?? "", /request-changes/);
  } finally {
    setSubagentRunnerForTests(null);
    rmSync(root, { recursive: true, force: true });
  }
});

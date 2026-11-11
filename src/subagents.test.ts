import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawnSubagent, listSubagents, getSubagent, cancelSubagent, SUBAGENT_MAX_CONCURRENT, SUBAGENT_MAX_DEPTH, type SubagentCompleter } from "./subagents.js";
import { listActions } from "./actions.js";
import { readActivity } from "./activity.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { ChatStore } from "./chats.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-sub-")); }
const text = (content: string): SubagentCompleter => async () => ({ content, calls: [] });

test("a child returns its result, cannot widen tools, and a proposal stays a card", async () => {
  const root = scratch();
  try {
    const parent = await spawnSubagent(root, { profile: "sam", prompt: "Summarize the inbox", tools: ["sam_memory_list", "sam_propose_action"] }, { complete: text("Parent done") });
    assert.equal(parent.result, "Parent done");
    assert.equal(parent.depth, 1);
    await assert.rejects(() => spawnSubagent(root, { profile: "sam", prompt: "write code", parentId: parent.id, tools: ["sam_code"] }, { complete: text("no") }), /cannot widen/);
    let step = 0;
    const child = await spawnSubagent(root, { profile: "sam", prompt: "Propose a rule and stop", parentId: parent.id, tools: ["sam_propose_action"], rounds: 2, maxCalls: 2 }, {
      complete: async () => {
        step++;
        if (step === 1) return { content: null, calls: [{ id: "c1", name: "sam_propose_action", args: { kind: "law", title: "Be brief", detail: "Always be brief" } }, { id: "c2", name: "sam_code", args: { action: "write" } }] };
        return { content: "Proposed the rule", calls: [] };
      },
    });
    assert.equal(child.result, "Proposed the rule");
    assert.equal(child.depth, 2);
    const pending = listActions(root).filter(a => a.kind === "law");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.match(readActivity(root, 20).map(l => l.kind).join(","), /subagent-spawn/);
    assert.match(readActivity(root, 20).map(l => l.kind).join(","), /subagent-done/);
    const db = new ChatStore(root);
    const chat = db.create("Child report");
    db.close();
    const posted = await spawnSubagent(root, { prompt: "Report in", chatId: chat.id, tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("Reported") });
    const check = new ChatStore(root);
    const messages = check.messages(chat.id);
    check.close();
    assert.match(messages.map(m => m.content).join("\n"), /Reported/);
    assert.equal(posted.status, "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("depth, concurrency, and the parent budget pool are caps", async () => {
  const root = scratch();
  try {
    const parent = await spawnSubagent(root, { prompt: "parent", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("p") });
    const child = await spawnSubagent(root, { prompt: "child", parentId: parent.id, rounds: 1, maxCalls: 1 }, { complete: text("c") });
    assert.equal(child.depth, 2);
    await assert.rejects(() => spawnSubagent(root, { prompt: "too deep", parentId: child.id }, { complete: text("no") }), new RegExp("depth cap is " + SUBAGENT_MAX_DEPTH));
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hold: SubagentCompleter = async () => { await gate; return { content: "held", calls: [] }; };
    const first = spawnSubagent(root, { prompt: "one", rounds: 1, maxCalls: 1 }, { complete: hold });
    const second = spawnSubagent(root, { prompt: "two", rounds: 1, maxCalls: 1 }, { complete: hold });
    const started = Date.now();
    while (listSubagents(root).filter(s => s.status === "running").length < 2) {
      if (Date.now() - started > 3000) throw new Error("children did not start");
      await new Promise(r => setTimeout(r, 10));
    }
    await assert.rejects(() => spawnSubagent(root, { prompt: "three", rounds: 1, maxCalls: 1 }, { complete: text("no") }), new RegExp("concurrency cap is " + SUBAGENT_MAX_CONCURRENT));
    release();
    await Promise.all([first, second]);
    await assert.rejects(() => spawnSubagent(root, { prompt: "too big", rounds: 6, maxCalls: 16 }, { complete: text("no") }), /remaining pool/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel stops the child, and a restarted process keeps the checkpoint as interrupted", async () => {
  const root = scratch();
  try {
    const child = spawnSubagent(root, { prompt: "wait", rounds: 2, maxCalls: 1 }, {
      complete: async () => {
        const running = listSubagents(root).find(s => s.status === "running");
        if (running) cancelSubagent(root, running.id);
        return { content: "should not win", calls: [] };
      },
    });
    const ended = await child;
    assert.equal(ended.status, "cancelled");
    const journal = new AgentLoopJournal(join(root, ".sam", "subagents.db"));
    const loop = journal.create("orphan task");
    journal.event(loop.id, "tool_call", "sam_memory_list ran before the crash");
    journal.close();
    const orphan = {
      id: loop.id, profile: "sam", parentId: null, depth: 1, prompt: "orphan task", tools: ["sam_memory_list"],
      budget: { rounds: 1, maxCalls: 1 }, status: "running", result: null, loopId: loop.id,
      createdAt: new Date().toISOString(), finishedAt: null, chatId: null,
    };
    writeFileSync(join(root, ".sam", "subagents.json"), JSON.stringify([ended, orphan], null, 2));
    const listed = listSubagents(root);
    const found = listed.find(s => s.id === loop.id);
    assert.equal(found?.status, "interrupted");
    assert.match(found?.result ?? "", /inspect evidence before resuming/);
    const reopened = new AgentLoopJournal(join(root, ".sam", "subagents.db"));
    const saved = reopened.get(loop.id);
    const events = reopened.events(loop.id);
    reopened.close();
    assert.equal(saved?.state, "interrupted");
    assert.equal(events.some(e => e.event === "tool_call"), true);
    assert.equal(getSubagent(root, loop.id)?.status, "interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI spawn talks to a fake provider, then list and cancel work", async () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hand subagent ok" } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const env = {
    PATH: "/usr/bin:/bin",
    SAM_MODEL_ENDPOINT: "http://127.0.0.1:" + port + "/v1/chat/completions",
    SAM_MODEL: "fake-model",
    SAM_MODEL_API_KEY: "local-test-key",
  };
  try {
    const run = (...args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "--workspace", root, "--json", ...args], { env });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", status => resolve({ status: status ?? 1, stdout, stderr }));
    });
    const spawned = await run("subagent", "spawn", "--profile", "sam", "--prompt", "Say ok", "--tools", "sam_memory_list", "--rounds", "1", "--calls", "1");
    assert.equal(spawned.status, 0, spawned.stderr);
    const body = JSON.parse(spawned.stdout);
    assert.equal(body.result, "Hand subagent ok");
    assert.deepEqual(body.tools, ["sam_memory_list"]);
    const listed = await run("subagent", "list");
    assert.equal(JSON.parse(listed.stdout)[0].id, body.id);
    const status = await run("subagent", "status", body.id);
    assert.equal(JSON.parse(status.stdout).status, "done");
    assert.ok(!spawned.stdout.includes("local-test-key"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

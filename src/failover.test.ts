import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addProvider } from "./providers.js";
import { addFallbackRoute, fallbackRoutes } from "./failover.js";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import { readActivity } from "./activity.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-failover-")); }
function env(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    SAM_ENGINE_BIN: "/nonexistent/claude",
    SAM_GOG_BIN: "/nonexistent/gog",
    SAM_MODEL_PROVIDER: "minimax",
    SAM_MODEL: "MiniMax-M2.5",
    MINIMAX_API_KEY: "minimax-secret-do-not-print",
    OPENAI_API_KEY: "openai-secret-do-not-print",
  };
}

function installEnv(next: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
  return saved;
}
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
}

test("failover: unsafe primary falls to the next route before any tool, and the hop is ledgered", async () => {
  const root = scratch();
  const saved = installEnv(env());
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" });
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" });
    assert.equal(statSync(join(root, ".sam", "fallbacks.json")).mode & 0o777, 0o600);
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("minimax")) {
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "<tool_call>junk</tool_call>" } }] }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fallback answer." } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const db = new ChatStore(root);
    const chat = db.create("Failover");
    db.close();
    const reply = await runChatTurn(root, chat.id, "compare these");
    assert.equal(reply, "Fallback answer.");
    assert.ok(calls.filter(u => u.includes("minimax")).length >= 3, "the primary's own retries run before failover");
    assert.equal(calls.filter(u => u.includes("openai")).length, 1);
    const hops = readActivity(root, 20).filter(l => l.kind === "failover");
    assert.equal(hops.length, 1);
    assert.match(hops[0].summary, /minimax\/MiniMax-M2.5 -> openai\/gpt-4.1/);
    assert.match(hops[0].summary, /Unsafe model output/);
    assert.equal(readActivity(root, 20).filter(l => l.kind === "turn-failed").length, 0);
    const check = new ChatStore(root);
    const messages = check.messages(chat.id);
    check.close();
    assert.equal(messages.filter(m => m.role === "user").length, 1, "failover does not re-save the user message");
    assert.equal(messages.filter(m => m.role === "assistant")[0].content, "Fallback answer.");
    assert.ok(!JSON.stringify(hops).includes("secret"));
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("failover: a failure after a tool has run does not switch providers", async () => {
  const root = scratch();
  const saved = installEnv(env());
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" });
    const db = new ChatStore(root);
    db.createAgent("trading", "Trade desk.", { provider: "minimax", model: "MiniMax-M2.5" });
    const chat = db.create("Tools", "trading");
    db.close();
    addFallbackRoute(root, "trading", { provider: "openai", model: "gpt-4.1" });
    let step = 0;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      step++;
      if (step === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "sam_list_skills", arguments: "{}" } }] } }] }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("nope", { status: 500, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(() => runChatTurn(root, chat.id, "list skills"), /HTTP 500/);
    assert.ok(calls.every(u => u.includes("minimax")), "the fallback provider is not called after a tool ran");
    assert.equal(readActivity(root, 20).filter(l => l.kind === "failover").length, 0);
    assert.equal(readActivity(root, 20).filter(l => l.kind === "turn-failed").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("failover: with no next route the original error still fails the turn once", async () => {
  const root = scratch();
  const saved = installEnv(env());
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { headers: { "Content-Type": "application/json" } });
    const db = new ChatStore(root);
    const chat = db.create("No fallback");
    db.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "hello"), /Empty model response|Unsafe model output|no safe visible/);
    assert.equal(readActivity(root, 20).filter(l => l.kind === "failover").length, 0);
    assert.equal(readActivity(root, 20).filter(l => l.kind === "turn-failed").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: add-fallback refuses an unknown provider and lists the route", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, "--json", ...args], { encoding: "utf8", env: env() });
  try {
    const missing = run("agents", "add-fallback", "sam", "openai", "gpt-4.1");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Unknown provider/);
    const added = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "providers", "add", "openai", "--endpoint", "https://api.openai.com/v1/chat/completions", "--key-env", "OPENAI_API_KEY", "--model", "gpt-4.1"], { encoding: "utf8", env: env() });
    assert.equal(added.status, 0, added.stderr);
    const ok = run("agents", "add-fallback", "sam", "openai", "gpt-4.1");
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(fallbackRoutes(root, "sam"), [{ provider: "openai", model: "gpt-4.1" }]);
    const listed = run("agents", "fallbacks", "sam");
    assert.equal(JSON.parse(listed.stdout).fallbacks.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

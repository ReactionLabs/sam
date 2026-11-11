import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addProvider } from "./providers.js";
import { addFallbackRoute } from "./failover.js";
import { formatRelay, parseRelayRoute, relayCommandPrompt, relayPrompt } from "./relay.js";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import { readActivity } from "./activity.js";
import { readUsage } from "./usage.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-relay-")); }

test("relay: formats labeled answers with latency and tokens, and refuses a single route", async () => {
  const root = scratch();
  try {
    assert.equal(relayCommandPrompt("hello"), null);
    assert.equal(relayCommandPrompt("/relay  two plus two "), "two plus two");
    assert.throws(() => parseRelayRoute("not a route"), /provider:model/);
    assert.deepEqual(parseRelayRoute("openai:gpt-4.1"), { provider: "openai", model: "gpt-4.1" });
    await assert.rejects(() => relayPrompt(root, "hi", [{ provider: "minimax", model: "MiniMax-M2.5" }]), /at least two/);
    const result = await relayPrompt(root, "What is 2+2?", [
      { provider: "openai", model: "gpt-4.1" },
      { provider: "minimax", model: "MiniMax-M2.5" },
    ], {
      complete: async (target) => ({
        content: target.model + " says 4",
        usage: { promptTokens: 10, completionTokens: target.model === "gpt-4.1" ? 5 : 7, totalTokens: target.model === "gpt-4.1" ? 15 : 17 },
      }),
    });
    assert.equal(result.answers.length, 2);
    assert.ok(result.answers.every(a => a.ok));
    assert.match(result.text, /openai \/ gpt-4\.1/);
    assert.match(result.text, /minimax \/ MiniMax-M2.5/);
    assert.match(result.text, /15 tokens/);
    assert.match(result.text, /17 tokens/);
    assert.match(result.text, /gpt-4.1 says 4/);
    assert.match(formatRelay(result), /ms/);
    const lines = readActivity(root, 10).filter(l => l.kind === "relay");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /2\/2 answered/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay: one model's failure stays labeled beside the other's answer", async () => {
  const root = scratch();
  try {
    const result = await relayPrompt(root, "compare", [
      { provider: "openai", model: "gpt-4.1" },
      { provider: "minimax", model: "MiniMax-M2.5" },
    ], {
      complete: async (target) => {
        if (target.provider === "minimax") throw new Error("Model request failed (HTTP 401)");
        return { content: "openai answer", usage: null };
      },
    });
    assert.equal(result.answers[0].ok, true);
    assert.equal(result.answers[1].ok, false);
    assert.match(result.text, /openai answer/);
    assert.match(result.text, /FAILED: Model request failed \(HTTP 401\)/);
    assert.match(result.text, /usage not reported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay: a /relay chat message fans out on the profile's routes and does not run tools", async () => {
  const root = scratch();
  const saved = { ...process.env };
  const oldFetch = globalThis.fetch;
  const bodies: Array<{ model: string; tools?: unknown }> = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      PATH: "/usr/bin:/bin",
      SAM_MODEL_PROVIDER: "minimax",
      SAM_MODEL: "MiniMax-M2.5",
      MINIMAX_API_KEY: "minimax-secret-do-not-print",
      OPENAI_API_KEY: "openai-secret-do-not-print",
    });
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" });
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" });
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; tools?: unknown };
      bodies.push(body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: body.model + " ready" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { headers: { "Content-Type": "application/json" } });
    };
    const db = new ChatStore(root);
    const chat = db.create("Relay chat");
    db.close();
    const reply = await runChatTurn(root, chat.id, "/relay same question");
    assert.match(reply, /minimax \/ MiniMax-M2.5/);
    assert.match(reply, /openai \/ gpt-4.1/);
    assert.match(reply, /5 tokens/);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every(b => b.tools === undefined), "relay completions do not advertise tools");
    const usage = readUsage(root);
    assert.equal(usage.length, 2);
    assert.equal(usage.reduce((n, u) => n + u.totalTokens, 0), 10);
    const check = new ChatStore(root);
    const messages = check.messages(chat.id);
    check.close();
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /same question|ready/);
    assert.ok(!reply.includes("secret"));
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: relay with two routes and no keys reports both failures and does not print a key", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5" };
  try {
    const added = spawnSync(process.execPath, [cli, "--workspace", root, "providers", "add", "openai", "--endpoint", "https://api.openai.com/v1/chat/completions", "--key-env", "OPENAI_API_KEY", "--model", "gpt-4.1"], { encoding: "utf8", env });
    assert.equal(added.status, 0, added.stderr);
    const run = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "relay", "hello brains", "--route", "minimax:MiniMax-M2.5", "--route", "openai:gpt-4.1"], { encoding: "utf8", env });
    assert.equal(run.status, 1, "every route failed, so the command exits non-zero");
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.answers.length, 2);
    assert.ok(parsed.answers.every((a: { ok: boolean }) => a.ok === false));
    assert.match(parsed.text, /FAILED:/);
    assert.doesNotMatch(run.stdout + run.stderr, /sk-/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

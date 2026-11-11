import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addProvider, listProviders, removeProvider, resolveTurnConnection } from "./providers.js";
import { ChatStore } from "./chats.js";
import { authStatus, probeAuth, readProbeStore } from "./auth-status.js";
import { runChatTurn } from "./agent-turn.js";
import { readActivity } from "./activity.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-providers-")); }
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "minimax-secret-do-not-print", ...extra });
}

test("providers: file entries store the key env name only, mode 0600, and the env provider stays reserved", () => {
  const root = scratch();
  try {
    const env = configuredEnv({ OPENAI_API_KEY: "openai-secret-do-not-print" });
    const added = addProvider(root, {
      id: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      keyEnv: "OPENAI_API_KEY",
      model: "gpt-4.1",
      cheapModel: "gpt-4.1-mini",
    }, env);
    assert.equal(added.key, "present");
    assert.equal(added.source, "file");
    const raw = readFileSync(join(root, ".sam", "providers.json"), "utf8");
    assert.ok(!raw.includes("openai-secret-do-not-print"));
    assert.ok(!raw.includes("minimax-secret-do-not-print"));
    assert.equal(statSync(join(root, ".sam", "providers.json")).mode & 0o777, 0o600);
    const ids = listProviders(root, env).map(p => p.id);
    assert.deepEqual(ids, ["minimax", "openai"]);
    assert.throws(() => addProvider(root, { id: "minimax", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, env), /reserved/);
    assert.throws(() => addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "sk-live-key", model: "gpt-4.1" }, env), /already exists|keyEnv/);
    assert.throws(() => addProvider(root, { id: "other", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "sk-live-key", model: "gpt-4.1" }, env), /keyEnv/);
    assert.throws(() => addProvider(root, { id: "other", endpoint: "http://example.com/v1/chat/completions?token=secret", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, env), /HTTPS/);
    assert.equal(removeProvider(root, "openai"), true);
    assert.deepEqual(listProviders(root, env).map(p => p.id), ["minimax"]);
    assert.throws(() => removeProvider(root, "minimax"), /environment provider/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("providers: two profiles resolve two providers at once, and a turn calls the pinned endpoint", async () => {
  const root = scratch();
  const saved = { ...process.env };
  const oldFetch = globalThis.fetch;
  const seen: Array<{ url: string; auth: string; model: string }> = [];
  try {
    const env = configuredEnv({ OPENAI_API_KEY: "openai-secret-do-not-print" });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, env);
    const db = new ChatStore(root);
    db.createAgent("trading", "Trade desk.", { provider: "openai", model: "gpt-4.1" });
    db.createAgent("research", "Research desk.", { provider: "minimax", model: "MiniMax-M2.5" });
    const trading = db.create("Trading", "trading");
    const research = db.create("Research", "research");
    db.close();
    const tradingConn = resolveTurnConnection(root, env, { provider: "openai", model: "gpt-4.1" }, "chat");
    const researchConn = resolveTurnConnection(root, env, { provider: "minimax", model: "MiniMax-M2.5" }, "chat");
    assert.equal(tradingConn.providerId, "openai");
    assert.equal(tradingConn.endpoint, "https://api.openai.com/v1/chat/completions");
    assert.equal(tradingConn.keyEnv, "OPENAI_API_KEY");
    assert.equal(researchConn.providerId, "minimax");
    assert.equal(researchConn.endpoint, "https://api.minimax.io/v1/chat/completions");
    assert.equal(researchConn.key, "present");
    assert.equal(JSON.stringify(tradingConn).includes("openai-secret"), false);
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { model: string };
      seen.push({ url: String(input), auth: headers.get("authorization") ?? "", model: body.model });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Answer from " + body.model } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const a = await runChatTurn(root, trading.id, "hello trading");
    const b = await runChatTurn(root, research.id, "hello research");
    assert.equal(a, "Answer from gpt-4.1");
    assert.equal(b, "Answer from MiniMax-M2.5");
    assert.equal(seen[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen[0].model, "gpt-4.1");
    assert.equal(seen[0].auth, "Bearer openai-secret-do-not-print");
    assert.equal(seen[1].url, "https://api.minimax.io/v1/chat/completions");
    assert.equal(seen[1].auth, "Bearer minimax-secret-do-not-print");
    const status = authStatus(root, env);
    assert.equal(status.providers.find(p => p.id === "openai")?.key, "present");
    assert.ok(!JSON.stringify(status).includes("openai-secret-do-not-print"));
    assert.ok(!JSON.stringify(readActivity(root, 20)).includes("openai-secret"));
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers: a probe verdict is persisted per provider, and a missing pin fails the turn once", async () => {
  const root = scratch();
  const saved = { ...process.env };
  try {
    const env = configuredEnv({ ANTHROPIC_API_KEY: "anthropic-secret" });
    addProvider(root, { id: "anthropic", endpoint: "https://api.anthropic.example/v1/chat/completions", keyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet" }, env);
    const seen: string[] = [];
    const run = await probeAuth(root, env, async (model) => { seen.push(model); return "ready"; });
    assert.ok(seen.includes("MiniMax-M2.5"));
    assert.ok(seen.includes("claude-sonnet"));
    assert.equal(new Set(seen).size, seen.length, "each distinct model is probed once");
    const providerRow = run.results.find(r => r.target === "provider:anthropic");
    assert.equal(providerRow?.bucket, "ok");
    assert.equal(providerRow?.kind, "provider");
    const stored = readProbeStore(root);
    assert.equal(stored?.results.find(r => r.target === "provider:anthropic")?.bucket, "ok");
    assert.ok(!readFileSync(join(root, ".sam", "auth-probes.json"), "utf8").includes("anthropic-secret"));
    const status = authStatus(root, env);
    assert.equal(status.providers.find(p => p.id === "anthropic")?.lastProbe?.bucket, "ok");
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    const db = new ChatStore(root);
    db.createAgent("ghost", "Missing provider.", { provider: "nope", model: "gpt-4.1" });
    const chat = db.create("Ghost", "ghost");
    db.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "hello"), /Profile provider unavailable: nope/);
    const failures = readActivity(root, 20).filter(l => l.kind === "turn-failed");
    assert.equal(failures.length, 1);
    assert.match(failures[0].summary, /Profile provider unavailable: nope/);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: providers add/list/remove and agents set-provider", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = configuredEnv();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, "--json", ...args], { encoding: "utf8", env });
  try {
    const added = run("providers", "add", "openai", "--endpoint", "https://api.openai.com/v1/chat/completions", "--key-env", "OPENAI_API_KEY", "--model", "gpt-4.1");
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).id, "openai");
    assert.equal(JSON.parse(added.stdout).key, "absent");
    const listed = run("providers", "list");
    assert.deepEqual(JSON.parse(listed.stdout).map((p: { id: string }) => p.id), ["minimax", "openai"]);
    const db = new ChatStore(root);
    db.createAgent("trading", "Trade desk.");
    db.close();
    const pinned = run("agents", "set-provider", "trading", "openai");
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(JSON.parse(pinned.stdout).provider, "openai");
    const cleared = run("agents", "set-provider", "trading", "none");
    assert.equal(JSON.parse(cleared.stdout).provider, null);
    const removed = run("providers", "remove", "openai");
    assert.equal(JSON.parse(removed.stdout).removed, true);
    const refused = run("providers", "add", "bad", "--endpoint", "http://example.com/v1/chat/completions", "--key-env", "OPENAI_API_KEY", "--model", "gpt-4.1");
    assert.notEqual(refused.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

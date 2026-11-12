import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observabilityReport, failureReason } from "./observability.js";
import { recordTurnFailure } from "./agent-turn.js";
import { recordUsage } from "./usage.js";
import { probeAuth } from "./auth-status.js";
import { ChatStore } from "./chats.js";
import { addProvider } from "./providers.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-observe-")); }

test("failure reasons keep the error text after the ledger prefix", () => {
  assert.equal(failureReason("Turn failed in chat 12345678 (chat): Unsafe model output"), "Unsafe model output");
  assert.equal(failureReason("no colon here"), "no colon here");
});

test("observability reports provider health, per-agent spend, activity, and failures", async () => {
  const root = scratch();
  const env = { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "minimax-secret-do-not-print", OPENAI_API_KEY: "openai-secret-do-not-print" };
  try {
    addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, env);
    const db = new ChatStore(root);
    db.createAgent("trading", "Trade desk.");
    const chat = db.create("Watch", "trading");
    db.close();
    recordUsage(root, { actor: "trading", route: "chat", tier: "main", model: "gpt-4.1", promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    recordTurnFailure(root, chat.id, "chat", new Error("Unsafe model output"));
    await probeAuth(root, env, async () => "ready");
    const report = observabilityReport(root, env);
    assert.ok(report.providerHealth.some(p => p.id === "openai" && p.key === "present" && p.health?.bucket === "ok"));
    assert.ok(report.providerHealth.some(p => p.id === "minimax" && p.health?.bucket === "ok"));
    const trading = report.agents.find(a => a.name === "trading");
    assert.ok(trading);
    assert.equal(trading?.spend.totalTokens, 7);
    assert.equal(trading?.failures.length, 1);
    assert.equal(trading?.failures[0].reason, "Unsafe model output");
    assert.equal(report.failures.length, 1);
    assert.equal(report.spend.totalTokens, 7);
    const asText = JSON.stringify(report);
    assert.ok(!asText.includes("minimax-secret"));
    assert.ok(!asText.includes("openai-secret"));
    assert.ok(report.agents.some(a => a.name === "sam"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GET /api/status requires the dashboard token and returns the observability shape", async () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "--workspace", root, "dashboard", "--port", "18771"], {
    env: { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no" },
  });
  let log = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dashboard did not start\n" + log)), 8000);
      child.stdout?.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
        const match = /http:\/\/127\.0\.0\.1:18771\/dashboard\/([0-9a-f]+)/.exec(log);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString("utf8"); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error("dashboard exited\n" + log)); });
    });
    const denied = await fetch("http://127.0.0.1:18771/api/status");
    assert.equal(denied.status, 401);
    const res = await fetch("http://127.0.0.1:18771/api/status", { headers: { Authorization: "Bearer " + url } });
    assert.equal(res.status, 200);
    const body = await res.json() as { observability: { providerHealth: unknown[]; agents: Array<{ name: string }>; spend: { totalTokens: number }; failures: unknown[] }; providerHealth: unknown[]; failures: unknown[]; usageToday?: { totalTokens: number; calls: number } };
    assert.ok(Array.isArray(body.observability.providerHealth));
    assert.ok(body.observability.agents.some(a => a.name === "sam"));
    assert.equal(typeof body.observability.spend.totalTokens, "number");
    assert.ok(Array.isArray(body.observability.failures));
    assert.ok(Array.isArray(body.providerHealth));
    assert.ok(Array.isArray(body.failures));
    assert.equal(typeof body.usageToday?.totalTokens, "number");
    assert.equal(typeof body.usageToday?.calls, "number");
    const legacy = await fetch("http://127.0.0.1:18771/api/status/" + url);
    assert.equal(legacy.status, 200);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI observe prints the same report", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "observe"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no" } });
  assert.equal(run.status, 0, run.stderr);
  const body = JSON.parse(run.stdout);
  assert.ok(Array.isArray(body.providerHealth));
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.spend);
  assert.ok(Array.isArray(body.failures));
});

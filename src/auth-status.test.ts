import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { authStatus, probeAuth, classifyProbeError, authCheckOk, modelKeyEnvName, readProbeStore } from "./auth-status.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";

// CLI dressing item 2: the auth status / probe surface. Env is built
// per test (never inherited) so a developer machine's real SAM_*
// vars cannot leak into a verdict, and probes ride stub completers -
// no test spends a real model call.
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra });
}
function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-auth-status-")); }

test("status: an unconfigured install reads unhealthy with the missing pieces as states, never values", () => {
  const root = scratch();
  try {
    const s = authStatus(root, bareEnv());
    assert.equal(s.healthy, false);
    assert.equal(s.key, "absent");
    assert.equal(s.keyEnv, "SAM_MODEL_API_KEY");
    assert.equal(s.endpoint, null);
    assert.equal(s.routes.length, 3);
    assert.ok(s.routes.every(r => r.model === null && r.lastProbe === null));
    assert.deepEqual(s.profiles.map(p => p.profile), ["sam"]);
    assert.equal(s.engine.route, "cli-reuse");
    assert.equal(s.engine.installed, false);
    assert.equal(s.lastProbeAt, null);
    assert.equal(s.setupVerified, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status: profiles resolve pin-wins exactly as a turn resolves them; secrets never appear", () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    try {
      db.createAgent("trading", "Trade desk.", { model: "MiniMax-M3" });
      db.createAgent("quiet", "No pin.");
    } finally { db.close(); }
    const s = authStatus(root, configuredEnv({ SAM_MODEL_CHEAP: "MiniMax-Cheap" }));
    assert.equal(s.healthy, true);
    assert.equal(s.keyEnv, "MINIMAX_API_KEY");
    assert.equal(s.key, "present");
    const byRoute = Object.fromEntries(s.routes.map(r => [r.route, r]));
    assert.equal(byRoute.heartbeat.model, "MiniMax-Cheap");
    assert.equal(byRoute.heartbeat.source, "cheap-env");
    assert.equal(byRoute.chat.model, "MiniMax-M2.5");
    assert.equal(byRoute.background.source, "main-env");
    const trading = s.profiles.find(p => p.profile === "trading")!;
    assert.equal(trading.model, "MiniMax-M3");
    assert.equal(trading.source, "profile");
    const quiet = s.profiles.find(p => p.profile === "quiet")!;
    assert.equal(quiet.model, "MiniMax-M2.5", "an unpinned profile resolves to the tier model");
    assert.equal(quiet.source, "main-env");
    const asText = JSON.stringify(s);
    assert.ok(!asText.includes("<redacted>"), "the API key value must never appear in the status");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classify: probe failures bucket by kind - auth, rate limit, billing, timeout, network", () => {
  assert.equal(classifyProbeError(new Error("Model request failed (HTTP 401)")).bucket, "auth");
  assert.equal(classifyProbeError(new Error("HTTP 403 Forbidden")).bucket, "auth");
  assert.equal(classifyProbeError(new Error("HTTP 429 too many requests")).bucket, "rate_limit");
  assert.equal(classifyProbeError(new Error("HTTP 402 Payment Required")).bucket, "billing");
  assert.equal(classifyProbeError(new Error("insufficient balance")).bucket, "billing");
  assert.equal(classifyProbeError(new Error("Model request timed out")).bucket, "timeout");
  assert.equal(classifyProbeError(new TypeError("fetch failed")).bucket, "network");
  assert.equal(classifyProbeError(new Error("something else entirely")).bucket, "error");
});

test("probe: one call per distinct model, buckets persist, and status reads the verdicts back", async () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    try { db.createAgent("trading", "Trade desk.", { model: "Dead-Model-1" }); } finally { db.close(); }
    const seen: string[] = [];
    const run = await probeAuth(root, configuredEnv(), async (model) => {
      seen.push(model);
      if (model === "Dead-Model-1") throw new Error("Model request failed (HTTP 401)");
      return "ready";
    });
    assert.deepEqual(seen.sort(), ["Dead-Model-1", "MiniMax-M2.5"], "routes share the main model; the pin is the only second call");
    assert.equal(run.calls, 2);
    assert.equal(run.ok, false);
    const chat = run.results.find(r => r.target === "route:chat")!;
    assert.equal(chat.bucket, "ok");
    const pin = run.results.find(r => r.target === "profile:trading")!;
    assert.equal(pin.bucket, "auth");
    assert.ok(readProbeStore(root));
    assert.ok(existsSync(join(root, ".sam", "auth-probes.db")));
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false, "the verdicts ride the SQLite store; no JSON is recreated");
    assert.ok(!readFileSync(join(root, ".sam", "auth-probes.db"), "utf8").includes("<redacted>"));
    const s = authStatus(root, configuredEnv());
    assert.equal(s.lastProbeAt, run.at);
    assert.equal(s.routes.find(r => r.route === "chat")!.lastProbe?.bucket, "ok");
    assert.equal(s.profiles.find(p => p.profile === "trading")!.lastProbe?.bucket, "auth");
    assert.equal(s.healthy, true, "a dead pin on one profile does not fail the chat-route check");
    assert.ok(readActivity(root, 50).some(l => l.kind === "auth-probe"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probe: missing key and missing endpoint bucket without any call; an empty reply buckets empty", async () => {
  const root = scratch();
  try {
    let calls = 0;
    const noKey = await probeAuth(root, bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5" }), async () => { calls++; return "ready"; });
    assert.equal(calls, 0, "no key means no call is spent");
    assert.ok(noKey.results.every(r => r.bucket === "auth"));
    const noEndpoint = await probeAuth(root, bareEnv({ SAM_MODEL: "Any-1", SAM_MODEL_API_KEY: "k" }), async () => { calls++; return "ready"; });
    assert.equal(calls, 0);
    assert.ok(noEndpoint.results.every(r => r.bucket === "missing"));
    const empty = await probeAuth(root, configuredEnv(), async () => "   ");
    assert.ok(empty.results.every(r => r.bucket === "empty"));
    const noModel = await probeAuth(root, bareEnv(), async () => "ready");
    assert.ok(noModel.results.every(r => r.bucket === "missing" && r.model === null));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check: the chat route alone decides - no model or a failed chat probe is unhealthy", async () => {
  const root = scratch();
  try {
    assert.equal(authCheckOk(authStatus(root, bareEnv())), false);
    assert.equal(authCheckOk(authStatus(root, configuredEnv())), true);
    await probeAuth(root, configuredEnv(), async () => { throw new Error("HTTP 429"); });
    const probed = authStatus(root, configuredEnv());
    assert.equal(probed.routes.find(r => r.route === "chat")!.lastProbe?.bucket, "rate_limit");
    assert.equal(authCheckOk(probed), false, "a probed-and-failing chat route fails the check");
    assert.equal(modelKeyEnvName(configuredEnv()), "MINIMAX_API_KEY");
    assert.equal(modelKeyEnvName(bareEnv({ SAM_MODEL_API_KEY: "k" })), "SAM_MODEL_API_KEY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: bare models still prints the routing table; status is scriptable; probe needs --live; --check exits by health", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, ...args], { encoding: "utf8", env });
  try {
    const bare = run(bareEnv(), "--json", "models");
    assert.equal(bare.status, 0, bare.stderr);
    assert.ok(Array.isArray(JSON.parse(bare.stdout)), "bare `sam models` keeps the P11 routing-table shape");
    const status = run(bareEnv(), "--json", "models", "status");
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.auth.healthy, false);
    assert.equal(parsed.probe, null);
    const refused = run(configuredEnv(), "models", "status", "--probe");
    assert.notEqual(refused.status, 0, "--probe without --live must refuse (explicit network opt-in)");
    const unhealthy = run(bareEnv(), "models", "status", "--check");
    assert.equal(unhealthy.status, 1, "--check on an unconfigured install exits non-zero");
    const healthy = run(configuredEnv(), "models", "status", "--check");
    assert.equal(healthy.status, 0, healthy.stderr + healthy.stdout);
    const list = run(configuredEnv(), "--json", "models", "list");
    assert.equal(JSON.parse(list.stdout).profiles[0].profile, "sam");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

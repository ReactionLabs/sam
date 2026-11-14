import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectEngine, engineConnectStatus, engineLoginPlan, engineProvider, parseCodexAuth, probeEngineAuthFor, providerBinary, readEngineConnection, readEngineProviderRecord, runEngineLogin, setEngineProvider, type EngineAuthRunner } from "./engine-connect.js";
import { readActivity } from "./activity.js";

// Codex config (Dip, 2026-11-12 14:32): the engine provider is a
// config choice (Claude Code | Codex), each probed with its own
// CLI's fixed auth argv, connected only on a signed-in verdict, and
// logged in through the provider's own login in the owner's
// terminal. Every probe/login here rides a stub runner - no test
// touches a real login and no credential exists in these fixtures.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-engine-provider-")); }

function fakeCodex(root: string): string {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}
const runnerReturning = (output: string, exitCode: number | null = 0): EngineAuthRunner => async () => ({ exitCode, output });

test("choice: default is claude-code and a pure read creates nothing; a set persists and ledgers", () => {
  const root = scratch();
  assert.equal(engineProvider(root), "claude-code");
  assert.equal(readEngineProviderRecord(root), null);
  assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing");
  const rec = setEngineProvider(root, "codex");
  assert.equal(rec.provider, "codex");
  assert.equal(engineProvider(root), "codex");
  assert.equal(readEngineProviderRecord(root)?.provider, "codex");
  assert.ok(readActivity(root, 50).some(l => l.kind === "engine-provider"));
  assert.throws(() => setEngineProvider(root, "gpt" as never), /Invalid engine provider/);
  assert.equal(engineProvider(root), "codex", "a refused set changes nothing");
});

test("binary: codex resolves SAM_CODEX_BIN, else codex on PATH; absent reads null", () => {
  const root = scratch();
  const bin = fakeCodex(root);
  assert.equal(providerBinary("codex", { SAM_CODEX_BIN: bin }), bin);
  assert.equal(providerBinary("codex", { PATH: join(root, "bin") }), bin);
  assert.equal(providerBinary("codex", { PATH: "/nonexistent-dir" }), null);
});

test("parse: codex login status text classifies, and identity never surfaces", () => {
  const signed = parseCodexAuth("Logged in using ChatGPT", 0);
  assert.equal(signed.state, "signed-in");
  assert.equal(signed.method, "chatgpt");
  assert.equal(parseCodexAuth("Not logged in", 1).state, "signed-out");
  assert.equal(parseCodexAuth("some new shape", 0).state, "unknown");
  assert.equal(parseCodexAuth("", 1).state, "unknown");
});

test("probe + connect: codex rides its own fixed argv, and the marker names the provider", async () => {
  const root = scratch();
  const bin = fakeCodex(root);
  const env = { PATH: join(root, "bin") };
  const seen: string[][] = [];
  const probe = await probeEngineAuthFor("codex", env, async (_b, args) => { seen.push(args); return { exitCode: 0, output: "Logged in using ChatGPT" }; });
  assert.equal(probe.state, "signed-in");
  assert.equal(probe.provider, "codex");
  assert.deepEqual(seen, [["login", "status"]], "the probe is exactly `codex login status`");

  const missing = await probeEngineAuthFor("codex", { PATH: "/nonexistent-dir" }, runnerReturning("Logged in using ChatGPT"));
  assert.equal(missing.state, "not-installed");

  setEngineProvider(root, "codex");
  const out = await connectEngine(root, env, runnerReturning("Logged in using ChatGPT"));
  assert.equal(out.connected, true);
  assert.equal(out.saved?.provider, "codex");
  assert.equal(readEngineConnection(root)?.provider, "codex");
  const status = engineConnectStatus(root, env);
  assert.equal(status.provider, "codex");
  assert.equal(status.connected, true);
  assert.equal(status.providers.find(p => p.provider === "codex")?.connected, true);
  assert.equal(status.providers.find(p => p.provider === "claude-code")?.connected, false);
  assert.ok(bin.length > 0);
});

test("switch: a marker for the other provider reads stale, not connected, after the choice changes", async () => {
  const root = scratch();
  const bin = fakeCodex(root);
  const env = { PATH: join(root, "bin") };
  setEngineProvider(root, "codex");
  await connectEngine(root, env, runnerReturning("Logged in using ChatGPT"));
  assert.equal(engineConnectStatus(root, env).connected, true);
  setEngineProvider(root, "claude-code");
  const status = engineConnectStatus(root, env);
  assert.equal(status.connected, false);
  assert.equal(status.stale, true);
  assert.equal(status.connection?.provider, "codex", "the marker is still shown for what it is");
});

test("legacy: a marker with no provider field reads as a claude-code marker", () => {
  const root = scratch();
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "engine-connection.json"), JSON.stringify({ route: "cli-reuse", binary: "/somewhere/claude", connectedAt: "2026-11-10T00:00:00.000Z", authState: "signed-in", authMethod: "claude.ai" }));
  const conn = readEngineConnection(root);
  assert.equal(conn?.provider, "claude-code");
  assert.equal(conn?.binary, "/somewhere/claude");
});

test("login: the plan names the provider's own argv; a clean login probes and connects, a failed one saves nothing", async () => {
  const root = scratch();
  fakeCodex(root);
  const env = { PATH: join(root, "bin") };
  const plan = engineLoginPlan("codex", env);
  assert.deepEqual(plan.argv, ["login"]);
  assert.match(plan.command ?? "", /codex login/);
  assert.equal(engineLoginPlan("codex", { PATH: "/nonexistent-dir" }).binary, null);

  setEngineProvider(root, "codex");
  const ok = await runEngineLogin(root, env, { loginRunner: async () => ({ exitCode: 0 }), authRunner: runnerReturning("Logged in using ChatGPT") });
  assert.equal(ok.connected, true);
  assert.equal(ok.loginExitCode, 0);
  assert.equal(readEngineConnection(root)?.provider, "codex");

  const root2 = scratch();
  fakeCodex(root2);
  const env2 = { PATH: join(root2, "bin") };
  setEngineProvider(root2, "codex");
  const failed = await runEngineLogin(root2, env2, { loginRunner: async () => ({ exitCode: 1 }), authRunner: runnerReturning("Logged in using ChatGPT") });
  assert.equal(failed.connected, false);
  assert.equal(readEngineConnection(root2), null, "a failed login saves nothing");

  const signedOut = await runEngineLogin(root2, env2, { loginRunner: async () => ({ exitCode: 0 }), authRunner: runnerReturning("Not logged in", 1) });
  assert.equal(signedOut.connected, false);
  assert.equal(signedOut.probe?.state, "signed-out");
  assert.equal(readEngineConnection(root2), null, "verify-before-save still binds after a login");
});

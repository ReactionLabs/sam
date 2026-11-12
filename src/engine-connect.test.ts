import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connectEngine, disconnectEngine, engineConnectStatus, parseEngineAuth, probeEngineAuth, readEngineConnection, ENGINE_AUTH_ARGV, type EngineAuthRunner } from "./engine-connect.js";
import { detectSetup, runConfigWizard } from "./config-wizard.js";
import { authStatus } from "./auth-status.js";
import { readActivity } from "./activity.js";

// CLI dressing item 3: Claude Code connect via CLI reuse. Every probe
// rides a stub runner (or a fake binary for the CLI tests) - no test
// touches a real Claude Code login, and no credential ever exists in
// these fixtures to leak.
function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-engine-connect-")); }

function fakeBinary(root: string, body: string): string {
  const bin = join(root, "claude");
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}
function envWith(bin: string): NodeJS.ProcessEnv { return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: bin }; }
const SIGNED_IN_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "owner@example.test", orgId: "org-secret-id", subscriptionType: "max" });
const runnerReturning = (output: string, exitCode: number | null = 0): EngineAuthRunner => async () => ({ exitCode, output });

test("parse: JSON signed-in reads the verdict and method, and identity fields never surface", () => {
  const parsed = parseEngineAuth(SIGNED_IN_JSON, 0);
  assert.equal(parsed.state, "signed-in");
  assert.equal(parsed.method, "claude.ai");
  const asText = JSON.stringify(parsed);
  assert.ok(!asText.includes("owner@example.test"), "the CLI's email must never surface");
  assert.ok(!asText.includes("org-secret-id"), "the CLI's org id must never surface");
  assert.equal(parseEngineAuth(JSON.stringify({ loggedIn: false }), 1).state, "signed-out");
});

test("parse: text forms classify, and an unrecognized reply is unknown - never assumed signed-in", () => {
  assert.equal(parseEngineAuth("Logged in as someone", 0).state, "signed-in");
  assert.equal(parseEngineAuth("Not logged in. Run `claude auth login`.", 1).state, "signed-out");
  assert.equal(parseEngineAuth("some entirely new output shape", 0).state, "unknown");
  assert.equal(parseEngineAuth("", 1).state, "unknown");
  assert.equal(parseEngineAuth("garbage", null).state, "unknown");
});

test("probe: no binary means not-installed and the runner is never invoked; the argv is the fixed verb", async () => {
  let calls = 0;
  const missing = await probeEngineAuth({ PATH: "/nonexistent-dir" }, async () => { calls++; return { exitCode: 0, output: SIGNED_IN_JSON }; });
  assert.equal(missing.state, "not-installed");
  assert.equal(missing.binary, null);
  assert.equal(calls, 0, "detection comes first - no binary, no run");

  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    const seen: string[][] = [];
    const probe = await probeEngineAuth(envWith(bin), async (_b, args) => { seen.push(args); return { exitCode: 0, output: SIGNED_IN_JSON }; });
    assert.equal(probe.state, "signed-in");
    assert.equal(probe.binary, bin);
    assert.deepEqual(seen, [[...ENGINE_AUTH_ARGV]], "the probe is exactly `auth status` - no caller-supplied flag can ride it");
    const timedOut = await probeEngineAuth(envWith(bin), async () => ({ exitCode: null, output: "", timedOut: true }));
    assert.equal(timedOut.state, "unknown", "a timeout is unknown, not a verdict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect: verify-before-save - signed-in records only the marker, every other verdict saves nothing", async () => {
  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    const env = envWith(bin);
    const marker = join(root, ".sam", "engine-connection.json");

    const out = await connectEngine(root, env, runnerReturning(JSON.stringify({ loggedIn: false }), 1));
    assert.equal(out.connected, false);
    assert.equal(out.probe.state, "signed-out");
    assert.equal(existsSync(marker), false, "a signed-out verdict saves nothing");
    assert.equal(readEngineConnection(root), null);

    const unknown = await connectEngine(root, env, runnerReturning("???", 0));
    assert.equal(unknown.connected, false);
    assert.equal(existsSync(marker), false, "an unknown verdict saves nothing either");

    const good = await connectEngine(root, env, runnerReturning(SIGNED_IN_JSON));
    assert.equal(good.connected, true);
    assert.ok(good.saved);
    assert.equal(good.saved!.route, "cli-reuse");
    assert.equal(good.saved!.authMethod, "claude.ai");
    assert.equal(existsSync(marker), false, "no legacy JSON marker is recreated - the connection rides the SQLite store");
    const raw = readFileSync(join(root, ".sam", "engine-connection.db"), "utf8");
    assert.ok(!raw.includes("owner@example.test") && !raw.includes("org-secret-id"), "the marker holds no identity details");
    assert.ok(!/token|secret|password/i.test(raw), "the marker holds no credential-shaped field at all");
    const status = engineConnectStatus(root, env);
    assert.equal(status.connected, true);
    assert.equal(status.stale, false);
    assert.ok(readActivity(root, 50).some(l => l.kind === "engine-connected"));
    assert.ok(!readActivity(root, 50).some(l => l.kind === "engine-disconnected"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect: not-installed saves nothing and names the operator's act", async () => {
  const root = scratch();
  try {
    const result = await connectEngine(root, { PATH: "/nonexistent-dir" }, runnerReturning(SIGNED_IN_JSON));
    assert.equal(result.connected, false);
    assert.equal(result.probe.state, "not-installed");
    assert.match(result.probe.reason, /operator's act/);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status: a marker whose binary is no longer detected reads stale, not connected", async () => {
  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    const gone = engineConnectStatus(root, { PATH: "/nonexistent-dir" });
    assert.equal(gone.connected, false);
    assert.equal(gone.stale, true);
    assert.ok(gone.connection, "the stale marker is still shown for what it is");
    mkdirSync(join(root, "sub"), { recursive: true });
    const other = fakeBinary(join(root, "sub"), "#!/bin/sh\nexit 0\n");
    const moved = engineConnectStatus(root, envWith(other));
    assert.equal(moved.connected, false, "a different binary is a different connection until re-verified");
    assert.equal(moved.stale, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disconnect: removes only SAM's marker, and a second disconnect is a clean no-op", async () => {
  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    const first = disconnectEngine(root);
    assert.equal(first.disconnected, true);
    assert.match(first.note, /never held it/);
    assert.equal(readEngineConnection(root), null);
    assert.equal(engineConnectStatus(root, envWith(bin)).connected, false);
    assert.equal(disconnectEngine(root).disconnected, false);
    assert.ok(readActivity(root, 50).some(l => l.kind === "engine-disconnected"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("surfaces: detectSetup and auth status carry the connection state", async () => {
  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    const env = { ...envWith(bin), SAM_GOG_BIN: "/nonexistent/gog" };
    assert.equal(detectSetup(root, env).engine.connected, false);
    assert.equal(authStatus(root, env).engine.connected, false);
    await connectEngine(root, env, runnerReturning(SIGNED_IN_JSON));
    const d = detectSetup(root, env);
    assert.equal(d.engine.connected, true);
    assert.equal(d.engine.connection?.authMethod, "claude.ai");
    const a = authStatus(root, env);
    assert.equal(a.engine.route, "cli-reuse");
    assert.equal(a.engine.connected, true);
    assert.equal(a.engine.stale, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wizard: the engine section offers the connect and records the marker on a signed-in verdict", async () => {
  const root = scratch();
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nexit 0\n");
    const prints: string[] = [];
    const answers = ["y"];
    const io = { print: (l: string) => prints.push(l), ask: async () => answers.shift() ?? "" };
    await runConfigWizard(root, io, { section: "engine", env: envWith(bin), engineAuthRunner: runnerReturning(SIGNED_IN_JSON) });
    assert.ok(prints.some(l => l.includes("Connected: Claude Code is the coding-engine route")));
    assert.equal(engineConnectStatus(root, envWith(bin)).connected, true);

    // A signed-out verdict connects nothing and says why.
    const root2 = scratch();
    try {
      const prints2: string[] = [];
      const io2 = { print: (l: string) => prints2.push(l), ask: async () => "y" };
      await runConfigWizard(root2, io2, { section: "engine", env: envWith(bin), engineAuthRunner: runnerReturning(JSON.stringify({ loggedIn: false }), 1) });
      assert.ok(prints2.some(l => l.includes("Not connected:")));
      assert.equal(readEngineConnection(root2), null);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: engine connect / auth --probe / status / disconnect ride a fake binary end to end", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  try {
    const bin = fakeBinary(root, "#!/bin/sh\nif [ \"$1\" = \"auth\" ]; then printf '%s' '" + SIGNED_IN_JSON.replace(/'/g, "") + "'; exit 0; fi\nexit 0\n");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", SAM_ENGINE_BIN: bin, SAM_GOG_BIN: "/nonexistent/gog" };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, ...args], { encoding: "utf8", env });

    const before = run("--json", "engine", "auth");
    assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).connection.connected, false);
    assert.equal(JSON.parse(before.stdout).probe, null, "plain auth reads the record without probing");

    const probe = run("--json", "engine", "auth", "--probe");
    assert.equal(JSON.parse(probe.stdout).probe.state, "signed-in");
    assert.equal(readEngineConnection(root), null, "a probe alone never records a connection");

    const connect = run("--json", "engine", "connect");
    assert.equal(connect.status, 0, connect.stderr);
    assert.equal(JSON.parse(connect.stdout).connected, true);
    const status = run("--json", "engine", "status");
    assert.equal(JSON.parse(status.stdout).connection.connected, true);

    const disconnect = run("--json", "engine", "disconnect");
    assert.equal(JSON.parse(disconnect.stdout).disconnected, true);
    assert.equal(readEngineConnection(root), null);

    // Not installed: connect exits non-zero, reports not-installed, saves nothing.
    const bare = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "engine", "connect"], { encoding: "utf8", env: { PATH: "/nonexistent-dir", SAM_ENGINE_BIN: "/nonexistent/claude" } });
    assert.notEqual(bare.status, 0);
    assert.equal(JSON.parse(bare.stdout).probe.state, "not-installed");
    assert.equal(readEngineConnection(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

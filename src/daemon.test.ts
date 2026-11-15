import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { requestDaemon, samVersion, socketPath, type DaemonReply } from "./daemon.js";
import { daemonTokenPath, encodeDaemonCommand, readDaemonToken } from "./daemon-auth.js";

function sendRaw(workspace: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath(workspace));
    let response = "";
    socket.setTimeout(1500, () => socket.destroy(new Error("Timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", chunk => { response += chunk.toString("utf8"); });
    socket.on("end", () => resolve(response));
  });
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  env.SAM_VAULT_DIR = join(dir, "vault");
  return env;
}

function startDaemon(dir: string, env: NodeJS.ProcessEnv): { child: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const child = spawn(process.execPath, [join(import.meta.dirname, "cli.js"), "--workspace", dir, "daemon", "serve"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  return { child, logs };
}

async function waitReady(dir: string, env: NodeJS.ProcessEnv, child: ChildProcess): Promise<DaemonReply> {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Daemon exited before ready");
    try { return await requestDaemon(dir, "ping", 200, env); } catch { await delay(50); }
  }
  throw new Error("Daemon did not start");
}

test("daemon serves status and stops over workspace-local socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-daemon-"));
  const env = childEnv(dir);
  if (process.platform !== "win32") {
    mkdirSync(join(dir, ".sam"), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, ".sam"), 0o755);
  }
  const { child, logs } = startDaemon(dir, env);
  try {
    const reply = await waitReady(dir, env, child);
    assert.equal(reply.ok, true);
    assert.equal(reply.pid, child.pid);
    assert.equal(reply.version, samVersion());
    const token = readDaemonToken(dir, env);
    assert.ok(token, "daemon must mint a control token");
    assert.equal(logs.join("").includes(token), false, "daemon logs must not contain the control token");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, ".sam")).mode & 0o777, 0o700);
      assert.equal(statSync(socketPath(dir)).mode & 0o777, 0o600);
      assert.equal(statSync(daemonTokenPath(dir, env)).mode & 0o777, 0o600);
    }
    const duplicate = spawn(process.execPath, [join(import.meta.dirname, "cli.js"), "--workspace", dir, "daemon", "serve"], { env, stdio: "ignore" });
    try {
      const exit = await Promise.race([new Promise<number | null>(r => duplicate.once("exit", r)), delay(3000).then(() => null)]);
      assert.equal(exit, 1, "Second daemon must not steal live socket");
    } finally { duplicate.kill(); }
    assert.equal((await requestDaemon(dir, "ping", 1500, env)).instance, reply.instance);

    const status = spawnSync(process.execPath, [join(import.meta.dirname, "cli.js"), "--workspace", dir, "daemon", "status"], { env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).instance, reply.instance);
    assert.equal(status.stdout.includes(token), false);
    assert.equal((status.stderr ?? "").includes(token), false);
    assert.equal([join(import.meta.dirname, "cli.js"), "--workspace", dir, "daemon", "status"].some(arg => arg.includes(token)), false);

    const malformed = JSON.parse((await sendRaw(dir, "not-json\n")).trim());
    assert.deepEqual(malformed, { ok: false, error: "Invalid request" });
    const unauthenticated = JSON.parse((await sendRaw(dir, JSON.stringify({ command: "restart" }) + "\n")).trim());
    assert.deepEqual(unauthenticated, { ok: false, error: "Unauthorized" });
    assert.equal((await requestDaemon(dir, "ping", 1500, env)).instance, reply.instance);

    const stop = spawnSync(process.execPath, [join(import.meta.dirname, "cli.js"), "--workspace", dir, "daemon", "stop"], { env, encoding: "utf8" });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).ok, true);
    assert.equal(stop.stdout.includes(token), false);
    const exit = await Promise.race([new Promise<number | null>(r => child.once("exit", r)), delay(3000).then(() => null)]);
    assert.equal(exit, 0);
    assert.equal(logs.join("").includes(token), false, "daemon logs must not contain the control token");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unauthenticated ping and stop are refused and a captured request cannot be replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-daemon-authz-"));
  const env = childEnv(dir);
  const { child, logs } = startDaemon(dir, env);
  try {
    const reply = await waitReady(dir, env, child);
    const token = readDaemonToken(dir, env);
    assert.ok(token);
    const deniedPing = JSON.parse((await sendRaw(dir, JSON.stringify({ command: "ping" }) + "\n")).trim());
    assert.deepEqual(deniedPing, { ok: false, error: "Unauthorized" });
    const deniedStop = JSON.parse((await sendRaw(dir, JSON.stringify({ command: "stop" }) + "\n")).trim());
    assert.deepEqual(deniedStop, { ok: false, error: "Unauthorized" });
    const wrong = JSON.parse((await sendRaw(dir, JSON.stringify({
      command: "stop",
      token: "f".repeat(64),
      nonce: randomBytes(16).toString("hex"),
      ts: Date.now(),
    }) + "\n")).trim());
    assert.deepEqual(wrong, { ok: false, error: "Unauthorized" });
    assert.equal(JSON.stringify(wrong).includes(token), false);

    const captured = encodeDaemonCommand(dir, "stop", env, Date.now() - 120_000);
    const stale = JSON.parse((await sendRaw(dir, captured)).trim());
    assert.deepEqual(stale, { ok: false, error: "Stale request" });
    assert.equal(captured.includes(token) && stale && logs.join("").includes(token) === false, true);

    const once = encodeDaemonCommand(dir, "ping", env);
    const first = JSON.parse((await sendRaw(dir, once)).trim());
    const second = JSON.parse((await sendRaw(dir, once)).trim());
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, error: "Replay rejected" });
    const authedUnsupported = encodeDaemonCommand(dir, "ping", env).replace("ping", "restart");
    const unsupported = JSON.parse((await sendRaw(dir, authedUnsupported)).trim());
    assert.deepEqual(unsupported, { ok: false, error: "Unsupported command" });

    assert.equal(child.exitCode, null, "refused stop must leave the daemon running");
    assert.equal((await requestDaemon(dir, "ping", 1500, env)).instance, reply.instance);
    assert.equal(logs.join("").includes(token), false);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

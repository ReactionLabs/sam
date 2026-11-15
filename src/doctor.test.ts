import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "./sqlite.js";
import { loadOrCreateDaemonToken, daemonTokenPath, samVersion } from "./daemon-auth.js";
import { DOCTOR_FIX_ALLOWLIST, runDoctor, tcpProbe, type DoctorReport } from "./doctor.js";
import { socketPath } from "./daemon.js";

const KEY = "super-secret-doctor-key";

function scratch(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "sam-doctor-"));
  return { dir, env: { PATH: process.env.PATH ?? "", SAM_VAULT_DIR: join(dir, "vault") } };
}

function byId(report: DoctorReport, id: string) {
  const found = report.checks.find(check => check.id === id);
  assert.ok(found, "missing check " + id);
  return found;
}

function down(): Promise<never> {
  const error = new Error("connect ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return Promise.reject(error);
}

test("doctor names missing env and a missing daemon token, and --fix will not create either", async () => {
  const { dir, env } = scratch();
  try {
    const report = await runDoctor(dir, { env, fix: "write-env", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(byId(report, "env").status, "fail");
    assert.equal(byId(report, "env").fixId, "write-env");
    assert.equal(byId(report, "daemon-token").status, "warn");
    assert.equal(byId(report, "daemon-token").fixId, "mint-daemon-token");
    assert.equal(byId(report, "stores").status, "ok");
    assert.equal(byId(report, "daemon-version").status, "skip");
    assert.equal(byId(report, "model").status, "skip");
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].fixId, "write-env");
    assert.equal(report.applied.length, 0);
    assert.equal(exists(join(dir, "sam.env")), false);
    assert.equal(exists(daemonTokenPath(dir, env)), false);
    const minted = await runDoctor(dir, { env, fix: "mint-daemon-token", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(minted.refused[0].fixId, "mint-daemon-token");
    assert.equal(exists(daemonTokenPath(dir, env)), false);
    assert.deepEqual([...DOCTOR_FIX_ALLOWLIST], ["remove-stale-socket", "tighten-socket-permissions"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor reports a dead store and refuses to repair it", async () => {
  const { dir, env } = scratch();
  const planted = "not-a-database-SECRET-BYTES";
  try {
    mkdirSync(join(dir, ".sam"), { recursive: true });
    const file = join(dir, ".sam", "chats.db");
    writeFileSync(file, planted);
    const report = await runDoctor(dir, { env, fix: "repair-store", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    const store = byId(report, "store:chats.db");
    assert.equal(store.status, "fail");
    assert.equal(store.fixId, "repair-store");
    assert.match(store.fix, /backup/);
    assert.equal(report.refused[0].fixId, "repair-store");
    assert.equal(report.applied.length, 0);
    assert.equal(readFileSync(file, "utf8"), planted);
    assert.equal(JSON.stringify(report).includes(planted), false);
    const allowlisted = await runDoctor(dir, { env, fix: true, ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(readFileSync(file, "utf8"), planted);
    assert.equal(allowlisted.applied.some(note => note.fixId === "repair-store"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor accepts a live store and a matching daemon version, and hides the API key", async () => {
  const { dir, env } = scratch();
  try {
    mkdirSync(join(dir, ".sam"), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(join(dir, ".sam"), 0o700);
    const db = openDatabase(join(dir, ".sam", "notes.db"));
    db.close();
    const token = loadOrCreateDaemonToken(dir, env);
    const configured = {
      ...env,
      SAM_MODEL: "MiniMax-M2.5",
      SAM_MODEL_ENDPOINT: "http://127.0.0.1:9/v1/chat/completions",
      SAM_MODEL_API_KEY: KEY,
    };
    const report = await runDoctor(dir, {
      env: configured,
      ping: async () => ({ ok: true, version: samVersion() }),
      connectHost: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });
    assert.equal(byId(report, "store:notes.db").status, "ok");
    assert.equal(byId(report, "daemon-version").status, "ok");
    assert.equal(byId(report, "daemon-token").status, "ok");
    assert.equal(byId(report, "env").status, "ok");
    const model = byId(report, "model");
    assert.equal(model.status, "fail");
    assert.equal(model.fixId, "reach-model");
    assert.match(model.evidence, /127\.0\.0\.1:9/);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    assert.equal(JSON.stringify(report).includes(token), false);
    const refused = await runDoctor(dir, {
      env: configured,
      fix: "reach-model",
      ping: async () => ({ ok: true, version: samVersion() }),
      connectHost: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });
    assert.equal(refused.refused[0].fixId, "reach-model");
    assert.equal(JSON.stringify(refused).includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("version skew and a loose token file are diagnosed and not fixed", async () => {
  const { dir, env } = scratch();
  try {
    const token = loadOrCreateDaemonToken(dir, env);
    if (process.platform !== "win32") chmodSync(daemonTokenPath(dir, env), 0o644);
    const report = await runDoctor(dir, {
      env,
      fix: "restart-daemon",
      ping: async () => ({ ok: true, version: "0.0.0-old" }),
      connectHost: async () => ({ ok: true, error: "" }),
    });
    const version = byId(report, "daemon-version");
    assert.equal(version.status, "fail");
    assert.equal(version.fixId, "restart-daemon");
    assert.match(version.evidence, /0\.0\.0-old/);
    assert.match(version.evidence, new RegExp(samVersion().replace(/[.]/g, "\\.")));
    assert.equal(report.refused[0].fixId, "restart-daemon");
    if (process.platform !== "win32") {
      const mode = await runDoctor(dir, {
        env,
        fix: true,
        ping: async () => ({ ok: true, version: samVersion() }),
        connectHost: async () => ({ ok: true, error: "" }),
      });
      assert.equal(byId(mode, "daemon-token").status, "fail");
      assert.equal(byId(mode, "daemon-token").fixId, "tighten-daemon-token-mode");
      assert.equal(statSync(daemonTokenPath(dir, env)).mode & 0o777, 0o644);
      assert.equal(mode.applied.some(note => note.fixId === "tighten-daemon-token-mode"), false);
    }
    assert.equal(JSON.stringify(report).includes(token), false);
    writeFileSync(daemonTokenPath(dir, env), "planted-token-value-ABCDEF");
    const broken = await runDoctor(dir, { env, fix: true, ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(byId(broken, "daemon-token").status, "fail");
    assert.equal(byId(broken, "daemon-token").fixId, "replace-daemon-token");
    assert.equal(readFileSync(daemonTokenPath(dir, env), "utf8"), "planted-token-value-ABCDEF");
    assert.equal(JSON.stringify(broken).includes("planted-token-value"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tcp probe connects without sending bytes, and doctor uses that for the model check", async () => {
  const { dir, env } = scratch();
  const server = createServer();
  const received: Buffer[] = [];
  server.on("connection", socket => { socket.on("data", chunk => received.push(chunk)); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
    const open = await tcpProbe("127.0.0.1", port, 1000);
    assert.equal(open.ok, true);
    await delay(30);
    assert.equal(Buffer.concat(received).length, 0);
    const report = await runDoctor(dir, {
      env: { ...env, SAM_MODEL: "local", SAM_MODEL_ENDPOINT: "http://127.0.0.1:" + port + "/v1/chat/completions", SAM_MODEL_API_KEY: KEY },
      ping: down,
    });
    assert.equal(byId(report, "model").status, "ok");
    assert.match(byId(report, "model").evidence, new RegExp("127\\.0\\.0\\.1:" + port));
    assert.equal(JSON.stringify(report).includes(KEY), false);
    server.close();
    const closed = await tcpProbe("127.0.0.1", port, 400);
    assert.equal(closed.ok, false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an endpoint with embedded credentials is refused without printing them", async () => {
  const { dir, env } = scratch();
  try {
    const report = await runDoctor(dir, {
      env: { ...env, SAM_MODEL: "local", SAM_MODEL_ENDPOINT: "http://user:" + KEY + "@127.0.0.1/v1/chat/completions", SAM_MODEL_API_KEY: KEY },
      ping: down,
      connectHost: async () => { throw new Error("probe must not run"); },
    });
    assert.equal(byId(report, "model").status, "fail");
    assert.match(byId(report, "model").evidence, /embedded credentials/);
    assert.equal(JSON.stringify(report).includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor removes only a refused stale socket and tightens socket modes", async () => {
  if (process.platform === "win32") return;
  const { dir, env } = scratch();
  let listener: ChildProcess | null = null;
  let live: Server | null = null;
  try {
    const staleDir = join(dir, "stale");
    mkdirSync(join(staleDir, ".sam"), { recursive: true });
    const sock = socketPath(staleDir);
    listener = spawn(process.execPath, ["-e", "const {createServer}=require('node:net'); const s=createServer(); s.listen(process.env.SOCK, ()=>process.stdout.write('ready\\n')); setInterval(()=>{}, 1000);"], {
      env: { ...process.env, SOCK: sock }, stdio: ["ignore", "pipe", "ignore"],
    });
    await waitReady(listener);
    listener.kill("SIGKILL");
    await new Promise(resolve => listener?.once("exit", resolve));
    listener = null;
    assert.equal(lstatSync(sock).isSocket(), true);
    const stale = await runDoctor(staleDir, { env, fix: "dump-credentials", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(stale.refused[0].fixId, "dump-credentials");
    assert.equal(lstatSync(sock).isSocket(), true, "an off-list fix must not remove the socket");
    const removed = await runDoctor(staleDir, { env, fix: true, ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(removed.applied.some(note => note.fixId === "remove-stale-socket" && /Removed stale socket/.test(note.detail)), true);
    assert.equal(exists(sock), false);
    assert.equal(byId(removed, "socket-stale").status, "ok");

    const liveDir = join(dir, "live");
    mkdirSync(join(liveDir, ".sam"), { recursive: true, mode: 0o755 });
    chmodSync(join(liveDir, ".sam"), 0o755);
    live = createServer();
    await new Promise<void>((resolve, reject) => {
      live!.once("error", reject);
      live!.listen(socketPath(liveDir), () => resolve());
    });
    chmodSync(socketPath(liveDir), 0o666);
    const tightened = await runDoctor(liveDir, { env, fix: true, ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(statSync(join(liveDir, ".sam")).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath(liveDir)).mode & 0o777, 0o600);
    assert.equal(lstatSync(socketPath(liveDir)).isSocket(), true);
    assert.equal(byId(tightened, "socket-permissions").status, "ok");
    assert.equal(byId(tightened, "socket-stale").status, "ok");

    const linkDir = join(dir, "link");
    mkdirSync(join(linkDir, ".sam"), { recursive: true });
    symlinkSync(join(linkDir, "missing-target"), socketPath(linkDir));
    const linked = await runDoctor(linkDir, { env, fix: true, ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(byId(linked, "socket-stale").fixId, "inspect-socket");
    assert.equal(lstatSync(socketPath(linkDir)).isSymbolicLink(), true);
    assert.equal(linked.applied.some(note => /Removed/.test(note.detail)), false);
  } finally {
    listener?.kill("SIGKILL");
    live?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sam doctor CLI prints per-check status and refuses an off-list fix", () => {
  const { dir, env } = scratch();
  try {
    const cli = join(import.meta.dirname, "cli.js");
    const diagnosed = spawnSync(process.execPath, [cli, "--workspace", dir, "--json", "doctor"], { env, encoding: "utf8" });
    assert.equal(diagnosed.status, 1, diagnosed.stderr);
    const report = JSON.parse(diagnosed.stdout) as DoctorReport;
    assert.equal(byId(report, "env").status, "fail");
    assert.equal(diagnosed.stdout.includes(KEY), false);
    const refused = spawnSync(process.execPath, [cli, "--workspace", dir, "doctor", "--fix", "repair-store"], { env, encoding: "utf8" });
    assert.equal(refused.status, 1, refused.stderr);
    const second = JSON.parse(refused.stdout) as DoctorReport;
    assert.equal(second.refused[0].fixId, "repair-store");
    assert.equal(second.applied.length, 0);
    assert.equal(exists(join(dir, "sam.env")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("socket holder did not start")), 3000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("ready")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("socket holder exited")); });
  });
}

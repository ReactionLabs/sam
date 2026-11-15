import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_NONCE_MEMORY,
  authorizeControlRequest,
  daemonTokenPath,
  daemonTokenStatus,
  encodeDaemonCommand,
  loadOrCreateDaemonToken,
  readDaemonToken,
} from "./daemon-auth.js";

const TOKEN = "ab".repeat(32);
const NONCE = "cd".repeat(16);
const NOW = 1_700_000_000_000;

function refused(raw: unknown, seen: string[] = [], now = NOW): string {
  const decision = authorizeControlRequest(raw, TOKEN, seen, now);
  assert.equal(decision.ok, false);
  if (decision.ok) return "";
  return decision.error;
}

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "sam-daemon-auth-"));
  return { dir, env: { SAM_VAULT_DIR: join(dir, "vault") } };
}

test("authorizeControlRequest refuses a missing token, a wrong token, and a replay", () => {
  const seen: string[] = [];
  const missing = authorizeControlRequest({ command: "stop" }, TOKEN, seen, NOW);
  assert.deepEqual(missing, { ok: false, error: "Unauthorized" });
  const wrong = authorizeControlRequest({ command: "ping", token: "f".repeat(64), nonce: NONCE, ts: NOW }, TOKEN, seen, NOW);
  assert.deepEqual(wrong, { ok: false, error: "Unauthorized" });
  assert.equal(JSON.stringify(wrong).includes("f".repeat(64)), false);
  assert.equal(JSON.stringify(wrong).includes(TOKEN), false);
  const ok = authorizeControlRequest({ command: "stop", token: TOKEN, nonce: NONCE, ts: NOW }, TOKEN, seen, NOW);
  assert.deepEqual(ok, { ok: true, command: "stop" });
  const replay = authorizeControlRequest({ command: "stop", token: TOKEN, nonce: NONCE, ts: NOW }, TOKEN, seen, NOW);
  assert.deepEqual(replay, { ok: false, error: "Replay rejected" });
  assert.deepEqual(seen, [NONCE]);
});

test("authorizeControlRequest rejects stale timestamps, bad nonces, and unknown commands without storing a nonce", () => {
  const seen: string[] = [];
  assert.equal(refused({ command: "stop", token: TOKEN, nonce: NONCE, ts: NOW - 120_000 }, seen), "Stale request");
  assert.equal(refused({ command: "stop", token: TOKEN, nonce: NONCE, ts: NOW + 120_000 }, seen), "Stale request");
  assert.equal(refused({ command: "stop", token: TOKEN, nonce: "short", ts: NOW }, seen), "Invalid request");
  assert.equal(refused({ command: "restart", token: TOKEN, nonce: NONCE, ts: NOW }, seen), "Unsupported command");
  assert.equal(refused("not-an-object", seen), "Invalid request");
  assert.deepEqual(seen, []);
});

test("unauthenticated requests do not evict an accepted nonce", () => {
  const seen = [NONCE];
  for (let i = 0; i < 1000; i++) authorizeControlRequest({ command: "stop", token: "nope" }, TOKEN, seen, NOW);
  assert.deepEqual(seen, [NONCE]);
  assert.equal(refused({ command: "ping", token: TOKEN, nonce: NONCE, ts: NOW }, seen), "Replay rejected");
});

test("nonce memory stays bounded", () => {
  const seen: string[] = [];
  const first = "11".repeat(16);
  assert.equal(authorizeControlRequest({ command: "ping", token: TOKEN, nonce: first, ts: NOW }, TOKEN, seen, NOW).ok, true);
  for (let i = 0; i < DAEMON_NONCE_MEMORY; i++) {
    const nonce = i.toString(16).padStart(32, "0");
    assert.equal(authorizeControlRequest({ command: "ping", token: TOKEN, nonce, ts: NOW }, TOKEN, seen, NOW).ok, true);
  }
  assert.equal(seen.length, DAEMON_NONCE_MEMORY);
  assert.equal(seen.includes(first), false);
});

test("the control token is minted under the vault directory, owner-only, and status never carries the value", () => {
  const { dir, env } = workspace();
  try {
    assert.equal(readDaemonToken(dir, env), null);
    assert.throws(() => encodeDaemonCommand(dir, "ping", env), /Daemon control token is missing/);
    assert.equal(existsSyncToken(dir, env), false, "a failed client read must not mint a token");
    const token = loadOrCreateDaemonToken(dir, env);
    assert.equal(loadOrCreateDaemonToken(dir, env), token);
    assert.equal(readDaemonToken(dir, env), token);
    const file = daemonTokenPath(dir, env);
    assert.equal(file.startsWith(join(dir, "vault")), true);
    assert.equal(file.startsWith(join(dir, ".sam")), false);
    const status = daemonTokenStatus(dir, env);
    assert.equal(status.present, true);
    assert.equal(status.wellFormed, true);
    assert.equal(JSON.stringify(status).includes(token), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "vault")).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "vault", "daemon")).mode & 0o777, 0o700);
      assert.equal(status.mode, 0o600);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const wire = encodeDaemonCommand(dir, "ping", env);
    assert.equal(wire.includes(token), true);
    assert.equal(wire.endsWith("\n"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed token file is not echoed and is not overwritten", () => {
  const { dir, env } = workspace();
  const planted = "super-secret-not-a-token";
  try {
    const token = loadOrCreateDaemonToken(dir, env);
    const file = daemonTokenPath(dir, env);
    writeFileSync(file, planted, { mode: 0o600 });
    assert.equal(readDaemonToken(dir, env), null);
    assert.equal(JSON.stringify(daemonTokenStatus(dir, env)).includes(planted), false);
    assert.equal(daemonTokenStatus(dir, env).wellFormed, false);
    assert.throws(() => loadOrCreateDaemonToken(dir, env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Daemon control token file is unreadable");
      assert.equal(error.message.includes(planted), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(readFileSync(file, "utf8"), planted);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loose token-file mode is tightened on load", () => {
  if (process.platform === "win32") return;
  const { dir, env } = workspace();
  try {
    loadOrCreateDaemonToken(dir, env);
    const file = daemonTokenPath(dir, env);
    chmodSync(file, 0o644);
    loadOrCreateDaemonToken(dir, env);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function existsSyncToken(dir: string, env: NodeJS.ProcessEnv): boolean {
  try { return readDaemonToken(dir, env) !== null || daemonTokenStatus(dir, env).present; }
  catch { return false; }
}

import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { vaultDir } from "./vault.js";

/**
 * Per-installation authorization for the local daemon control
 * channel (issue #22). The Unix socket is mode 0600 inside a 0700
 * directory, and the Windows pipe name is a hash, but neither is
 * an application-layer check: any client that can connect could
 * ping or stop the daemon.
 *
 * The check is a bearer token minted by this install. Custody
 * matches the vault: the file lives under the vault directory
 * (outside .sam, so a P9 state backup never carries it), the
 * directory is 0700, and the file is 0600. It is not a vault
 * credential row. Those rows are operator-deposited third-party
 * secrets; this token is minted by the install, listed nowhere,
 * and never returned by a status surface.
 *
 * The value is never passed on argv and never written to a log,
 * a ledger line, or an error message.
 */

const TOKEN_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

/** How far a control request's timestamp may sit from the daemon clock. */
export const DAEMON_REQUEST_WINDOW_MS = 60_000;
/** Nonces remembered so a captured request cannot be replayed inside the window. */
export const DAEMON_NONCE_MEMORY = 256;

export type DaemonCommand = "ping" | "stop";

export interface DaemonAuthOk { ok: true; command: DaemonCommand }
export interface DaemonAuthReject { ok: false; error: "Unauthorized" | "Replay rejected" | "Stale request" | "Invalid request" | "Unsupported command" }
export type DaemonAuthDecision = DaemonAuthOk | DaemonAuthReject;

let cachedVersion: string | null = null;

/** Package version captured when this process loaded. An older
 *  daemon process keeps the version it started with, which is
 *  how doctor tells CLI and daemon apart after an upgrade. */
export function samVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof version === "string" && version.trim() ? version.trim() : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export function daemonTokenPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(resolve(workspace)).digest("hex");
  return join(vaultDir(workspace, env), "daemon", key);
}

function chmodOwner(path: string, mode: number): void {
  if (process.platform === "win32") {
    try { chmodSync(path, mode); } catch { /* POSIX modes are not the Windows contract */ }
    return;
  }
  chmodSync(path, mode);
}

function readTokenFile(file: string): string | null {
  try {
    const token = readFileSync(file, "utf8").trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Mint the token if this install does not have one yet, then
 *  return it. Callers are the daemon process and nothing else
 *  that would print the return value. */
export function loadOrCreateDaemonToken(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = daemonTokenPath(workspace, env);
  const dir = dirname(file);
  const root = dirname(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodOwner(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodOwner(dir, 0o700);
  if (!existsSync(file)) {
    const created = randomBytes(32).toString("hex");
    try {
      writeFileSync(file, created, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  chmodOwner(file, 0o600);
  const token = readTokenFile(file);
  if (!token) throw new Error("Daemon control token file is unreadable");
  return token;
}

/** Read the token, or null when this install has not minted one.
 *  Does not create the file. */
export function readDaemonToken(workspace: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const file = daemonTokenPath(workspace, env);
  if (!existsSync(file)) return null;
  return readTokenFile(file);
}

/** What a diagnostic may say. The token value is not a field. */
export interface DaemonTokenStatus {
  present: boolean;
  wellFormed: boolean;
  /** Owner mode bits, or null where POSIX modes are not the contract. */
  mode: number | null;
}

export function daemonTokenStatus(workspace: string, env: NodeJS.ProcessEnv = process.env): DaemonTokenStatus {
  const file = daemonTokenPath(workspace, env);
  if (!existsSync(file)) return { present: false, wellFormed: false, mode: null };
  const wellFormed = readTokenFile(file) !== null;
  if (process.platform === "win32") return { present: true, wellFormed, mode: null };
  try {
    return { present: true, wellFormed, mode: statSync(file).mode & 0o777 };
  } catch {
    return { present: true, wellFormed, mode: null };
  }
}

/** Constant-time compare. A length mismatch still touches the
 *  expected token so the reject path does not return early on size. */
export function controlTokenMatches(presented: unknown, expected: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const presentedBuf = Buffer.from(typeof presented === "string" ? presented : "", "utf8");
  if (typeof presented !== "string" || presentedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/**
 * Decide one control request. `seen` is the daemon's nonce memory
 * (oldest first) and is updated only after the token, timestamp,
 * and nonce all pass, so an unauthenticated client cannot fill it.
 * The returned error names are the wire errors; they never include
 * the token or the request body.
 */
export function authorizeControlRequest(raw: unknown, expectedToken: string, seen: string[], now: number): DaemonAuthDecision {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid request" };
  const body = raw as Record<string, unknown>;
  if (!controlTokenMatches(body.token, expectedToken)) return { ok: false, error: "Unauthorized" };
  if (typeof body.ts !== "number" || !Number.isFinite(body.ts) || Math.abs(now - body.ts) > DAEMON_REQUEST_WINDOW_MS) {
    return { ok: false, error: "Stale request" };
  }
  if (typeof body.nonce !== "string" || !NONCE_RE.test(body.nonce)) return { ok: false, error: "Invalid request" };
  if (seen.includes(body.nonce)) return { ok: false, error: "Replay rejected" };
  if (body.command !== "ping" && body.command !== "stop") return { ok: false, error: "Unsupported command" };
  seen.push(body.nonce);
  while (seen.length > DAEMON_NONCE_MEMORY) seen.shift();
  return { ok: true, command: body.command };
}

/** One control line. The caller writes it to the socket and does
 *  not log it. Throws when this install has no token yet. */
export function encodeDaemonCommand(workspace: string, command: DaemonCommand, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const token = readDaemonToken(workspace, env);
  if (!token) throw new Error("Daemon control token is missing");
  return JSON.stringify({
    command,
    token,
    nonce: randomBytes(16).toString("hex"),
    ts: now,
  }) + "\n";
}

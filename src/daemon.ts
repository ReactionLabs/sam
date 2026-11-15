import { createServer, connect, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  authorizeControlRequest,
  encodeDaemonCommand,
  loadOrCreateDaemonToken,
  samVersion,
  type DaemonCommand,
} from "./daemon-auth.js";

export { samVersion } from "./daemon-auth.js";

export function socketPath(workspace: string): string {
  if (process.platform === "win32") {
    // Windows local IPC uses a named pipe, not a filesystem socket.
    // Hash the canonical workspace path for a stable, non-disclosing pipe name.
    const key = createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\sam-${key}`;
  }
  return join(resolve(workspace), ".sam", "daemon.sock");
}

export type DaemonReply = { ok: boolean; pid?: number; instance?: string; uptime?: number; version?: string; error?: string };

export function requestDaemon(workspace: string, command: DaemonCommand, timeoutMs = 1500, env: NodeJS.ProcessEnv = process.env): Promise<DaemonReply> {
  return new Promise((resolveReply, reject) => {
    let payload: string;
    try { payload = encodeDaemonCommand(workspace, command, env); }
    catch (error) { reject(error instanceof Error ? error : new Error("Daemon control token is missing")); return; }
    const socket = connect(socketPath(workspace));
    let buffer = "", settled = false;
    const finish = (error?: Error, reply?: DaemonReply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolveReply(reply!);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Daemon request timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4096) { finish(new Error("Daemon reply too large")); return; }
      const line = buffer.indexOf("\n");
      if (line !== -1) {
        try { finish(undefined, JSON.parse(buffer.slice(0, line)) as DaemonReply); }
        catch { finish(new Error("Invalid daemon response")); }
      }
    });
    socket.on("end", () => { if (!settled) finish(new Error("Daemon closed without response")); });
  });
}

function tightenSocket(workspace: string, path: string): void {
  // Node's net module creates Windows named pipes with a null
  // security descriptor and exposes no ACL handle. The pipe name
  // stays a hash; cross-user denial on Windows is the token check
  // in authorizeControlRequest. On Unix the directory and the
  // socket themselves deny other users.
  if (process.platform === "win32") return;
  chmodSync(join(resolve(workspace), ".sam"), 0o700);
  chmodSync(path, 0o600);
}

export async function serveDaemon(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = socketPath(workspace);
  mkdirSync(join(resolve(workspace), ".sam"), { recursive: true, mode: 0o700 });
  // Mint (or load) the token before the stale-socket probe so this
  // process can authenticate to a daemon that is already up. Held
  // in memory for compares; never written to a log line.
  const token = loadOrCreateDaemonToken(workspace, env);
  // Only remove a stale socket after a failed connection. Never unlink a live daemon.
  if (process.platform !== "win32" && existsSync(path)) {
    try { await requestDaemon(workspace, "ping", 1500, env); throw new Error("Daemon already running"); }
    catch (error) {
      if (error instanceof Error && error.message === "Daemon already running") throw error;
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ECONNREFUSED"))
        throw new Error("Socket exists but daemon health cannot be verified; refusing to remove it");
      unlinkSync(path);
    }
  }
  const instance = randomUUID(), started = Date.now();
  const version = samVersion();
  const seen: string[] = [];
  let stopping = false;
  const server: Server = createServer(socket => {
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      const index = input.indexOf("\n");
      if (index < 0) return;
      let parsed: unknown;
      try { parsed = JSON.parse(input.slice(0, index)); }
      catch { socket.end(JSON.stringify({ ok: false, error: "Invalid request" }) + "\n"); return; }
      const decision = authorizeControlRequest(parsed, token, seen, Date.now());
      if (!decision.ok) {
        socket.end(JSON.stringify({ ok: false, error: decision.error }) + "\n");
        return;
      }
      if (decision.command === "ping") {
        socket.end(JSON.stringify({ ok: true, pid: process.pid, instance, uptime: Date.now() - started, version }) + "\n");
      } else if (decision.command === "stop") {
        socket.end(JSON.stringify({ ok: true, pid: process.pid }) + "\n", () => { if (!stopping) { stopping = true; server.close(); } });
      }
    });
  });
  try {
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(path, () => { server.off("error", rej); res(); });
    });
    tightenSocket(workspace, path);
    await new Promise<void>(res => {
      const shutdown = () => { if (!stopping) { stopping = true; server.close(); } };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      server.once("close", res);
    });
  } finally {
    // The socket belongs to this instance only while no replacement exists.
    // A second daemon cannot bind until the first closes.
    if (process.platform !== "win32") {
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

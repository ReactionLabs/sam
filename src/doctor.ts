import { connect } from "node:net";
import { chmodSync, existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "./sqlite.js";
import { modelApiKey, modelEndpoint } from "./config-wizard.js";
import { modelRoutingTable } from "./model-routing.js";
import { workspaceEnvPath } from "./setup.js";
import { daemonTokenStatus, samVersion } from "./daemon-auth.js";
import { requestDaemon, socketPath, type DaemonReply } from "./daemon.js";
import { errorReason } from "./error-reason.js";

/**
 * sam doctor (issue #33, sprint item 5). Each check reports a
 * status, the evidence, and a named fix. --fix applies only
 * DOCTOR_FIX_ALLOWLIST. Those two fixes are reversible file
 * operations on the daemon socket: remove a socket that refuses
 * connections, and restore the 0700/0600 modes the daemon already
 * sets. Nothing else is written. Credential files, sam.env, and
 * store databases are never modified.
 */

export const DOCTOR_FIX_ALLOWLIST = ["remove-stale-socket", "tighten-socket-permissions"] as const;
export type DoctorFixId = (typeof DOCTOR_FIX_ALLOWLIST)[number];

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  evidence: string;
  /** What the owner can do. Empty when the check passed. */
  fix: string;
  /** Machine name of the fix, or null when there is nothing to apply. */
  fixId: string | null;
}

export interface DoctorFixNote { fixId: string; detail: string }
export interface DoctorReport {
  checks: DoctorCheck[];
  allowlist: readonly string[];
  applied: DoctorFixNote[];
  refused: DoctorFixNote[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** true applies every allowlisted fix for a failing check. A string attempts that id only. */
  fix?: boolean | string;
  ping?: (workspace: string, env: NodeJS.ProcessEnv) => Promise<DaemonReply>;
  /** TCP reachability. Must not send the API key. */
  connectHost?: (host: string, port: number) => Promise<{ ok: boolean; error: string }>;
  probeSocket?: (path: string) => Promise<"missing" | "open" | "refused" | "error">;
}

const ALLOWLIST_REASON = "not on the doctor fix allowlist (" + DOCTOR_FIX_ALLOWLIST.join(", ") + "). Doctor does not change credentials, stores, env files, or a live daemon.";

function check(id: string, status: DoctorStatus, evidence: string, fix = "", fixId: string | null = null): DoctorCheck {
  return { id, status, evidence, fix, fixId };
}

export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<{ ok: boolean; error: string }> {
  return new Promise(resolveProbe => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok: boolean, error: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({ ok, error });
    };
    socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
    socket.on("connect", () => finish(true, ""));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(false, error.code || "error"));
  });
}

export function probeControlSocket(path: string, timeoutMs = 400): Promise<"missing" | "open" | "refused" | "error"> {
  return new Promise(resolveProbe => {
    let settled = false;
    const socket = connect(path);
    const finish = (result: "missing" | "open" | "refused" | "error") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.setTimeout(timeoutMs, () => finish("error"));
    socket.on("connect", () => finish("open"));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish("missing");
      else if (error.code === "ECONNREFUSED") finish("refused");
      else finish("error");
    });
  });
}

function posixMode(path: string): number | null {
  if (process.platform === "win32") return null;
  try { return lstatSync(path).mode & 0o777; } catch { return null; }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function reasonOf(error: unknown): string {
  return errorReason(error).replace(/\s+/g, " ").trim().slice(0, 180);
}

function storeChecks(root: string): DoctorCheck[] {
  const dir = join(resolve(root), ".sam");
  if (!existsSync(dir)) return [check("stores", "ok", "No .sam state directory yet.")];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(name => name.endsWith(".db")).sort();
  } catch (error) {
    return [check("stores", "fail", "Could not read .sam: " + reasonOf(error), "Restore the state directory from a verified backup. Doctor does not rewrite stores.", "repair-store")];
  }
  if (!names.length) return [check("stores", "ok", "No database files in .sam.")];
  return names.map(name => {
    const file = join(dir, name);
    try {
      const db = openDatabase(file, { readonly: true, fileMustExist: true });
      try {
        const row = db.pragma("integrity_check", { simple: true });
        if (row !== "ok") {
          return check("store:" + name, "fail", name + " failed integrity_check.", "Restore " + name + " from a verified backup (`sam backup`). Doctor does not rewrite stores.", "repair-store");
        }
        return check("store:" + name, "ok", name + " opened read-only and integrity_check returned ok.");
      } finally { db.close(); }
    } catch (error) {
      return check("store:" + name, "fail", name + " is not a readable store: " + reasonOf(error), "Restore " + name + " from a verified backup (`sam backup`). Doctor does not rewrite stores.", "repair-store");
    }
  });
}

async function socketChecks(root: string, probe: (path: string) => Promise<"missing" | "open" | "refused" | "error">): Promise<DoctorCheck[]> {
  const path = socketPath(root);
  const dir = join(resolve(root), ".sam");
  if (process.platform === "win32") {
    const state = await probe(path);
    return [
      check("socket-stale", "skip", "Windows uses a named pipe (" + (state === "open" ? "a listener accepted a connection" : "nothing is listening") + "). There is no socket file to go stale."),
      check("socket-permissions", "skip", "Windows named-pipe ACLs are not set by node:net. Cross-user control is the daemon token, not a file mode."),
    ];
  }
  const checks: DoctorCheck[] = [];
  // lstat, not existsSync: a dangling symlink must be named and
  // left alone, not reported as "no socket".
  const linked = isSymlink(path);
  if (linked) {
    checks.push(check("socket-stale", "fail", "The daemon socket path is a symlink. Doctor will not follow or remove it.", "Replace the symlink with a socket created by `sam daemon serve`.", "inspect-socket"));
  } else if (!existsSync(path)) {
    checks.push(check("socket-stale", "ok", "No daemon socket file."));
  } else {
    const state = await probe(path);
    if (state === "refused") {
      checks.push(check("socket-stale", "fail", "Socket file exists but connections are refused (stale socket).", "Remove the stale socket file. Allowlisted as remove-stale-socket; a live socket is not removed.", "remove-stale-socket"));
    } else if (state === "open") {
      checks.push(check("socket-stale", "ok", "A listener accepted a connection on the daemon socket."));
    } else {
      checks.push(check("socket-stale", "fail", "Socket file exists but its health could not be proved (" + state + ").", "Inspect the daemon. Doctor will not remove a socket it could not prove is stale.", "inspect-socket"));
    }
  }
  const loose: string[] = [];
  if (existsSync(dir) && !isSymlink(dir)) {
    const mode = posixMode(dir);
    if (mode !== null && mode !== 0o700) loose.push(".sam is mode " + mode.toString(8) + ", expected 700");
  }
  if (existsSync(path) && !isSymlink(path)) {
    try {
      const st = lstatSync(path);
      if (st.isSocket()) {
        const mode = st.mode & 0o777;
        if (mode !== 0o600) loose.push("daemon socket is mode " + mode.toString(8) + ", expected 600");
      }
    } catch { /* the stale check already named a missing socket */ }
  }
  if (loose.length) {
    checks.push(check("socket-permissions", "fail", loose.join("; ") + ".", "Restore owner-only modes (directory 0700, socket 0600). Allowlisted as tighten-socket-permissions.", "tighten-socket-permissions"));
  } else {
    checks.push(check("socket-permissions", "ok", existsSync(dir) || existsSync(path) ? "Socket directory and socket are owner-only, or not present." : "No socket directory to check."));
  }
  return checks;
}

function envCheck(root: string, env: NodeJS.ProcessEnv): DoctorCheck {
  const missing: string[] = [];
  let endpoint: string | null = null;
  let keyPresent = false;
  try {
    const model = modelRoutingTable(env).find(row => row.route === "chat")?.model ?? null;
    endpoint = modelEndpoint(env);
    keyPresent = !!modelApiKey(env);
    if (!model) missing.push("SAM_MODEL");
    if (!endpoint) missing.push("SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT");
    if (!keyPresent) missing.push("SAM_MODEL_API_KEY (or MINIMAX_API_KEY for minimax)");
  } catch (error) {
    const reason = errorReason(error);
    return check("env", "fail", "Configuration could not be parsed: " + reason, "Fix the named variable. Doctor does not write sam.env or any credential.", "write-env");
  }
  const envFile = existsSync(workspaceEnvPath(root)) ? "sam.env is present" : "sam.env is absent";
  if (missing.length) {
    return check("env", "fail", "Missing " + missing.join("; ") + ". " + envFile + ". Values are not shown.", "Run `sam setup` or export the missing names. Doctor does not write sam.env or any credential.", "write-env");
  }
  return check("env", "ok", "Model, endpoint, and API key are set. " + envFile + ". Values are not shown.");
}

function endpointTarget(endpoint: string, key: string | null): { host: string; port: number } | { error: string } {
  const hidesKey = !!key && key.length >= 12 && endpoint.includes(key);
  let url: URL;
  try { url = new URL(endpoint); }
  catch { return { error: hidesKey ? "endpoint value withheld because it contains the API key" : "endpoint is not a URL" }; }
  if (url.username || url.password || hidesKey) return { error: "endpoint URL has embedded credentials; doctor will not connect or print it" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "endpoint protocol is " + url.protocol + "; doctor only connects to http(s)" };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "endpoint port is not usable" };
  return { host: url.hostname, port };
}

async function modelCheck(env: NodeJS.ProcessEnv, connectHost: (host: string, port: number) => Promise<{ ok: boolean; error: string }>): Promise<DoctorCheck> {
  let endpoint: string | null;
  let key: string | null;
  try {
    endpoint = modelEndpoint(env);
    key = modelApiKey(env);
  } catch (error) {
    const reason = errorReason(error);
    return check("model", "fail", "Model endpoint could not be read: " + reason, "Correct the endpoint. Doctor does not call the model or change credentials.", "reach-model");
  }
  if (!endpoint) return check("model", "skip", "No model endpoint configured (see env).");
  const target = endpointTarget(endpoint, key);
  if ("error" in target) {
    return check("model", "fail", target.error, "Point SAM_MODEL_ENDPOINT at an http(s) URL with no embedded credentials. Doctor does not change it.", "reach-model");
  }
  const result = await connectHost(target.host, target.port);
  if (result.ok) return check("model", "ok", "TCP connect to " + target.host + ":" + target.port + " succeeded. No request was sent and the API key was not used.");
  return check("model", "fail", "TCP connect to " + target.host + ":" + target.port + " failed: " + result.error + ". No request was sent and the API key was not used.", "Confirm the model host is reachable. Doctor does not change the endpoint or the key.", "reach-model");
}

async function versionCheck(root: string, env: NodeJS.ProcessEnv, ping: (workspace: string, env: NodeJS.ProcessEnv) => Promise<DaemonReply>): Promise<DoctorCheck> {
  const expected = samVersion();
  try {
    const reply = await ping(root, env);
    if (!reply.ok) {
      return check("daemon-version", "fail", "Daemon refused the control command (" + (reply.error || "not ok") + "). The token was not logged.", "Confirm the CLI and the daemon share this install's control token. Doctor does not print or rewrite it.", "inspect-daemon-auth");
    }
    if (reply.version === expected) return check("daemon-version", "ok", "Daemon version " + expected + " matches this CLI.");
    return check("daemon-version", "fail", "CLI version " + expected + " and daemon version " + (reply.version || "unreported") + " differ.", "Stop the daemon and start it again with this CLI (`sam daemon stop`, then `sam daemon serve`). Doctor will not stop a live daemon.", "restart-daemon");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Daemon control token is missing") {
      return check("daemon-version", "skip", "No control token, so the daemon version was not queried.");
    }
    if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ECONNRESET") {
      return check("daemon-version", "skip", "Daemon is not running.");
    }
    return check("daemon-version", "fail", "Daemon version could not be read: " + errorReason(error), "Inspect `sam daemon status`. Doctor will not stop a live daemon.", "restart-daemon");
  }
}

function tokenCheck(root: string, env: NodeJS.ProcessEnv): DoctorCheck {
  const status = daemonTokenStatus(root, env);
  if (!status.present) {
    return check("daemon-token", "warn", "No per-installation daemon control token yet.", "Start `sam daemon serve` once so the install can mint the token. Doctor does not create or print credentials.", "mint-daemon-token");
  }
  if (!status.wellFormed) {
    return check("daemon-token", "fail", "The daemon control token file is present but not a usable token. The value was not read into this report.", "Stop the daemon and remove the token file so the next `sam daemon serve` mints a new one. Doctor will not rewrite credential files.", "replace-daemon-token");
  }
  if (status.mode !== null && status.mode !== 0o600) {
    return check("daemon-token", "fail", "The daemon control token file is mode " + status.mode.toString(8) + ", expected 600. The value was not read into this report.", "Start `sam daemon serve`; it tightens the file to owner-read/write. Doctor will not chmod credential files.", "tighten-daemon-token-mode");
  }
  return check("daemon-token", "ok", status.mode === null ? "Control token file is present and well formed. The value was not read into this report." : "Control token file is present, mode 600. The value was not read into this report.");
}

function defaultPing(workspace: string, env: NodeJS.ProcessEnv): Promise<DaemonReply> {
  return requestDaemon(workspace, "ping", 800, env);
}

async function diagnose(root: string, env: NodeJS.ProcessEnv, options: DoctorOptions): Promise<DoctorCheck[]> {
  const probe = options.probeSocket ?? probeControlSocket;
  const connectHost = options.connectHost ?? ((host, port) => tcpProbe(host, port));
  const ping = options.ping ?? defaultPing;
  const [sockets, model, version] = await Promise.all([
    socketChecks(root, probe),
    modelCheck(env, connectHost),
    versionCheck(root, env, ping),
  ]);
  return [
    check("runtime", "ok", "node " + process.version + ", platform " + process.platform + ", CLI " + samVersion()),
    ...storeChecks(root),
    ...sockets,
    envCheck(root, env),
    version,
    model,
    tokenCheck(root, env),
  ];
}

function applyAllowlisted(root: string, fixId: DoctorFixId, probe: (path: string) => Promise<"missing" | "open" | "refused" | "error">): Promise<string> {
  if (fixId === "remove-stale-socket") return removeStaleSocket(root, probe);
  return Promise.resolve(tightenSocketPermissions(root));
}

async function removeStaleSocket(root: string, probe: (path: string) => Promise<"missing" | "open" | "refused" | "error">): Promise<string> {
  if (process.platform === "win32") return "No socket file on Windows; nothing removed.";
  const path = socketPath(root);
  if (isSymlink(path)) return "Refused: the socket path is a symlink.";
  if (!existsSync(path)) return "No socket file to remove.";
  const state = await probe(path);
  if (state !== "refused") return "Refused: the socket is not a stale refused connection (" + state + ").";
  unlinkSync(path);
  return "Removed stale socket " + path + ".";
}

function tightenSocketPermissions(root: string): string {
  if (process.platform === "win32") return "Socket file modes are not the Windows contract; nothing changed.";
  const notes: string[] = [];
  const dir = join(resolve(root), ".sam");
  if (existsSync(dir) && !isSymlink(dir) && lstatSync(dir).isDirectory()) {
    const mode = lstatSync(dir).mode & 0o777;
    if (mode !== 0o700) { chmodSync(dir, 0o700); notes.push(".sam set to 0700"); }
  }
  const path = socketPath(root);
  if (existsSync(path) && !isSymlink(path) && lstatSync(path).isSocket()) {
    const mode = lstatSync(path).mode & 0o777;
    if (mode !== 0o600) { chmodSync(path, 0o600); notes.push("daemon socket set to 0600"); }
  }
  return notes.length ? notes.join("; ") + "." : "Permissions already owner-only; nothing changed.";
}

export async function runDoctor(root: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const probe = options.probeSocket ?? probeControlSocket;
  const requested = options.fix;
  const refused: DoctorFixNote[] = [];
  const applied: DoctorFixNote[] = [];
  if (typeof requested === "string" && !(DOCTOR_FIX_ALLOWLIST as readonly string[]).includes(requested)) {
    refused.push({ fixId: requested, detail: ALLOWLIST_REASON });
  } else if (requested === true || typeof requested === "string") {
    const before = await diagnose(root, env, options);
    const wanted = new Set<string>();
    if (requested === true) {
      for (const item of before) if (item.status === "fail" && item.fixId && (DOCTOR_FIX_ALLOWLIST as readonly string[]).includes(item.fixId)) wanted.add(item.fixId);
    } else wanted.add(requested);
    for (const fixId of wanted) {
      const failing = before.some(item => item.status === "fail" && item.fixId === fixId);
      if (!failing) {
        applied.push({ fixId, detail: "Not applied: no failing check names this fix." });
        continue;
      }
      applied.push({ fixId, detail: await applyAllowlisted(root, fixId as DoctorFixId, probe) });
    }
  }
  const checks = await diagnose(root, env, options);
  return { checks, allowlist: DOCTOR_FIX_ALLOWLIST, applied, refused };
}

/**
 * The doctor as a P3-stable scorecard (gap found 2026-11-18):
 * doctor was the one diagnostic surface with no plain-text
 * trending form - no scorecard, no script allowlist entry, no
 * daily job - so a live store corrupting, a socket going
 * stale, or the control token loosening would surface only
 * when a turn died on it or someone ran doctor by hand. The
 * text carries ONLY the verdict, the per-status counts, and
 * one id: status line per check in report order: never the
 * evidence, a fix text, a version, a host, a mode, or a
 * reason, each free text or a moving value. Two diagnoses of
 * the same install state produce byte-identical text P3
 * judges the same news; a check flipping status, or a store
 * appearing or vanishing, changes the text and is the news.
 * The scorecard path never requests a fix (runDoctor's fix
 * path is not entered) and spends no model call - the model
 * check is doctor's own TCP connect, which sends no request
 * and never uses the key. `sam doctor --fix` stays the
 * operator's act, never a job's. The scorecard command exits
 * 0 even when checks fail (unlike `sam doctor run`, whose
 * exit contract stands): a script job's non-zero exit makes
 * the heartbeat runner discard its stdout as job-failed, so
 * a failing install - exactly when the trend matters - must
 * still deliver its text.
 */
export function doctorScorecardText(report: DoctorReport): string {
  const counts: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of report.checks) counts[item.status] += 1;
  const verdict = counts.fail > 0 ? "failing" : counts.warn > 0 ? "attention" : "healthy";
  const lines: string[] = [];
  lines.push("Doctor: " + verdict);
  lines.push(
    "Checks: " + String(report.checks.length) + " total, " +
    String(counts.ok) + " ok, " + String(counts.warn) + " warn, " +
    String(counts.fail) + " fail, " + String(counts.skip) + " skip",
  );
  for (const item of report.checks) lines.push(item.id + ": " + item.status);
  lines.push("Fixes: none applied - the scorecard never fixes; `sam doctor --fix` stays the operator's act");
  return lines.join("\n");
}

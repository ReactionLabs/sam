import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { engineBinary } from "./engine.js";
import { recordActivity } from "./activity.js";

// CLI dressing item 3 (Dip, 2026-11-10; OpenClaw borrow, research doc
// section 6 item 4): "Connect Claude Code" the CLI-reuse way. Before
// this, SAM only detected the binary's presence (three surfaces each
// read {installed, binary}): nothing ran `claude auth status`, so a
// signed-out install was indistinguishable from a signed-in one, and
// nothing recorded a connection.
//
// The shape, seam by seam, follows OpenClaw's Anthropic route:
// - CLI REUSE, ZERO CREDENTIAL HANDLING: Claude Code owns its login
//   and its token lifecycle on this machine. SAM stores only a
//   non-secret route marker and never reads, persists, refreshes,
//   selects, or forwards the CLI's tokens. Installing Claude Code
//   and signing it in (`claude auth login`) are the operator's acts.
// - FIXED ARGV: the probe is the binary SAM detected plus the verb
//   `auth status`, both built here in code. No caller can name a
//   command, a flag, or a shell.
// - HONEST CLASSIFICATION: the probe verdict is signed-in /
//   signed-out / not-installed / unknown. An output SAM cannot
//   recognize is unknown, never assumed signed-in - a connect is a
//   claim SAM makes to the owner, so it needs the explicit verdict.
//   Identity details the CLI may print (email, org) are parsed past
//   and never surfaced or stored; only the auth method name (a
//   short slug like claude.ai) may ride the marker.
// - VERIFY-BEFORE-SAVE (the config setup precedent): `connect`
//   records the marker (.sam/engine-connection.db) ONLY on
//   an explicit signed-in verdict; any other verdict saves nothing
//   and writes no ledger line. Disconnect removes ONLY SAM's
//   marker - it cannot and does not log Claude Code out.

export const ENGINE_AUTH_ARGV = ["auth", "status"] as const;
const AUTH_TIMEOUT_MS = 15_000;
const OUTPUT_CAP = 8_000;

export type EngineAuthState = "signed-in" | "signed-out" | "not-installed" | "unknown";

export interface EngineAuthProbe {
  state: EngineAuthState;
  binary: string | null;
  method: string | null;
  reason: string;
  exitCode: number | null;
}

export interface EngineConnection {
  route: "cli-reuse";
  binary: string;
  connectedAt: string;
  authState: "signed-in";
  authMethod: string | null;
}

export interface EngineConnectStatus {
  route: "cli-reuse";
  installed: boolean;
  binary: string | null;
  connected: boolean;
  stale: boolean;
  connection: EngineConnection | null;
}

export type EngineAuthRunner = (binary: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

export const defaultEngineAuthRunner: EngineAuthRunner = (binary, args, timeoutMs) => new Promise(done => {
  let settled = false;
  const child = execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 256_000, windowsHide: true }, (error, stdout, stderr) => {
    if (settled) return; settled = true;
    const timedOut = !!error && (error as unknown as { killed?: boolean }).killed === true && (error as unknown as { signal?: string }).signal === "SIGTERM";
    done({ exitCode: error ? (typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0, output: (stdout ?? "") + (stderr ?? ""), timedOut });
  });
  child.on("error", err => {
    if (settled) return; settled = true;
    done({ exitCode: null, output: String(err) });
  });
});

function cleanMethod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(v) ? v : null;
}

/** Classify one `claude auth status` reply. JSON first (the current
 *  CLI prints a JSON object carrying loggedIn + authMethod; identity
 *  fields in it are deliberately never read out), then the older
 *  text form. Anything else is unknown - fail closed. */
export function parseEngineAuth(output: string, exitCode: number | null): { state: EngineAuthState; method: string | null; reason: string } {
  const text = (output ?? "").slice(0, OUTPUT_CAP).trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.loggedIn === true) return { state: "signed-in", method: cleanMethod(parsed.authMethod), reason: "Claude Code reports a signed-in login (verified by `claude auth status`)." };
      if (parsed.loggedIn === false) return { state: "signed-out", method: cleanMethod(parsed.authMethod), reason: "Claude Code is installed but not signed in. The operator signs in on this machine with `claude auth login`; SAM never handles the login." };
    } catch { /* not the JSON shape; fall through to the text form */ }
  }
  const lower = text.toLowerCase();
  if (/not logged in|not signed in|logged out|no credentials|please (run|use).*login/.test(lower)) {
    return { state: "signed-out", method: null, reason: "Claude Code is installed but not signed in. The operator signs in on this machine with `claude auth login`; SAM never handles the login." };
  }
  if (/logged in|signed in/.test(lower)) {
    return { state: "signed-in", method: null, reason: "Claude Code reports a signed-in login (verified by `claude auth status`)." };
  }
  return { state: "unknown", method: null, reason: "The `claude auth status` reply was not recognized (exit " + (exitCode === null ? "unknown" : String(exitCode)) + "), so SAM will not claim a connection. Check the CLI on this machine directly." };
}

/** Run the auth probe: detection first (no binary, no run), then the
 *  one fixed-argv status call. A probe never writes anything. */
export async function probeEngineAuth(env: NodeJS.ProcessEnv = process.env, run: EngineAuthRunner = defaultEngineAuthRunner): Promise<EngineAuthProbe> {
  const binary = engineBinary(env);
  if (!binary) {
    return { state: "not-installed", binary: null, method: null, reason: "Claude Code is not installed on this machine - no SAM_ENGINE_BIN is set and no \"claude\" binary is on PATH. Installing it is the operator's act; SAM only detects it.", exitCode: null };
  }
  let result: { exitCode: number | null; output: string; timedOut?: boolean };
  try {
    result = await run(binary, [...ENGINE_AUTH_ARGV], AUTH_TIMEOUT_MS);
  } catch (err) {
    return { state: "unknown", binary, method: null, reason: "The auth probe could not run: " + (err instanceof Error ? err.message : String(err)), exitCode: null };
  }
  if (result.timedOut) {
    return { state: "unknown", binary, method: null, reason: "`claude auth status` timed out, so the login state is unknown; SAM will not claim a connection.", exitCode: null };
  }
  const parsed = parseEngineAuth(result.output ?? "", result.exitCode);
  return { state: parsed.state, binary, method: parsed.method, reason: parsed.reason, exitCode: result.exitCode };
}

// --- the route marker ---------------------------------------------------

function connectionPath(root: string) { return join(resolve(root), ".sam", "engine-connection.json"); }
function connectionDbPath(root: string) { return join(resolve(root), ".sam", "engine-connection.db"); }

// State convergence (UNIFICATION item 4, thirtieth store):
// the engine route marker is SQLite (.sam/engine-connection.db,
// the setup / auth-probes singleton pattern), ONE row holding
// the marker's full JSON so the singleton keeps its exact
// shape. The old engine-connection.json was written whole by
// connectEngine on every successful connect - a plain
// writeFileSync - and removed whole by disconnectEngine,
// while readEngineConnection readers run in every process
// that builds a status surface (detectSetup, auth status,
// the dashboard status path, the CLI overview and engine
// verbs). A torn write read back as no connection at all, so
// a verified signed-in install silently read as
// never-connected. Here a connect is a single-row UPSERT, a
// disconnect a single-row DELETE, and connections carry a
// busy_timeout, so no reader in any process can ever see a
// torn marker. First open imports a legacy
// engine-connection.json (validated through the old read
// shape: route cli-reuse, a non-empty string binary, a
// string connectedAt, authState signed-in, the auth method
// slug-sanitized exactly as the old reader did) and renames
// it engine-connection.json.migrated - imported, never
// deleted; a malformed file or a payload failing that shape
// imports nothing and is left in place (the migrated shape
// reads it as no connection, exactly the old forgiving
// contract). A pure read on an install with neither file
// creates nothing, and a non-signed-in verdict still saves
// nothing - verify-before-save is untouched. The marker
// stays non-secret by design: it never held the CLI's
// tokens, an email, or an org, and the migrated store holds
// exactly the same fields. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried
// with no backup change.
function parseEngineConnection(data: unknown): EngineConnection | null {
  const value = data as EngineConnection | null;
  if (value?.route !== "cli-reuse" || typeof value?.binary !== "string" || !value.binary) return null;
  if (typeof value?.connectedAt !== "string" || value?.authState !== "signed-in") return null;
  return { route: "cli-reuse", binary: value.binary, connectedAt: value.connectedAt, authState: "signed-in", authMethod: cleanMethod(value.authMethod) };
}
function openConnectionStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(connectionDbPath(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS engine_connection (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyConnection(db, root);
  return db;
}
function migrateLegacyConnection(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM engine_connection WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = connectionPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseEngineConnection(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO engine_connection (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function connectionStoreExists(root: string): boolean {
  return existsSync(connectionDbPath(root)) || existsSync(connectionPath(root));
}
function saveEngineConnection(root: string, record: EngineConnection): void {
  const db = openConnectionStore(root);
  try {
    db.prepare("INSERT INTO engine_connection (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(record));
  } finally { db.close(); }
}
function deleteEngineConnection(root: string): boolean {
  if (!connectionStoreExists(root)) return false;
  const db = openConnectionStore(root);
  try {
    const result = db.prepare("DELETE FROM engine_connection WHERE id = 1").run();
    return result.changes > 0;
  } finally { db.close(); }
}

// The store's read door: the recorded route marker through
// the store's own shape, or null when no connection has ever
// been recorded - and a read on an install with no store at
// all creates nothing.
export function readEngineConnection(root: string): EngineConnection | null {
  if (!connectionStoreExists(root)) return null;
  const db = openConnectionStore(root);
  try {
    const row = db.prepare("SELECT data FROM engine_connection WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseEngineConnection(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

/** The connection state every surface reads WITHOUT probing: the
 *  marker is the record, and it reads stale (not connected) when the
 *  binary it named is no longer the binary SAM detects - a different
 *  install is a different connection until it is re-verified. */
export function engineConnectStatus(root: string, env: NodeJS.ProcessEnv = process.env): EngineConnectStatus {
  const binary = engineBinary(env);
  const connection = readEngineConnection(root);
  const connected = !!connection && !!binary && connection.binary === binary;
  return { route: "cli-reuse", installed: binary !== null, binary, connected, stale: !!connection && !connected, connection };
}

/** Connect: probe, and only on an explicit signed-in verdict record
 *  the route marker + one ledger line. Any other verdict saves
 *  nothing - the failure is returned as data naming the operator
 *  act that fixes it. */
export async function connectEngine(root: string, env: NodeJS.ProcessEnv = process.env, run: EngineAuthRunner = defaultEngineAuthRunner): Promise<{ connected: boolean; probe: EngineAuthProbe; saved: EngineConnection | null }> {
  const probe = await probeEngineAuth(env, run);
  if (probe.state !== "signed-in" || !probe.binary) return { connected: false, probe, saved: null };
  const saved: EngineConnection = { route: "cli-reuse", binary: probe.binary, connectedAt: new Date().toISOString(), authState: "signed-in", authMethod: probe.method };
  saveEngineConnection(root, saved);
  recordActivity(root, "owner", "engine-connected", "Claude Code connected as the coding-engine route via CLI reuse (auth verified by `claude auth status`; SAM stored only a route marker in the engine connection store, no credentials)");
  return { connected: true, probe, saved };
}

/** Disconnect: remove ONLY SAM's route marker. Claude Code's own
 *  login on this machine is untouched - SAM has no door to it. */
export function disconnectEngine(root: string): { disconnected: boolean; note: string } {
  if (!deleteEngineConnection(root)) return { disconnected: false, note: "No engine connection is recorded on this install; nothing was removed." };
  recordActivity(root, "owner", "engine-disconnected", "Claude Code engine connection marker removed (CLI reuse route disconnected; the CLI's own login was not touched)");
  return { disconnected: true, note: "SAM's route marker is removed. Claude Code's own login on this machine is untouched - SAM never held it." };
}

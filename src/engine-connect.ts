import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { engineBinary } from "./engine.js";
import { commandCandidates, namedExecutable, probeDelimiter, probePlatform, type BinaryProbe } from "./bin-path.js";
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

// --- engine provider choice (Dip direction 2026-11-12 14:32 EST) -------
// The managed engine's provider is a CONFIG choice: Claude Code or
// Codex. Each provider is its own CLI on this machine, with its own
// login that the provider's CLI owns (CLI reuse for both - SAM never
// sees a password and never holds a token). The selection persists in
// the engine-connection store beside the route marker; the marker
// itself names its provider, so a connection recorded for one
// provider reads stale, never connected, after the owner switches.

export type EngineProvider = "claude-code" | "codex";

export interface EngineProviderDef {
  id: EngineProvider;
  label: string;
  command: string;
  envVar: string;
  authArgv: readonly string[];
  loginArgv: readonly string[];
  loginHint: string;
}

export const ENGINE_PROVIDERS: readonly EngineProviderDef[] = [
  { id: "claude-code", label: "Claude Code", command: "claude", envVar: "SAM_ENGINE_BIN", authArgv: ENGINE_AUTH_ARGV, loginArgv: ["auth", "login"], loginHint: "`claude auth login`" },
  { id: "codex", label: "Codex", command: "codex", envVar: "SAM_CODEX_BIN", authArgv: ["login", "status"], loginArgv: ["login"], loginHint: "`codex login`" },
];

export function engineProviderDef(provider: EngineProvider): EngineProviderDef {
  return ENGINE_PROVIDERS.find(p => p.id === provider) ?? ENGINE_PROVIDERS[0];
}

export function isEngineProvider(value: unknown): value is EngineProvider {
  return value === "claude-code" || value === "codex";
}

/** The binary for one provider: Claude Code rides the existing
 *  engineBinary (SAM_ENGINE_BIN, else claude on PATH); Codex resolves
 *  SAM_CODEX_BIN, else `codex` on PATH through the bin-path helpers
 *  (path.delimiter split, win32 .exe/.cmd names). Null = not
 *  installed, named cleanly everywhere. */
export function providerBinary(provider: EngineProvider, env: NodeJS.ProcessEnv = process.env, probe?: BinaryProbe): string | null {
  if (provider === "claude-code") return engineBinary(env);
  const platform = probePlatform(probe);
  const delimiter = probeDelimiter(probe);
  const rawNamed = env.SAM_CODEX_BIN;
  const named = rawNamed ? namedExecutable(rawNamed, platform) : rawNamed;
  if (named) {
    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }
  }
  for (const candidate of commandCandidates(env.PATH, delimiter, "codex", platform)) {
    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export type EngineAuthState = "signed-in" | "signed-out" | "not-installed" | "unknown";

export interface EngineAuthProbe {
  provider: EngineProvider;
  state: EngineAuthState;
  binary: string | null;
  method: string | null;
  reason: string;
  exitCode: number | null;
}

export interface EngineConnection {
  route: "cli-reuse";
  provider: EngineProvider;
  binary: string;
  connectedAt: string;
  authState: "signed-in";
  authMethod: string | null;
}

export interface EngineProviderStatus {
  provider: EngineProvider;
  label: string;
  installed: boolean;
  binary: string | null;
  connected: boolean;
}

export interface EngineConnectStatus {
  route: "cli-reuse";
  provider: EngineProvider;
  installed: boolean;
  binary: string | null;
  connected: boolean;
  stale: boolean;
  connection: EngineConnection | null;
  providers: EngineProviderStatus[];
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

/** Classify one `codex login status` reply. The Codex CLI prints a
 *  short text verdict ("Logged in using ChatGPT" / "Not logged in");
 *  a JSON shape with a loggedIn flag is accepted the same way as the
 *  Claude probe. Anything else is unknown - fail closed. Identity
 *  details (an email the CLI may print) are parsed past, never read
 *  out; only the auth method slug may surface. */
export function parseCodexAuth(output: string, exitCode: number | null): { state: EngineAuthState; method: string | null; reason: string } {
  const text = (output ?? "").slice(0, OUTPUT_CAP).trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.loggedIn === true) return { state: "signed-in", method: cleanMethod(parsed.authMethod) ?? "chatgpt", reason: "Codex reports a signed-in login (verified by `codex login status`)." };
      if (parsed.loggedIn === false) return { state: "signed-out", method: null, reason: "Codex is installed but not signed in. The operator signs in on this machine with `codex login` (or `sam engine login`); SAM never handles the login." };
    } catch { /* not the JSON shape; fall through to the text form */ }
  }
  const lower = text.toLowerCase();
  if (/not logged in|not signed in|logged out|no credentials|please (run|use).*login/.test(lower)) {
    return { state: "signed-out", method: null, reason: "Codex is installed but not signed in. The operator signs in on this machine with `codex login` (or `sam engine login`); SAM never handles the login." };
  }
  if (/logged in|signed in/.test(lower)) {
    return { state: "signed-in", method: /chatgpt/.test(lower) ? "chatgpt" : /api key/.test(lower) ? "api-key" : null, reason: "Codex reports a signed-in login (verified by `codex login status`)." };
  }
  return { state: "unknown", method: null, reason: "The `codex login status` reply was not recognized (exit " + (exitCode === null ? "unknown" : String(exitCode)) + "), so SAM will not claim a connection. Check the CLI on this machine directly." };
}

/** Run the auth probe for ONE provider: detection first (no binary,
 *  no run), then that provider's one fixed-argv status call. A probe
 *  never writes anything. */
export async function probeEngineAuthFor(provider: EngineProvider, env: NodeJS.ProcessEnv = process.env, run: EngineAuthRunner = defaultEngineAuthRunner): Promise<EngineAuthProbe> {
  const def = engineProviderDef(provider);
  const binary = providerBinary(provider, env);
  if (!binary) {
    return { provider, state: "not-installed", binary: null, method: null, reason: def.label + " is not installed on this machine - no " + def.envVar + " is set and no \"" + def.command + "\" binary is on PATH. Installing it is the operator's act; SAM only detects it.", exitCode: null };
  }
  let result: { exitCode: number | null; output: string; timedOut?: boolean };
  try {
    result = await run(binary, [...def.authArgv], AUTH_TIMEOUT_MS);
  } catch (err) {
    return { provider, state: "unknown", binary, method: null, reason: "The auth probe could not run: " + (err instanceof Error ? err.message : String(err)), exitCode: null };
  }
  if (result.timedOut) {
    return { provider, state: "unknown", binary, method: null, reason: "`" + def.command + " " + def.authArgv.join(" ") + "` timed out, so the login state is unknown; SAM will not claim a connection.", exitCode: null };
  }
  const parsed = provider === "codex" ? parseCodexAuth(result.output ?? "", result.exitCode) : parseEngineAuth(result.output ?? "", result.exitCode);
  return { provider, state: parsed.state, binary, method: parsed.method, reason: parsed.reason, exitCode: result.exitCode };
}

/** The Claude Code probe, kept as the named door existing callers use. */
export async function probeEngineAuth(env: NodeJS.ProcessEnv = process.env, run: EngineAuthRunner = defaultEngineAuthRunner): Promise<EngineAuthProbe> {
  return probeEngineAuthFor("claude-code", env, run);
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
  // A marker written before the provider choice existed is a Claude
  // Code marker - that was the only provider there was.
  return { route: "cli-reuse", provider: isEngineProvider(value?.provider) ? value.provider : "claude-code", binary: value.binary, connectedAt: value.connectedAt, authState: "signed-in", authMethod: cleanMethod(value.authMethod) };
}
function openConnectionStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(connectionDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS engine_connection (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS engine_provider (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
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

// --- the provider choice --------------------------------------------------

export interface EngineProviderRecord { provider: EngineProvider; updatedAt: string }

/** The recorded provider choice through the store's own shape, or
 *  null when none was ever set (the selection then defaults to
 *  claude-code). A pure read on an install with no store creates
 *  nothing. */
export function readEngineProviderRecord(root: string): EngineProviderRecord | null {
  if (!connectionStoreExists(root)) return null;
  const db = openConnectionStore(root);
  try {
    const row = db.prepare("SELECT data FROM engine_provider WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.data) as EngineProviderRecord;
      return isEngineProvider(value?.provider) && typeof value?.updatedAt === "string" ? { provider: value.provider, updatedAt: value.updatedAt } : null;
    } catch { return null; }
  } finally { db.close(); }
}

/** The provider this install's engine route is set to. */
export function engineProvider(root: string): EngineProvider {
  return readEngineProviderRecord(root)?.provider ?? "claude-code";
}

/** Set the provider choice (an operator config act, ledgered). This
 *  records the CHOICE only - no connection is made or removed by it;
 *  a marker recorded for the other provider simply reads stale until
 *  the new provider is connected. */
export function setEngineProvider(root: string, provider: EngineProvider): EngineProviderRecord {
  if (!isEngineProvider(provider)) throw new Error("Invalid engine provider: " + String(provider) + " (valid: " + ENGINE_PROVIDERS.map(p => p.id).join(", ") + ")");
  const record: EngineProviderRecord = { provider, updatedAt: new Date().toISOString() };
  const db = openConnectionStore(root);
  try {
    db.prepare("INSERT INTO engine_provider (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(record));
  } finally { db.close(); }
  recordActivity(root, "owner", "engine-provider", engineProviderDef(provider).label + " selected as the coding-engine provider (config choice; no connection was recorded or removed by this act)");
  return record;
}

/** The connection state every surface reads WITHOUT probing: the
 *  marker is the record, and it reads stale (not connected) when it
 *  names a different provider than the selected one, or a binary
 *  that is no longer the one SAM detects for that provider - a
 *  different install is a different connection until re-verified. */
export function engineConnectStatus(root: string, env: NodeJS.ProcessEnv = process.env): EngineConnectStatus {
  const provider = engineProvider(root);
  const connection = readEngineConnection(root);
  const providers: EngineProviderStatus[] = ENGINE_PROVIDERS.map(def => {
    const binary = providerBinary(def.id, env);
    return { provider: def.id, label: def.label, installed: binary !== null, binary, connected: !!connection && connection.provider === def.id && !!binary && connection.binary === binary };
  });
  const selected = providers.find(p => p.provider === provider) ?? providers[0];
  const connected = selected.connected;
  return { route: "cli-reuse", provider, installed: selected.installed, binary: selected.binary, connected, stale: !!connection && !connected, connection, providers };
}

/** Connect the SELECTED provider (or an explicitly named one):
 *  probe, and only on an explicit signed-in verdict record the
 *  route marker + one ledger line. Any other verdict saves
 *  nothing - the failure is returned as data naming the operator
 *  act that fixes it. */
export async function connectEngine(root: string, env: NodeJS.ProcessEnv = process.env, run: EngineAuthRunner = defaultEngineAuthRunner, provider?: EngineProvider): Promise<{ connected: boolean; probe: EngineAuthProbe; saved: EngineConnection | null }> {
  const selected = provider ?? engineProvider(root);
  const probe = await probeEngineAuthFor(selected, env, run);
  if (probe.state !== "signed-in" || !probe.binary) return { connected: false, probe, saved: null };
  const def = engineProviderDef(selected);
  const saved: EngineConnection = { route: "cli-reuse", provider: selected, binary: probe.binary, connectedAt: new Date().toISOString(), authState: "signed-in", authMethod: probe.method };
  saveEngineConnection(root, saved);
  recordActivity(root, "owner", "engine-connected", def.label + " connected as the coding-engine route via CLI reuse (auth verified by `" + def.command + " " + def.authArgv.join(" ") + "`; SAM stored only a route marker in the engine connection store, no credentials)");
  return { connected: true, probe, saved };
}

/** Disconnect: remove ONLY SAM's route marker. The provider CLI's
 *  own login on this machine is untouched - SAM has no door to it. */
export function disconnectEngine(root: string): { disconnected: boolean; note: string } {
  const existing = readEngineConnection(root);
  if (!deleteEngineConnection(root)) return { disconnected: false, note: "No engine connection is recorded on this install; nothing was removed." };
  const label = existing ? engineProviderDef(existing.provider).label : "Engine";
  recordActivity(root, "owner", "engine-disconnected", label + " engine connection marker removed (CLI reuse route disconnected; the CLI's own login was not touched)");
  return { disconnected: true, note: "SAM's route marker is removed. The provider CLI's own login on this machine is untouched - SAM never held it." };
}

// --- the login action -----------------------------------------------------

export interface EngineLoginPlan {
  provider: EngineProvider;
  label: string;
  binary: string | null;
  argv: string[];
  command: string | null;
  note: string;
}

/** What `sam engine login` would run for a provider: the provider's
 *  OWN login argv on its detected binary, built here in code. Null
 *  binary means not installed - there is nothing to log in with. */
export function engineLoginPlan(provider: EngineProvider, env: NodeJS.ProcessEnv = process.env): EngineLoginPlan {
  const def = engineProviderDef(provider);
  const binary = providerBinary(provider, env);
  if (!binary) return { provider, label: def.label, binary: null, argv: [...def.loginArgv], command: null, note: def.label + " is not installed on this machine, so there is no login to run. Installing it is the operator's act; then `sam engine login` runs " + def.loginHint + " here." };
  return { provider, label: def.label, binary, argv: [...def.loginArgv], command: binary + " " + def.loginArgv.join(" "), note: "Runs the provider's own login in this terminal (" + def.loginHint + "). The owner types any password or completes any browser step there - SAM never sees it and holds no credential." };
}

export type EngineLoginRunner = (binary: string, args: string[]) => Promise<{ exitCode: number | null }>;

/** The real login runner: the provider CLI inherits this terminal,
 *  so its prompts and browser hand-off happen with the owner, in the
 *  owner's own session - SAM is not in the credential path at all. */
export const defaultEngineLoginRunner: EngineLoginRunner = (binary, args) => new Promise(done => {
  const child = spawn(binary, [...args], { stdio: "inherit", windowsHide: false });
  child.on("error", () => done({ exitCode: null }));
  child.on("close", code => done({ exitCode: typeof code === "number" ? code : null }));
});

/** Log in, then connect: run the selected provider's own login in
 *  the owner's terminal; on a clean exit, probe and - only on a
 *  signed-in verdict - record the route marker (connectEngine's
 *  verify-before-save). A failed or refused login saves nothing. */
export async function runEngineLogin(root: string, env: NodeJS.ProcessEnv = process.env, opts: { provider?: EngineProvider; loginRunner?: EngineLoginRunner; authRunner?: EngineAuthRunner } = {}): Promise<{ provider: EngineProvider; plan: EngineLoginPlan; loginExitCode: number | null; connected: boolean; probe: EngineAuthProbe | null; saved: EngineConnection | null; note: string }> {
  const provider = opts.provider ?? engineProvider(root);
  const plan = engineLoginPlan(provider, env);
  if (!plan.binary) return { provider, plan, loginExitCode: null, connected: false, probe: null, saved: null, note: plan.note };
  const loginRunner = opts.loginRunner ?? defaultEngineLoginRunner;
  let loginExitCode: number | null;
  try { loginExitCode = (await loginRunner(plan.binary, plan.argv)).exitCode; }
  catch { loginExitCode = null; }
  if (loginExitCode !== 0) return { provider, plan, loginExitCode, connected: false, probe: null, saved: null, note: "The provider login did not complete (exit " + (loginExitCode === null ? "unknown" : String(loginExitCode)) + "), so nothing was connected or saved. The login is the owner's act in this terminal; re-run `sam engine login` when it can be completed." };
  const result = opts.authRunner ? await connectEngine(root, env, opts.authRunner, provider) : await connectEngine(root, env, undefined, provider);
  return { provider, plan, loginExitCode, connected: result.connected, probe: result.probe, saved: result.saved, note: result.connected ? plan.label + " logged in and connected as the coding-engine route (route marker only; SAM holds no credential)." : "The login finished but the auth probe did not verify a signed-in state, so no connection was recorded: " + result.probe.reason };
}

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { modelRoutingTable, type ModelSource, type ModelTier } from "./model-routing.js";
import { parseSamConfig } from "./config.js";
import { modelEndpoint, modelApiKey, readSetupRecord, defaultCompleter, type Completer } from "./config-wizard.js";
import { engineConnectStatus, type EngineConnection } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { readActivity, recordActivity } from "./activity.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { listProviders, modelKeyEnvName, readProviderKey, resolveTurnConnection, type ConfiguredProvider } from "./providers.js";
import { codexAuthState, type CodexAuthState } from "./codex-auth.js";
import { errorReason } from "./telegram.js";

export { modelKeyEnvName };

// CLI dressing item 2 (Dip, 2026-11-10; OpenClaw borrow, research doc
// section 6 item 3): an auth status / probe surface over the routes
// SAM already detects. Before this, `sam models` was a bare routing
// table: it could not say whether the key behind a route is present,
// which model a profile actually resolves to, or whether any route
// still works - and `config verify --live` probed only the chat
// route's model, once, at setup time.
//
// SAM holds no secrets, only env-var NAMES, so this surface reports
// each route's key as a name plus present/absent and never a value.
// The engine route is Claude Code CLI REUSE (the OpenClaw shape):
// the binary is detected, its tokens are never read or touched.
// Probing is explicit: `models status --probe --live` runs ONE real
// completion per DISTINCT resolved model through the existing
// provider, buckets the result, and persists it
// (.sam/auth-probes.db) so plain status reads the last verdict
// back without spending another call.

export type ProbeBucket = "ok" | "auth" | "rate_limit" | "billing" | "timeout" | "network" | "empty" | "missing" | "error";

export interface ProbeRecord {
  target: string;
  kind: "route" | "profile" | "provider";
  model: string | null;
  bucket: ProbeBucket;
  reason: string;
  at: string;
  latencyMs: number | null;
}

export interface ProviderHealth extends ConfiguredProvider {
  lastProbe: ProbeRecord | null;
}

export interface AuthTarget {
  target: string;
  kind: "route" | "profile";
  route: string | null;
  profile: string | null;
  tier: ModelTier;
  source: ModelSource;
  model: string | null;
  keyEnv: string;
  key: "present" | "absent";
  endpoint: string | null;
  lastProbe: ProbeRecord | null;
}

export interface AuthStatus {
  provider: string;
  endpoint: string | null;
  keyEnv: string;
  key: "present" | "absent";
  setupVerified: { model: string; verifiedAt: string; current: boolean } | null;
  routes: AuthTarget[];
  profiles: AuthTarget[];
  providers: ProviderHealth[];
  engine: { route: "cli-reuse"; provider: string; installed: boolean; binary: string | null; connected: boolean; stale: boolean; connection: EngineConnection | null; providers: Array<{ provider: string; label: string; installed: boolean; binary: string | null; connected: boolean }> };
  senses: { installed: boolean; binary: string | null };
  lastProbeAt: string | null;
  healthy: boolean;
  codex: CodexAuthState;
}

function targets(root: string, env: NodeJS.ProcessEnv): { routes: Array<Omit<AuthTarget, "lastProbe">>; profiles: Array<Omit<AuthTarget, "lastProbe">> } {
  const keyEnv = modelKeyEnvName(env);
  const key: "present" | "absent" = modelApiKey(env) ? "present" : "absent";
  const endpoint = modelEndpoint(env);
  const base = { keyEnv, key, endpoint };
  const routes = modelRoutingTable(env).map(r => ({
    target: "route:" + r.route, kind: "route" as const, route: r.route, profile: null,
    tier: r.tier, source: r.source, model: r.model, ...base,
  }));
  const profiles: Array<Omit<AuthTarget, "lastProbe">> = [];
  const pushProfile = (name: string, profile: { provider?: string | null; model?: string | null } | null) => {
    const conn = resolveTurnConnection(root, env, profile, "chat");
    profiles.push({
      target: "profile:" + name, kind: "profile", route: null, profile: name,
      tier: conn.tier, source: conn.source, model: conn.model,
      keyEnv: conn.keyEnv || base.keyEnv, key: conn.key, endpoint: conn.endpoint,
    });
  };
  pushProfile("sam", null);
  try {
    const db = new ChatStore(root);
    try {
      for (const a of db.agents()) pushProfile(a.name, { provider: a.provider ?? null, model: a.model ?? null });
    } finally { db.close(); }
  } catch { /* a workspace whose chat store cannot open yet reads as core-only */ }
  return { routes, profiles };
}

// --- probe result store -------------------------------------------------

interface ProbeStore { at: string; results: ProbeRecord[] }

function probePath(root: string) { return join(resolve(root), ".sam", "auth-probes.json"); }
function probeDbPath(root: string) { return join(resolve(root), ".sam", "auth-probes.db"); }

// State convergence (UNIFICATION item 4, twenty-eighth store):
// the auth probe verdicts are SQLite (.sam/auth-probes.db, the
// approval-policy singleton pattern), ONE row holding the probe
// store's full JSON so the singleton keeps its exact shape. The
// old auth-probes.json was rewritten whole by probeAuth on every
// probe run - a non-atomic writeFileSync - while readProbeStore
// readers run in every process that builds auth status (the
// dashboard status path, the CLI overview and `models status`,
// observability). A torn write read back as no probe store at
// all, so the last verdicts silently vanished: a chat route
// whose latest probe failed read as never-probed, and
// authCheckOk passed it again. Here each probe run is a
// single-row UPSERT and connections carry a busy_timeout, so
// no reader in any process can ever see a torn verdict set.
// First open imports a legacy auth-probes.json (validated
// through the old read shape: a string at plus a results array)
// and renames it auth-probes.json.migrated - imported, never
// deleted; a malformed file or a payload failing that shape
// imports nothing and is left in place (the migrated shape
// reads it as no probe store, exactly the old forgiving
// contract). A pure read on an install with neither file
// creates nothing. The P9 backup snapshots every .sam/*.db
// generically, so the migrated store is carried with no backup
// change.
function parseProbeStore(data: unknown): ProbeStore | null {
  const value = data as ProbeStore | null;
  return typeof value?.at === "string" && Array.isArray(value?.results) ? { at: value.at, results: value.results } : null;
}
function openProbeStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(probeDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS auth_probes (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyProbes(db, root);
  return db;
}
function migrateLegacyProbes(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM auth_probes WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = probePath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const store = parseProbeStore(data);
  if (!store) return;
  db.prepare("INSERT OR IGNORE INTO auth_probes (id, data) VALUES (1, ?)").run(JSON.stringify(store));
  renameSync(file, file + ".migrated");
}
function probeStoreExists(root: string): boolean {
  return existsSync(probeDbPath(root)) || existsSync(probePath(root));
}

// Failure visibility (gap found 2026-11-15, hourly run
// 16:04 EST): this store is the last probe run's verdicts -
// the record auth status, the --check contract, the
// dashboard status payload, and the CLI overview read back
// to decide whether a route still works - and every touch
// was unguarded. Now the store owns its touches (the
// setup-store precedent, helpers here because this module
// already imports the ledger and is its own leaf for this
// seam): a failed open/read/write ledgers ONE
// auth-probes-store-failed line (phase read for the read
// door, phase write for the write door; actor sam; the
// verbatim reason collapsed and capped; never any probe
// record content - the recorded models, buckets, and
// reasons are the install's data) and rethrows exactly,
// tagged so a catching caller records nothing more for the
// same touch. The exists check stays outside the seam: an
// absent store still reads as no probes with no line and
// creates nothing, and a torn row payload still parses
// forgiving to null - only the store touch is guarded.
export type AuthProbesStorePhase = "read" | "write";

export function authProbesStoreFailureSummary(phase: AuthProbesStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Auth probes store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a auth-probes-store-failed line carries (census sprint
 * 2026-11-17): recordAuthProbesStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function authProbesStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordAuthProbesStoreFailure(root: string, phase: AuthProbesStorePhase, error: unknown): void {
  const reason = authProbesStoreFailureReason(error);
  recordActivity(root, "sam", "auth-probes-store-failed", authProbesStoreFailureSummary(phase, reason));
}

function tagAuthProbesStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { authProbesStoreLedgered?: boolean }).authProbesStoreLedgered = true;
  }
}

export function isAuthProbesStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { authProbesStoreLedgered?: boolean }).authProbesStoreLedgered === true;
}

function failAuthProbesStore(root: string, phase: AuthProbesStorePhase, error: unknown): never {
  if (!isAuthProbesStoreLedgered(error)) recordAuthProbesStoreFailure(root, phase, error);
  tagAuthProbesStoreLedgered(error);
  throw error;
}

function saveProbeStore(root: string, store: ProbeStore): void {
  let db: Database.Database;
  try { db = openProbeStore(root); } catch (error) { failAuthProbesStore(root, "write", error); }
  try {
    db!.prepare("INSERT INTO auth_probes (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(store));
  } catch (error) { failAuthProbesStore(root, "write", error); }
  finally { db!.close(); }
}

// The store's read door: the last probe run's verdicts through
// the store's own shape, or null when no probe has ever been
// persisted - and a read on an install with no store at all
// creates nothing.
export function readProbeStore(root: string): ProbeStore | null {
  if (!probeStoreExists(root)) return null;
  let db: Database.Database;
  try { db = openProbeStore(root); } catch (error) { failAuthProbesStore(root, "read", error); }
  try {
    const row = db!.prepare("SELECT data FROM auth_probes WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseProbeStore(JSON.parse(row.data)); } catch { return null; }
  } catch (error) { failAuthProbesStore(root, "read", error); }
  finally { db!.close(); }
}

export function authStatus(root: string, env: NodeJS.ProcessEnv = process.env): AuthStatus {
  const { routes, profiles } = targets(root, env);
  const store = readProbeStore(root);
  const byTarget = new Map((store?.results ?? []).map(r => [r.target, r]));
  const withProbe = (t: Omit<AuthTarget, "lastProbe">): AuthTarget => ({ ...t, lastProbe: byTarget.get(t.target) ?? null });
  const routeRows = routes.map(withProbe);
  const profileRows = profiles.map(withProbe);
  const setup = readSetupRecord(root);
  const chat = routeRows.find(r => r.route === "chat");
  return {
    provider: parseSamConfig(env).modelProvider,
    endpoint: modelEndpoint(env),
    keyEnv: modelKeyEnvName(env),
    key: modelApiKey(env) ? "present" : "absent",
    setupVerified: setup ? { model: setup.model, verifiedAt: setup.verifiedAt, current: !!chat && setup.model === chat.model } : null,
    routes: routeRows,
    profiles: profileRows,
    providers: listProviders(root, env).map(p => ({ ...p, lastProbe: byTarget.get("provider:" + p.id) ?? null })),
    engine: (() => { const c = engineConnectStatus(root, env); return { route: "cli-reuse" as const, provider: c.provider, installed: c.installed, binary: c.binary, connected: c.connected, stale: c.stale, connection: c.connection, providers: c.providers }; })(),
    senses: sensesStatus(env),
    lastProbeAt: store?.at ?? null,
    healthy: authCheckOk({ routes: routeRows }),
    codex: codexAuthState(root),
  };
}

// The --check contract: the chat route (the turn an owner actually
// runs) must resolve a model with its key present, and IF it has
// been probed, the latest probe must be ok. Other targets inform;
// they do not fail the check - a stale pin on an unused profile is
// a status line, not an outage.
export function authCheckOk(status: { routes: AuthTarget[] }): boolean {
  const chat = status.routes.find(r => r.route === "chat");
  if (!chat || !chat.model || chat.key !== "present") return false;
  if (chat.lastProbe && chat.lastProbe.bucket !== "ok") return false;
  return true;
}

// The auth status as a plain-text scorecard - the trending
// surface a daily script job (sam-auth-status) P3-diffs, so a
// held install stays silent and drift is the news (a key env
// vanishing, a pin resolving to a different model, the engine
// route going stale, a probe verdict landing). The status
// record carries clock readings (the setup baseline's
// verifiedAt, each probe's stamp and latency, the codex
// expiry) and free-text probe reasons; NONE of them enter the
// text - a probe contributes its bucket only, so two reads at
// the same detected state are byte-identical. The scorecard
// is a pure read: it creates nothing and spends no model
// call, and probing stays the operator's --live act exactly
// as item 2 left it.
export function authStatusText(status: AuthStatus): string {
  const lines: string[] = [];
  lines.push("Auth status: " + (status.healthy ? "healthy" : "NOT healthy"));
  lines.push("Provider: " + status.provider + " via " + (status.endpoint ?? "no endpoint") + ", key " + status.keyEnv + " " + status.key);
  lines.push(status.setupVerified
    ? "Setup baseline: " + status.setupVerified.model + (status.setupVerified.current ? " (still the chat route's model)" : " (no longer the chat route's model)")
    : "Setup baseline: none recorded");
  const row = (t: AuthTarget): string =>
    t.target + ": " + (t.model ?? "no model") + " (" + t.source + ", tier " + t.tier + "), key " + t.keyEnv + " " + t.key + ", probe " + (t.lastProbe ? t.lastProbe.bucket : "never");
  for (const t of status.routes) lines.push(row(t));
  for (const t of status.profiles) lines.push(row(t));
  for (const p of status.providers) lines.push("provider:" + p.id + ": " + (p.model ?? "no model") + " via " + (p.endpoint ?? "no endpoint") + ", key " + p.keyEnv + " " + p.key + ", probe " + (p.lastProbe ? p.lastProbe.bucket : "never"));
  const probed = [...status.routes, ...status.profiles].filter(t => t.lastProbe).length + status.providers.filter(p => p.lastProbe).length;
  const total = status.routes.length + status.profiles.length + status.providers.length;
  lines.push(probed === 0
    ? "Probes: none recorded - probing spends one real completion per distinct model and stays the operator's --live act"
    : "Probes: recorded for " + String(probed) + " of " + String(total) + " targets");
  const e = status.engine;
  lines.push("Engine: " + e.provider + " cli-reuse, " + (!e.installed ? "not installed" : e.stale ? "installed, connection stale" : e.connected ? "installed and connected" : "installed, not connected"));
  lines.push("Senses: " + (status.senses.installed ? "installed (" + (status.senses.binary ?? "unknown binary") + ")" : "not installed"));
  lines.push("Codex: " + (status.codex.loggedIn ? "logged in" : status.codex.pending ? "login pending" : "not logged in"));
  return lines.join("\n");
}

// Bucket a probe failure the way OpenClaw's models status --probe
// does: the owner (and a script) needs the KIND of failure, not a
// raw stack. Order matters: a 429 that mentions quota is a rate
// limit; a 402 / insufficient-balance is billing.
//
// The text both the bucket tests and the persisted reason read is
// composed through errorReason (the 2026-11-16 04:04 bridge seam):
// Node's fetch wraps every transport failure in the same TypeError
// "fetch failed" with the real reason on error.cause, so taking
// err.message alone bucketed a dead endpoint correctly as network
// but persisted a verdict naming nothing (DNS vs connect vs socket
// vs TLS indistinguishable), and a signal riding only on the cause
// could never move the bucket. errorReason walks the cause chain
// (bounded, deduped), appends errno codes, redacts bot-token
// segments, and collapses whitespace; causeless errors compose to
// exactly their message, so they classify and read as before.
export function classifyProbeError(err: unknown): { bucket: ProbeBucket; reason: string } {
  const message = errorReason(err);
  const name = err instanceof Error ? err.name : "";
  const reason = message.slice(0, 200);
  if (name === "AbortError" || /timed out|timeout/i.test(message)) return { bucket: "timeout", reason };
  if (/HTTP 401|HTTP 403|unauthori[sz]ed|invalid api key|authentication/i.test(message)) return { bucket: "auth", reason };
  if (/HTTP 429|rate.?limit|too many requests/i.test(message)) return { bucket: "rate_limit", reason };
  if (/HTTP 402|insufficient|billing|payment required/i.test(message)) return { bucket: "billing", reason };
  if (err instanceof TypeError || /network|fetch failed|ECONN|ENOTFOUND|socket/i.test(message)) return { bucket: "network", reason };
  return { bucket: "error", reason };
}

export interface ProbeRun { at: string; results: ProbeRecord[]; ok: boolean; calls: number }

// Probe every route + profile target, spending at most one real
// completion per distinct resolved model (routes and pins that
// resolve to the same model share one call and one verdict).
function providerCompleter(endpoint: string, apiKey: string): Completer {
  const provider = new OpenAICompatibleProvider(endpoint, apiKey, 30_000);
  return async (model: string) => {
    const res = await provider.complete({ model, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    return res.message.content;
  };
}

export async function probeAuth(root: string, env: NodeJS.ProcessEnv = process.env, complete?: Completer): Promise<ProbeRun> {
  const { routes, profiles } = targets(root, env);
  // One probe target per configured provider, in addition to the
  // route and profile rows. A provider whose model was already probed
  // on the same endpoint and key shares that call.
  const providerTargets = listProviders(root, env).map(p => ({
    target: "provider:" + p.id, kind: "provider" as const, model: p.model, endpoint: p.endpoint, key: p.key, keyEnv: p.keyEnv,
  }));
  const all = [...routes, ...profiles, ...providerTargets];
  const at = new Date().toISOString();
  const envEndpoint = modelEndpoint(env);
  const envKeyEnv = modelKeyEnvName(env);
  const verdicts = new Map<string, { bucket: ProbeBucket; reason: string; latencyMs: number | null }>();
  let calls = 0;
  for (const t of all) {
    if (!t.model) continue;
    const cacheKey = (t.endpoint ?? "") + "\n" + t.model + "\n" + t.keyEnv;
    if (verdicts.has(cacheKey)) continue;
    if (!t.endpoint) { verdicts.set(cacheKey, { bucket: "missing", reason: "No model endpoint resolved: set SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT.", latencyMs: null }); continue; }
    if (t.key !== "present") { verdicts.set(cacheKey, { bucket: "auth", reason: "No model API key in the environment (" + t.keyEnv + ").", latencyMs: null }); continue; }
    const run = complete ?? (t.endpoint === envEndpoint && t.keyEnv === envKeyEnv ? defaultCompleter(env) : providerCompleter(t.endpoint, readProviderKey(env, t.keyEnv) ?? ""));
    if (!run) { verdicts.set(cacheKey, { bucket: "error", reason: "Model connection could not be constructed from the environment.", latencyMs: null }); continue; }
    calls++;
    const started = Date.now();
    try {
      const reply = (await run(t.model)).trim();
      verdicts.set(cacheKey, reply
        ? { bucket: "ok", reason: "Verified with one real completion.", latencyMs: Date.now() - started }
        : { bucket: "empty", reason: "The model answered with an empty completion.", latencyMs: Date.now() - started });
    } catch (err) {
      const { bucket, reason } = classifyProbeError(err);
      verdicts.set(cacheKey, { bucket, reason, latencyMs: Date.now() - started });
    }
  }
  const results: ProbeRecord[] = all.map(t => {
    if (!t.model) return { target: t.target, kind: t.kind, model: null, bucket: "missing" as const, reason: "No model resolved for this target: set SAM_MODEL or a profile pin.", at, latencyMs: null };
    const v = verdicts.get((t.endpoint ?? "") + "\n" + t.model + "\n" + t.keyEnv)!;
    return { target: t.target, kind: t.kind, model: t.model, bucket: v.bucket, reason: v.reason, at, latencyMs: v.latencyMs };
  });
  saveProbeStore(root, { at, results });
  const bad = results.filter(r => r.bucket !== "ok");
  recordActivity(root, "owner", "auth-probe", authProbeLedgerSummary(results.length - bad.length, results.length, calls, bad));
  return { at, results, ok: bad.length === 0, calls };
}

// The ONE writer for the auth probe's activity line, so the
// history scorecard's parser below can never drift from the
// seam it counts. The shape is byte-identical to what
// probeAuth wrote inline before this writer existed.
export function authProbeLedgerSummary(ok: number, total: number, calls: number, bad: ReadonlyArray<{ target: string; bucket: string }>): string {
  return "Auth probe: " + String(ok) + "/" + String(total) + " targets ok (" + String(calls) + " model call(s))" + (bad.length ? "; not ok: " + bad.map(r => r.target + "=" + r.bucket).join(", ") : "");
}

// The auth probe history scorecard (2026-11-21, the
// measured-proof series): every completed auth probe has
// ledgered as an auth-probe line since the probe landed -
// until now as inline concatenation at the seam, with no ONE
// writer and no fold, so how many probe runs ever completed,
// how their ok/total targets and model calls sum, and which
// failure buckets have ever appeared was invisible as a
// trend (the probe store is a singleton holding only the
// LAST run's verdicts, overwritten on every probe, and the
// auth status scorecard reads that current state, never the
// history). A not-ok target is a route or pin that would die
// in a turn, so the verdict is attention only when any
// not-ok target was ever recorded or a line is unparseable,
// else clear. This text folds the class to counts only, on
// ONE line: runs, summed ok and total targets, summed model
// calls, the latest run's ok/total, counts per fixed bucket,
// and the total. No stamp, no actor, no target name, no
// reason, and no verbatim summary enters the text. A pure
// read: it creates nothing, probes nothing, and spends no
// model call - the probe seam itself is untouched beyond
// riding its ONE writer.
export const AUTH_PROBE_BUCKETS = ["auth", "rate_limit", "billing", "timeout", "network", "empty", "missing", "error"] as const;

export type AuthProbeSummary = { ok: number; total: number; calls: number; bad: Array<{ target: string; bucket: string }> };

export function parseAuthProbeSummary(summary: string): AuthProbeSummary | null {
  const m = /^Auth probe: (\d+)\/(\d+) targets ok \((\d+) model call\(s\)\)(?:; not ok: (.+))?$/.exec(summary);
  if (!m) return null;
  const ok = Number(m[1]);
  const total = Number(m[2]);
  const calls = Number(m[3]);
  if (total < 1 || ok > total || calls > total) return null;
  const bad: Array<{ target: string; bucket: string }> = [];
  if (m[4] !== undefined) {
    for (const part of m[4].split(", ")) {
      const bm = /^([^,= ]+)=([a-z_]+)$/.exec(part);
      if (!bm) return null;
      if (!(AUTH_PROBE_BUCKETS as readonly string[]).includes(bm[2])) return null;
      bad.push({ target: bm[1], bucket: bm[2] });
    }
  }
  if (bad.length !== total - ok) return null;
  return { ok, total, calls, bad };
}

export function authProbeHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "auth-probe" });
  let runs = 0;
  let okTargets = 0;
  let totalTargets = 0;
  let calls = 0;
  let latestOk = 0;
  let latestTotal = 0;
  let unparseable = 0;
  const buckets = new Map<string, number>(AUTH_PROBE_BUCKETS.map(b => [b, 0]));
  for (const line of lines) {
    const parsed = parseAuthProbeSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    runs += 1;
    okTargets += parsed.ok;
    totalTargets += parsed.total;
    calls += parsed.calls;
    latestOk = parsed.ok;
    latestTotal = parsed.total;
    for (const b of parsed.bad) buckets.set(b.bucket, (buckets.get(b.bucket) ?? 0) + 1);
  }
  const notOk = totalTargets - okTargets;
  const parts: string[] = [];
  parts.push("Auth probe history: " + (notOk > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(runs) + " runs");
  parts.push(String(okTargets) + " ok targets");
  parts.push(String(totalTargets) + " total targets");
  parts.push(String(calls) + " model calls");
  parts.push("latest " + String(latestOk) + "/" + String(latestTotal) + " targets ok");
  for (const b of AUTH_PROBE_BUCKETS) parts.push(b + " " + String(buckets.get(b) ?? 0));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

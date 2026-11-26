import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import type { TurnRoute } from "./budgets.js";
import { providerPinBlocker, resolveTurnConnection, type TurnConnection } from "./providers.js";
import { ChatStore } from "./chats.js";
import { errorReason } from "./error-reason.js";

// Model failover (sprint item 2). A profile's primary route is its
// provider+model pin (or the environment provider when it has none).
// Ordered fallbacks live in .sam/fallbacks.db as provider id + model,
// never a key. When a turn's provider fails before any tool has run,
// the turn tries the next route and ledgers the hop. A failure after a
// tool has executed stays on that route: replaying the turn on another
// model could double the tool's effects.

export interface FallbackRoute { provider: string; model: string }
export interface TurnToolGuard { toolsStarted: boolean }

const MAX_FALLBACKS = 4;
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function pathFor(root: string): string { return join(resolve(root), ".sam", "fallbacks.json"); }
function fallbacksDbFile(root: string): string { return join(resolve(root), ".sam", "fallbacks.db"); }

// State convergence (UNIFICATION item 4, twenty-fifth store): the
// failover routes store is SQLite (.sam/fallbacks.db, the providers
// pattern), one row per profile keyed by profile holding that
// profile's routes JSON, rowid order = the old file order. The old
// fallbacks.json was rewritten whole on every add and clear, and its
// writers (the CLI) ran beside fallbackRoutes readers on every turn's
// route build (turnRoutes) and every relay, so two writers holding
// the same snapshot silently lost the second one's change -
// routing-shaped here: a cleared fallback could resurrect and a turn
// would fail over to a provider the operator removed, an added
// fallback could vanish, and a profile's whole route list could
// revert. Its reader also THREW on a malformed file, taking down
// every turn that builds routes instead of failing closed to the
// primary route alone. Here each mutation is a single-row INSERT,
// UPDATE, or DELETE, and connections carry a busy_timeout so a
// writer waits out a peer's transaction instead of dying on
// "database is locked". First open imports a legacy fallbacks.json
// in file order and renames it fallbacks.json.migrated - imported,
// never deleted; a malformed file imports nothing and is left in
// place (the migrated shape reads it as no fallbacks - the primary
// route alone - instead of throwing). A pure read on an install
// with neither file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with no
// backup change.
// Failure visibility (gap found 2026-11-14, hourly run
// 21:04 EST): the failover store holds each profile's ordered
// fallback provider+model routes, and every touch opened it
// raw. fallbackRoutes is read on every turn's route build, so
// a dead fallbacks.db threw into whichever catch wrapped the
// turn with the seam unnamed, and no failover-failed kind
// existed, so the class was uncountable, and any reader
// folding a dead store as "no fallbacks" would silently drop
// a profile's fallback routes dressed as an empty list. Now
// the store's touches own their failure (the events /
// connectors precedent): a failed touch ledgers ONE
// failover-failed line (phase read for fallbackRoutes, write
// for add / update / clear; actor sam; the verbatim reason
// collapsed and capped; never any route record - provider
// and model names are routing data, not failure data), tags
// the error, and rethrows exactly, so every caller's handling
// is unchanged and routing still fails closed. A touch
// already ledgered by an inner door keeps its one line and
// gains no second. Validation errors (bad profile / provider
// / model shape, unknown provider, fallback limit) are not
// store failures and ledger nothing. An absent store still
// reads empty with no line and creates nothing, and torn row
// payloads still parse forgiving - only the store touch is
// guarded.
export type FailoverPhase = "read" | "write";

export function failoverFailureSummary(phase: FailoverPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Failover " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a failover-failed line carries (census sprint
 * 2026-11-17): recordFailoverFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function failoverStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordFailoverFailure(root: string, phase: FailoverPhase, error: unknown): void {
  const reason = failoverStoreFailureReason(error);
  recordActivity(root, "sam", "failover-failed", failoverFailureSummary(phase, reason));
}

function tagFailoverLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { failoverLedgered?: boolean }).failoverLedgered = true;
  }
}

export function isFailoverLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { failoverLedgered?: boolean }).failoverLedgered === true;
}

// The ONE writer for the failover-route activity line, so
// the history scorecard's parser below can never drift from
// the seam it counts. Its shape is byte-identical to what
// the CLI's add-fallback seam wrote inline before this
// writer existed.
export function failoverRouteLedgerSummary(provider: string, model: string): string {
  return "Fallback route added: " + provider + "/" + model;
}

// The failover history scorecard (2026-11-21, the
// measured-proof series): the failover family ledgers
// three classes - "failover" (a turn's hop to the next
// route, through failoverSummary in agent-turn.ts; for a
// rescued turn the hop line is the ONLY record the primary
// route died), "failover-route" (a fallback route added,
// through the writer above), and "failover-failed" (a dead
// fallbacks store touch, through failoverFailureSummary,
// phases read / write) - but none of the three was ever
// folded, so how many turns were ever rescued by a hop,
// how many routes were ever configured, and how many store
// touches ever died fail-closed was invisible in
// aggregate; the fallbacks store holds only CURRENT routes
// per profile, so a removed route and every past hop leave
// no surface but these ledger lines. A hop is failover
// working as designed, not an alarm, so the verdict is
// attention only when a store failure was ever recorded or
// a line is unparseable, else clear (the heartbeat-
// deliveries precedent). This text folds the family to
// counts only, on ONE line: the hop count, the routes-added
// count, the failed count with its read / write split, the
// distinct-chat count as a number only, and the total. No
// stamp, no actor, no chat id, no provider or model name,
// no reason, and no verbatim summary enters the text - the
// summaries carry provider and model names and verbatim
// error reasons, and the fold consumes and never prints
// them. The parsers validate each line against the fixed
// shapes the writers themselves produce, so a drifted line
// counts as unparseable rather than surfacing as free
// text. A pure read: it creates nothing, opens no store,
// and routes nothing - the seams themselves are untouched
// beyond the CLI seam riding the writer above.
export function parseFailoverSummary(summary: string): { chat: string; from: string; to: string } | null {
  const m = /^Failover in chat (\S{8}): (\S+) -> (\S+) \(([\s\S]+)\)$/.exec(summary);
  if (!m) return null;
  return { chat: m[1] ?? "", from: m[2] ?? "", to: m[3] ?? "" };
}

export function parseFailoverRouteSummary(summary: string): { provider: string; model: string } | null {
  const m = /^Fallback route added: ([^/\s]+)\/(\S+)$/.exec(summary);
  if (!m) return null;
  return { provider: m[1] ?? "", model: m[2] ?? "" };
}

export function parseFailoverFailureSummary(summary: string): { phase: FailoverPhase } | null {
  const m = /^Failover (read|write) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  return { phase: (m[1] ?? "read") as FailoverPhase };
}

export function failoverHistoryScorecardText(root: string): string {
  const hopLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "failover" });
  const routeLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "failover-route" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "failover-failed" });
  let hops = 0;
  let routesAdded = 0;
  let failed = 0;
  let failedRead = 0;
  let failedWrite = 0;
  let unparseable = 0;
  const chats = new Set<string>();
  for (const line of hopLines) {
    const parsed = parseFailoverSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    hops += 1;
    chats.add(parsed.chat);
  }
  for (const line of routeLines) {
    const parsed = parseFailoverRouteSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    routesAdded += 1;
  }
  for (const line of failedLines) {
    const parsed = parseFailoverFailureSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    failed += 1;
    if (parsed.phase === "read") failedRead += 1; else failedWrite += 1;
  }
  const total = hopLines.length + routeLines.length + failedLines.length;
  const parts: string[] = [];
  parts.push("Failover history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(hops) + " hops");
  parts.push(String(routesAdded) + " routes added");
  parts.push(String(failed) + " failed");
  parts.push("read " + String(failedRead) + " / write " + String(failedWrite));
  parts.push(String(chats.size) + " distinct chats");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

const FAILOVER_VALIDATION = [/^Invalid profile$/, /^Invalid provider id$/, /^Invalid model$/, /^Unknown provider "/, /^Fallback limit reached \(/];

function isFailoverValidation(error: unknown): boolean {
  return error instanceof Error && FAILOVER_VALIDATION.some(re => re.test(error.message));
}

function failFailover(root: string, phase: FailoverPhase, error: unknown): never {
  if (!isFailoverLedgered(error) && !isFailoverValidation(error)) recordFailoverFailure(root, phase, error);
  if (!isFailoverValidation(error)) tagFailoverLedgered(error);
  throw error;
}

function openFallbacksGuarded(root: string, phase: FailoverPhase): Database.Database {
  try { return openFallbacksStore(root); }
  catch (error) { failFailover(root, phase, error); }
}

function openFallbacksStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(fallbacksDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS fallbacks (profile TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyFallbacks(db, root);
  return db;
}
function migrateLegacyFallbacks(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM fallbacks").get() as { n: number };
  if (n > 0) return;
  const file = pathFor(root);
  if (!existsSync(file)) return;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO fallbacks (profile, data) VALUES (?, ?)");
  const importAll = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [profile, rows] of entries) {
      if (!Array.isArray(rows)) continue;
      if (rows.length > MAX_FALLBACKS) continue;
      const routes: FallbackRoute[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const r = row as Partial<FallbackRoute>;
        if (typeof r.provider !== "string" || typeof r.model !== "string") continue;
        routes.push({ provider: r.provider, model: r.model });
      }
      if (routes.length === 0) continue;
      insert.run(profile, JSON.stringify(routes));
    }
  });
  importAll(Object.entries(value as Record<string, unknown>));
  renameSync(file, file + ".migrated");
}
function storeExists(root: string): boolean {
  return existsSync(fallbacksDbFile(root)) || existsSync(pathFor(root));
}
function rowToRoutes(data: string): FallbackRoute[] {
  try {
    const value: unknown = JSON.parse(data);
    if (!Array.isArray(value)) return [];
    const routes: FallbackRoute[] = [];
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const r = row as Partial<FallbackRoute>;
      if (typeof r.provider !== "string" || typeof r.model !== "string") continue;
      routes.push({ provider: r.provider, model: r.model });
    }
    return routes;
  } catch { return []; }
}
function findRoutesRow(db: Database.Database, profile: string): FallbackRoute[] | null {
  const row = db.prepare("SELECT data FROM fallbacks WHERE profile = ?").get(profile) as { data: string } | undefined;
  return row ? rowToRoutes(row.data) : null;
}
function validateRoute(root: string, route: FallbackRoute, env: NodeJS.ProcessEnv): FallbackRoute {
  if (!ID_RE.test(route.provider)) throw new Error("Invalid provider id");
  if (!MODEL_RE.test(route.model)) throw new Error("Invalid model");
  const providerBlocker = providerPinBlocker(root, route.provider, env);
  if (providerBlocker) throw new Error(providerBlocker);
  return { provider: route.provider, model: route.model };
}

export function fallbackRoutes(root: string, profile: string): FallbackRoute[] {
  if (!storeExists(root)) return [];
  const db = openFallbacksGuarded(root, "read");
  try { return findRoutesRow(db, profile) ?? []; }
  catch (error) { failFailover(root, "read", error); }
  finally { db.close(); }
}

export function addFallbackRoute(root: string, profile: string, route: FallbackRoute, env: NodeJS.ProcessEnv = process.env): FallbackRoute[] {
  if (!ID_RE.test(profile)) throw new Error("Invalid profile");
  const clean = validateRoute(root, route, env);
  const db = openFallbacksGuarded(root, "write");
  try {
    const current = findRoutesRow(db, profile) ?? [];
    if (current.some(r => r.provider === clean.provider && r.model === clean.model)) return current;
    if (current.length >= MAX_FALLBACKS) throw new Error("Fallback limit reached (" + MAX_FALLBACKS + ")");
    const next = [...current, clean];
    db.prepare("INSERT INTO fallbacks (profile, data) VALUES (?, ?) ON CONFLICT(profile) DO UPDATE SET data = excluded.data").run(profile, JSON.stringify(next));
    return next;
  } catch (error) { failFailover(root, "write", error); }
  finally { db.close(); }
}

// The single-row patch door (the providers precedent): replaces one
// profile's whole route list by profile, validated exactly as
// addFallbackRoute validates each route. Returns null when the
// profile has no existing row; an empty list deletes the row.
export function updateFallbackRoutes(root: string, profile: string, routes: FallbackRoute[], env: NodeJS.ProcessEnv = process.env): FallbackRoute[] | null {
  if (!ID_RE.test(profile)) throw new Error("Invalid profile");
  if (!storeExists(root)) return null;
  const cleaned: FallbackRoute[] = [];
  for (const route of routes) {
    const clean = validateRoute(root, route, env);
    if (!cleaned.some(r => r.provider === clean.provider && r.model === clean.model)) cleaned.push(clean);
  }
  if (cleaned.length > MAX_FALLBACKS) throw new Error("Fallback limit reached (" + MAX_FALLBACKS + ")");
  const db = openFallbacksGuarded(root, "write");
  try {
    const existing = findRoutesRow(db, profile);
    if (existing === null) return null;
    if (cleaned.length === 0) {
      db.prepare("DELETE FROM fallbacks WHERE profile = ?").run(profile);
      return [];
    }
    db.prepare("UPDATE fallbacks SET data = ? WHERE profile = ?").run(JSON.stringify(cleaned), profile);
    return cleaned;
  } catch (error) { failFailover(root, "write", error); }
  finally { db.close(); }
}

function normalizeFailoverProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The ONE source for why a failover route cannot be added
 *  or cleared under this profile name: the name is not in
 *  the profile registry ("sam", the implicit core profile,
 *  plus every registered agent), so routes recorded under
 *  it would belong to nobody - turnRoutes only ever reads
 *  routes under a real profile's name, so they could never
 *  fire - and routes the operator meant to clear under a
 *  mistyped name would stand untouched. The pair asymmetry
 *  is the defect (the skill-allowlist pair's lesson): the
 *  CLI `agents add-fallback` door checked the registry
 *  inline, but its pair door `agents clear-fallbacks`
 *  passed the raw name into clearFallbackRoutes, whose
 *  honest cleared:false for a phantom is byte-identical to
 *  a real profile with no routes to clear - the operator
 *  cannot tell a typo from nothing-to-clear, and a folded
 *  name ("Second Shift" for "second-shift") silently
 *  clears nothing while the real profile's routes stand.
 *  Both CLI failover doors now throw this source's text
 *  before adding or clearing anything. When exactly one
 *  valid profile matches the bad name folded for case and
 *  separators, the refusal names it. Null means the
 *  profile can be named. The store itself stays permissive
 *  by design: a profile removed after routes name it keeps
 *  its stored row, and a later store-level clear under that
 *  name must still be able to lift it, and turnRoutes names
 *  its profile by construction from the speaking chat, so
 *  addFallbackRoute / clearFallbackRoutes are NOT gated
 *  here. */
export function failoverProfileBlocker(root: string, profile: string): string | null {
  const db = new ChatStore(root);
  let names: string[];
  try { names = ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; } finally { db.close(); }
  if (names.includes(profile)) return null;
  const target = normalizeFailoverProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizeFailoverProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in failover route detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

export function clearFallbackRoutes(root: string, profile: string): boolean {
  if (!storeExists(root)) return false;
  const db = openFallbacksGuarded(root, "write");
  try {
    const existing = findRoutesRow(db, profile);
    if (existing === null) return false;
    db.prepare("DELETE FROM fallbacks WHERE profile = ?").run(profile);
    return true;
  } catch (error) { failFailover(root, "write", error); }
  finally { db.close(); }
}

// Primary first, then each configured fallback that resolves to a
// different provider+model. The caller decides whether a dead primary
// is fatal (no fallbacks) or worth trying the next route.
export function turnRoutes(root: string, env: NodeJS.ProcessEnv, profileName: string, profile: { provider?: string | null; model?: string | null } | null, route: TurnRoute): TurnConnection[] {
  const primary = resolveTurnConnection(root, env, profile, route);
  const out: TurnConnection[] = [primary];
  const seen = new Set([primary.providerId + "\n" + (primary.model ?? "")]);
  for (const extra of fallbackRoutes(root, profileName)) {
    const conn = resolveTurnConnection(root, env, { provider: extra.provider, model: extra.model }, route);
    const key = conn.providerId + "\n" + (conn.model ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(conn);
  }
  return out;
}

// Connector failures are not a dead model: another route would hit the
// same pinned connector. Everything else the provider can throw before
// a tool runs (error, empty, unsafe, missing key, missing endpoint) is
// eligible, and only while no tool has started.
export function failoverEligible(error: unknown, guard: TurnToolGuard): boolean {
  if (guard.toolsStarted) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/connector unavailable|MCP connector|No approved MCP|No configured MCP/i.test(message)) return false;
  return true;
}

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import type { TurnRoute } from "./budgets.js";
import { listProviders, resolveTurnConnection, type TurnConnection } from "./providers.js";
import { MEMBER_PROVIDER_ID, managedConfig, memberConnection, memberForProfile, memberManagedStatus } from "./members.js";
import { tierForRoute } from "./model-routing.js";

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

export function recordFailoverFailure(root: string, phase: FailoverPhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
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
  if (!listProviders(root, env).some(p => p.id === route.provider))
    throw new Error("Unknown provider \"" + route.provider + "\". Configured providers: " + listProviders(root, env).map(p => p.id).join(", "));
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
  // Member accounts (Mission Control) route ONLY on the member's
  // own key: one route, endpoint and model from the member record,
  // the key resolved from the vault by name at call time. The house
  // environment key is never a member route, and a member with no
  // key gets an unavailable route whose reason is plain words the
  // app can show as-is. Fallback files do not apply to members -
  // their key is the whole arrangement.
  const member = memberForProfile(root, profileName);
  if (member) {
    if (member.keySource === "managed") {
      // Managed path: the house provider, metered per account
      // against config caps. The meter is the session-cap ledger
      // summed over the member's own chats; when it is spent the
      // route is unavailable with plain words, and the member's
      // own key remains one switch away.
      const cfg = managedConfig(env);
      if (!cfg.enabled) {
        return [{
          providerId: MEMBER_PROVIDER_ID, endpoint: null, keyEnv: "", key: "absent",
          model: null, tier: tierForRoute(route), source: "profile",
          unavailable: "Running on our key is not open yet. Add your own key and SAM is ready today.",
        }];
      }
      const status = memberManagedStatus(root, member, env);
      if (status.spent) {
        return [{
          providerId: MEMBER_PROVIDER_ID, endpoint: null, keyEnv: "", key: "absent",
          model: null, tier: tierForRoute(route), source: "profile",
          unavailable: "Today's included usage is used up. Add your own key to keep going, or come back tomorrow.",
        }];
      }
      return [resolveTurnConnection(root, env, null, route)];
    }
    const conn = memberConnection(root, member);
    if ("unavailable" in conn) {
      return [{
        providerId: MEMBER_PROVIDER_ID, endpoint: null, keyEnv: "", key: "absent",
        model: null, tier: tierForRoute(route), source: "profile", unavailable: conn.unavailable,
      }];
    }
    return [{
      providerId: MEMBER_PROVIDER_ID, endpoint: conn.endpoint, keyEnv: "", key: "present",
      model: conn.model, tier: tierForRoute(route), source: "profile", vaultKey: conn.vaultKey,
    }];
  }
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

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";

// The dashboard config store: which profile the dashboard (and
// every unbound chat, turn, and heartbeat tick) treats as the
// default actor, plus whether team events show. Two fields, read
// on nearly every turn, written only from the dashboard's own
// config panel.
//
// This module exists so the store has ONE read door. Before the
// migration, dashboard.ts read the JSON file its way (any string
// defaultAgent kept, an unguarded JSON.parse that threw on a
// torn file) while chat-manage.ts coreActor read the raw file
// again its own way (a non-empty string only, errors swallowed)
// - two readers of one fact, already disagreeing at the edges.
// Both now ride readDashboardConfig here. The module stays a
// leaf store on purpose: dashboard.ts already cycles with
// agent-turn / own-tools / chat-manage, and its only app
// import is the activity ledger (itself a leaf), so it adds
// no new cycle.

export interface DashboardConfig { defaultAgent: string; showTeamEvents: boolean }

export const defaultDashboardConfig: DashboardConfig = { defaultAgent: "sam", showTeamEvents: true };

function configPath(root: string) { return join(resolve(root), ".sam", "dashboard-config.json"); }
function configDbPath(root: string) { return join(resolve(root), ".sam", "dashboard-config.db"); }

// State convergence (UNIFICATION item 4, thirty-first store):
// the dashboard config is SQLite (.sam/dashboard-config.db, the
// setup / auth-probes singleton pattern), ONE row holding the
// config's full JSON so the singleton keeps its exact shape.
// The old dashboard-config.json was rewritten whole by
// saveDashboardConfig on every config save - a plain
// writeFileSync - while readers run in every process that
// turns or ticks (the dashboard status path, agent-turn's
// actor + profile resolution, heartbeat's profile resolution,
// chat-manage's coreActor). A torn write threw out of the
// dashboard reader, so one bad save could kill status reads
// and turn routing instead of reading as the default. Here a
// save is a single-row UPSERT and connections carry a
// busy_timeout, so no reader in any process can ever see a
// torn config. First open imports a legacy
// dashboard-config.json (validated through the old read
// shape: a plain object, sanitized per-field - a non-empty
// string defaultAgent kept, anything else "sam";
// showTeamEvents false only when literally false) and
// renames it dashboard-config.json.migrated - imported, never
// deleted; a malformed file or a non-object payload imports
// nothing and is left in place (the migrated shape reads it
// as the default config - strictly more forgiving than the
// old dashboard reader, which threw, and exactly what
// chat-manage's reader already claimed to mirror). A pure
// read on an install with neither file creates nothing and
// returns the defaults. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried
// with no backup change.
function parseDashboardConfig(data: unknown): DashboardConfig | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<DashboardConfig>;
  return {
    defaultAgent: typeof value.defaultAgent === "string" && value.defaultAgent ? value.defaultAgent : "sam",
    showTeamEvents: value.showTeamEvents !== false,
  };
}
function openConfigStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(configDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS dashboard_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyConfig(db, root);
  return db;
}
function migrateLegacyConfig(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM dashboard_config WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = configPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseDashboardConfig(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO dashboard_config (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function configStoreExists(root: string): boolean {
  return existsSync(configDbPath(root)) || existsSync(configPath(root));
}

// Dashboard-config failure visibility (hourly run
// 2026-11-14): this store is read on nearly every turn, and
// every touch was unguarded. The direct readers (agent-turn's
// profile resolution, heartbeat's consolidation resolution,
// status.ts folding the config into buildStatusPayload) rode
// readDashboardConfig bare, so a dead .sam/dashboard-config.db
// threw raw - a turn or tick died with the config seam
// unnamed, and the whole /api/status payload died with no
// line anywhere. The resolver, chat-manage's coreActor,
// wrapped the same read in a bare catch returning "sam" -
// the designed answer for no config saved - so a workspace
// whose default agent is a scoped profile silently routed
// every unbound chat to the core profile instead, a routing
// / scoping failure indistinguishable from no config. The
// write door threw raw behind the dashboard's config save.
// Now the store owns its touches (the bindings / mini-door
// precedent): a failed open/read/write ledgers ONE
// dashboard-config-failed line (phase read for the direct
// readers, phase resolve when the caller is coreActor, phase
// write for the write door; actor sam; the verbatim reason
// collapsed and capped; never any config content) and
// rethrows exactly, tagged so a catching caller records
// nothing more for the same touch. coreActor still returns
// "sam" on a failure exactly as before, now countable. A
// failed direct read still fails closed exactly as before,
// now ledgered. An absent store still returns the defaults
// with no line and creates nothing, and a torn row payload
// still parses forgiving to the defaults - only the store
// touch is guarded.
export type DashboardConfigPhase = "read" | "resolve" | "write";

export function dashboardConfigFailureSummary(phase: DashboardConfigPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Dashboard config " + phase + " failed: " + clean).slice(0, 200);
}

export function recordDashboardConfigFailure(root: string, phase: DashboardConfigPhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "dashboard-config-failed", dashboardConfigFailureSummary(phase, reason));
}

function tagDashboardConfigLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { dashboardConfigLedgered?: boolean }).dashboardConfigLedgered = true;
  }
}

export function isDashboardConfigLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { dashboardConfigLedgered?: boolean }).dashboardConfigLedgered === true;
}

function failDashboardConfig(root: string, phase: DashboardConfigPhase, error: unknown): never {
  if (!isDashboardConfigLedgered(error)) recordDashboardConfigFailure(root, phase, error);
  tagDashboardConfigLedgered(error);
  throw error;
}

/** The store's write door: one UPSERT of the full config.
 *  Validation (key set, types, the agent-name regex, the
 *  unknown-agent refusal) stays with the caller in
 *  dashboard.ts saveDashboardConfig, exactly where it lived
 *  when the store was a file. */
export function writeDashboardConfig(root: string, config: DashboardConfig): void {
  let db: Database.Database;
  try { db = openConfigStore(root); } catch (error) { failDashboardConfig(root, "write", error); }
  try {
    db!.prepare("INSERT INTO dashboard_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(config));
  } catch (error) { failDashboardConfig(root, "write", error); }
  finally { db!.close(); }
}

// The store's read door: the recorded config through the
// store's own shape, or the defaults when no config has ever
// been saved - and a read on an install with no store at all
// creates nothing. The phase names the caller's shape for
// the failure line: "read" for direct readers (the default),
// "resolve" for chat-manage's coreActor, whose fallback to
// "sam" is the designed answer for no config and must stay
// distinguishable from a dead store.
export function readDashboardConfig(root: string, phase: DashboardConfigPhase = "read"): DashboardConfig {
  if (!configStoreExists(root)) return { ...defaultDashboardConfig };
  let db: Database.Database;
  try { db = openConfigStore(root); } catch (error) { failDashboardConfig(root, phase, error); }
  try {
    const row = db!.prepare("SELECT data FROM dashboard_config WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return { ...defaultDashboardConfig };
    try { return parseDashboardConfig(JSON.parse(row.data)) ?? { ...defaultDashboardConfig }; } catch { return { ...defaultDashboardConfig }; }
  } catch (error) { failDashboardConfig(root, phase, error); }
  finally { db!.close(); }
}

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

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
// Both now ride readDashboardConfig here. The module imports
// nothing from the app on purpose: dashboard.ts already cycles
// with agent-turn / own-tools / chat-manage, and a leaf store
// adds no new cycle.

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
  const db = new Database(configDbPath(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
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

/** The store's write door: one UPSERT of the full config.
 *  Validation (key set, types, the agent-name regex, the
 *  unknown-agent refusal) stays with the caller in
 *  dashboard.ts saveDashboardConfig, exactly where it lived
 *  when the store was a file. */
export function writeDashboardConfig(root: string, config: DashboardConfig): void {
  const db = openConfigStore(root);
  try {
    db.prepare("INSERT INTO dashboard_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(config));
  } finally { db.close(); }
}

// The store's read door: the recorded config through the
// store's own shape, or the defaults when no config has ever
// been saved - and a read on an install with no store at all
// creates nothing.
export function readDashboardConfig(root: string): DashboardConfig {
  if (!configStoreExists(root)) return { ...defaultDashboardConfig };
  const db = openConfigStore(root);
  try {
    const row = db.prepare("SELECT data FROM dashboard_config WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return { ...defaultDashboardConfig };
    try { return parseDashboardConfig(JSON.parse(row.data)) ?? { ...defaultDashboardConfig }; } catch { return { ...defaultDashboardConfig }; }
  } finally { db.close(); }
}

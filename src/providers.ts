import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { modelEndpoint, modelApiKey } from "./config-wizard.js";
import { resolveModelForRoute, tierForRoute, type ModelSource, type ModelTier } from "./model-routing.js";
import type { TurnRoute } from "./budgets.js";
import { errorReason } from "./error-reason.js";

// Multi-provider (sprint item 1). SAM used to run one provider: the
// env triple SAM_MODEL_PROVIDER / SAM_MODEL_ENDPOINT / SAM_MODEL_API_KEY
// (or MINIMAX_API_KEY). That env provider still exists and is still
// the default for every unpinned profile. Additional providers live
// in .sam/providers.db as endpoint + key ENV NAME + model. The store
// never holds a key value. A profile pins a provider id plus a model;
// two profiles can therefore talk to two providers in the same process.

export const RESERVED_PROVIDER_IDS = ["default", "minimax"] as const;
const ID_RE = /^[a-z][a-z0-9._-]{0,31}$/;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_PROVIDERS = 16;

export interface ConfiguredProvider {
  id: string;
  source: "env" | "file";
  endpoint: string | null;
  keyEnv: string;
  key: "present" | "absent";
  model: string | null;
  cheapModel: string | null;
  deepModel: string | null;
}

export interface TurnConnection {
  providerId: string;
  endpoint: string | null;
  keyEnv: string;
  key: "present" | "absent";
  model: string | null;
  tier: ModelTier;
  source: ModelSource;
  /** Set when the profile pins a provider id that is not configured. */
  unavailable?: string;
}

export interface FileProvider {
  id: string;
  endpoint: string;
  keyEnv: string;
  model: string;
  cheapModel: string | null;
  deepModel: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

// Same resolution order as auth-status's modelKeyEnvName. Kept here so
// provider code does not import the probe module (that module imports
// this one). The two functions must stay in lockstep.
export function modelKeyEnvName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SAM_MODEL_API_KEY?.trim()) return "SAM_MODEL_API_KEY";
  if (env.SAM_MODEL_PROVIDER === "minimax") return "MINIMAX_API_KEY";
  return "SAM_MODEL_API_KEY";
}

export function envProviderId(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAM_MODEL_PROVIDER === "minimax" ? "minimax" : "default";
}

/** Read a key by env-var NAME. The value is for the request header only; never persist or print it. */
export function readProviderKey(env: NodeJS.ProcessEnv, keyEnv: string): string | null {
  if (!keyEnv || !KEY_ENV_RE.test(keyEnv)) return null;
  return clean(env[keyEnv]);
}

export function assertChatCompletionsUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("Model endpoint must be an absolute URL ending in /chat/completions"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.hash || url.search ||
      !url.pathname.endsWith("/chat/completions"))
    throw new Error("Model endpoint must be HTTPS (HTTP allowed on loopback), without credentials, query or fragment, ending in /chat/completions");
  if (url.hostname === "0.0.0.0") throw new Error("Wildcard model endpoint forbidden");
  return url.toString();
}

function assertModel(model: string, field: string): string {
  const value = model.trim();
  if (!MODEL_RE.test(value)) throw new Error("Invalid " + field + " (letters, digits, dot, underscore, hyphen; max 80)");
  return value;
}

function providersPath(root: string): string {
  return join(resolve(root), ".sam", "providers.json");
}
function providersDbFile(root: string): string {
  return join(resolve(root), ".sam", "providers.db");
}
// State convergence (UNIFICATION item 4, twenty-fourth store): the
// provider registry is SQLite (.sam/providers.db, the connectors
// pattern), one row per provider keyed by its id holding the record's
// full JSON, rowid order = the old file order. The old providers.json
// was rewritten whole on every add and remove, and its writers (the
// CLI) ran beside readFileProviders readers on every turn's
// connection resolution, every failover route build, and every
// auth-status / dashboard build, so two writers holding the same
// snapshot silently lost the second one's change - routing-shaped
// here: a removed provider could resurrect (and a profile pinned to
// it would send its turns, addressed to the key named by keyEnv, to
// that endpoint again), an added provider could vanish, and a
// reverted endpoint silently re-pointed a profile's model traffic.
// Its reader also THREW on a malformed file, taking down every turn
// that resolves a connection instead of failing closed to the
// environment provider alone. Here each mutation is a single-row
// INSERT, UPDATE, or DELETE, and connections carry a busy_timeout so
// a writer waits out a peer's transaction instead of dying on
// "database is locked". First open imports a legacy providers.json
// in file order and renames it providers.json.migrated - imported,
// never deleted; a malformed file, a non-array payload, or an
// over-cap payload imports nothing and is left in place (the
// migrated shape reads it as no file providers, the environment
// provider alone, instead of throwing). A pure read on an install
// with neither file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with no
// backup change.
// Failure visibility (gap found 2026-11-15, hourly run
// 00:04 EST): the provider registry holds one row per
// file-configured provider - endpoint, key ENV NAME, and
// models - and a profile's provider pin resolves its turns
// through it. Every touch opened it raw: readFileProviders
// rides listProviders, resolveTurnConnection on every pinned
// turn, auth status, failover validation, the CLI, and
// observability; the writes ride the CLI's add / update /
// remove. A dead providers.db threw into whichever catch
// wrapped the call with the seam unnamed, and no
// provider-store-failed kind existed, so the class was
// uncountable, and any reader folding a dead store as "no
// file providers" would silently drop every provider pin
// dressed as an empty registry. Now the store's touches own
// their failure (the minis / failover precedent): a failed
// touch ledgers ONE provider-store-failed line (phase read
// for readFileProviders, write for add / update / remove;
// actor sam; the verbatim reason collapsed and capped; never
// any provider record - endpoints, key env names, and model
// names are routing data, not failure data), tags the error,
// and rethrows exactly, so every caller's handling is
// unchanged and reads still fail closed. A touch already
// ledgered by an inner door keeps its one line and gains no
// second. Validation errors (bad id / keyEnv / endpoint /
// model shape, reserved id, already exists, limit, the
// env-provider removal refusal) are not store failures and
// ledger nothing. An absent store still reads as the env
// provider alone with no line and creates nothing, and torn
// row payloads still parse forgiving - only the store touch
// is guarded.
export type ProviderStorePhase = "read" | "write";

export function providerStoreFailureSummary(phase: ProviderStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Provider store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a provider-store-failed line carries (census sprint
 * 2026-11-17): recordProviderStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function providerStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordProviderStoreFailure(root: string, phase: ProviderStorePhase, error: unknown): void {
  const reason = providerStoreFailureReason(error);
  recordActivity(root, "sam", "provider-store-failed", providerStoreFailureSummary(phase, reason));
}

// Provider lifecycle history (gap found 2026-11-21, hourly run
// 18:04 EST): the CLI's providers add / remove seams ledger
// "provider-add" and "provider-remove" lines, but the shapes
// were inline strings in cli.ts with no writer, no parser, and
// no fold, so how many providers were ever registered or
// removed over an install's life was invisible in aggregate;
// the providers store holds only CURRENT providers, so a
// removed provider leaves no surface but these lines (the
// failover-routes precedent). These are the ONE writers for
// both shapes (byte-identical to the inline shapes they
// replace; the CLI seams ride them), the parsers, and the
// history scorecard. Adds and removes are operator acts, not
// failures, so the verdict is attention only when a line is
// unparseable, else clear; the provider-store-failed class
// folds in the store-failure history, not here. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp, no
// actor, no provider id, no key env name, and no verbatim
// summary. The scorecard path is a pure read - it creates
// nothing, registers nothing, and opens no store.
export function providerAddLedgerSummary(id: string, keyEnv: string, key: "present" | "absent"): string {
  return "Provider " + id + " registered (key env " + keyEnv + ", " + key + ")";
}

export function providerRemoveLedgerSummary(id: string): string {
  return "Provider " + id + " removed";
}

export function parseProviderAddSummary(summary: string): { id: string; keyEnv: string; key: "present" | "absent" } | null {
  const m = /^Provider (\S+) registered \(key env (\S+), (present|absent)\)$/.exec(summary);
  if (!m) return null;
  return { id: m[1] ?? "", keyEnv: m[2] ?? "", key: (m[3] ?? "absent") as "present" | "absent" };
}

export function parseProviderRemoveSummary(summary: string): { id: string } | null {
  const m = /^Provider (\S+) removed$/.exec(summary);
  if (!m) return null;
  return { id: m[1] ?? "" };
}

export function providerHistoryScorecardText(root: string): string {
  const addLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "provider-add" });
  const removeLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "provider-remove" });
  let added = 0;
  let addedKeyPresent = 0;
  let addedKeyAbsent = 0;
  let removed = 0;
  let unparseable = 0;
  const providers = new Set<string>();
  for (const line of addLines) {
    const parsed = parseProviderAddSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    added += 1;
    if (parsed.key === "present") addedKeyPresent += 1; else addedKeyAbsent += 1;
    providers.add(parsed.id);
  }
  for (const line of removeLines) {
    const parsed = parseProviderRemoveSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    removed += 1;
    providers.add(parsed.id);
  }
  const total = addLines.length + removeLines.length;
  const parts: string[] = [];
  parts.push("Provider history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(added) + " added");
  parts.push("key present " + String(addedKeyPresent) + " / absent " + String(addedKeyAbsent));
  parts.push(String(removed) + " removed");
  parts.push(String(providers.size) + " distinct providers");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function tagProviderStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { providerStoreLedgered?: boolean }).providerStoreLedgered = true;
  }
}

export function isProviderStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { providerStoreLedgered?: boolean }).providerStoreLedgered === true;
}

const PROVIDER_STORE_VALIDATION = [/^Invalid provider id/, /^Provider id "[^"]*" is reserved/, /^keyEnv must be/, /^Model endpoint must be/, /^Wildcard model endpoint forbidden$/, /^Invalid (model|cheap model|deep model)/, /^Provider already exists:/, /^Provider limit reached \(/, /^The environment provider is not stored here/];

function isProviderStoreValidation(error: unknown): boolean {
  return error instanceof Error && PROVIDER_STORE_VALIDATION.some(re => re.test(error.message));
}

function failProviderStore(root: string, phase: ProviderStorePhase, error: unknown): never {
  if (!isProviderStoreLedgered(error) && !isProviderStoreValidation(error)) recordProviderStoreFailure(root, phase, error);
  if (!isProviderStoreValidation(error)) tagProviderStoreLedgered(error);
  throw error;
}

function openProvidersGuarded(root: string, phase: ProviderStorePhase): Database.Database {
  try { return openProvidersStore(root); }
  catch (error) { failProviderStore(root, phase, error); }
}

function openProvidersStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(providersDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyProviders(db, root);
  return db;
}
function migrateLegacyProviders(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number };
  if (n > 0) return;
  const file = providersPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  if (data.length > MAX_PROVIDERS) return;
  const insert = db.prepare("INSERT OR IGNORE INTO providers (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      const row = legacyFileProvider(raw);
      if (!row) continue;
      insert.run(row.id, JSON.stringify(row));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function legacyFileProvider(raw: unknown): FileProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<FileProvider>;
  if (typeof r.id !== "string" || typeof r.endpoint !== "string" || typeof r.keyEnv !== "string" || typeof r.model !== "string") return null;
  return {
    id: r.id,
    endpoint: r.endpoint,
    keyEnv: r.keyEnv,
    model: r.model,
    cheapModel: typeof r.cheapModel === "string" ? r.cheapModel : null,
    deepModel: typeof r.deepModel === "string" ? r.deepModel : null,
  };
}
function rowToFileProvider(data: string): FileProvider | null {
  try { return legacyFileProvider(JSON.parse(data)); }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(providersDbFile(root)) || existsSync(providersPath(root));
}
function findProviderRow(db: Database.Database, id: string): FileProvider | null {
  const row = db.prepare("SELECT data FROM providers WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? rowToFileProvider(row.data) : null;
}

function envProvider(env: NodeJS.ProcessEnv): ConfiguredProvider {
  const keyEnv = modelKeyEnvName(env);
  return {
    id: envProviderId(env),
    source: "env",
    endpoint: modelEndpoint(env),
    keyEnv,
    key: modelApiKey(env) ? "present" : "absent",
    model: clean(env.SAM_MODEL),
    cheapModel: clean(env.SAM_MODEL_CHEAP),
    deepModel: clean(env.SAM_MODEL_DEEP),
  };
}

export function readFileProviders(root: string): FileProvider[] {
  if (!storeExists(root)) return [];
  const db = openProvidersGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM providers ORDER BY rowid").all() as Array<{ data: string }>;
    const items: FileProvider[] = [];
    for (const row of rows) { const provider = rowToFileProvider(row.data); if (provider) items.push(provider); }
    return items;
  } catch (error) { failProviderStore(root, "read", error); }
  finally { db.close(); }
}

function toPublic(env: NodeJS.ProcessEnv, row: FileProvider): ConfiguredProvider {
  return {
    id: row.id,
    source: "file",
    endpoint: row.endpoint,
    keyEnv: row.keyEnv,
    key: readProviderKey(env, row.keyEnv) ? "present" : "absent",
    model: row.model,
    cheapModel: row.cheapModel,
    deepModel: row.deepModel,
  };
}

export function listProviders(root: string, env: NodeJS.ProcessEnv = process.env): ConfiguredProvider[] {
  return [envProvider(env), ...readFileProviders(root).map(row => toPublic(env, row))];
}

export function addProvider(root: string, input: { id: string; endpoint: string; keyEnv: string; model: string; cheapModel?: string | null; deepModel?: string | null }, env: NodeJS.ProcessEnv = process.env): ConfiguredProvider {
  const id = input.id.trim();
  if (!ID_RE.test(id)) throw new Error("Invalid provider id (lowercase, start with a letter, max 32)");
  if ((RESERVED_PROVIDER_IDS as readonly string[]).includes(id) || id === envProviderId(env))
    throw new Error("Provider id \"" + id + "\" is reserved for the environment provider");
  const keyEnv = input.keyEnv.trim();
  if (!KEY_ENV_RE.test(keyEnv)) throw new Error("keyEnv must be an environment variable NAME (UPPER_SNAKE), never a key value");
  const endpoint = assertChatCompletionsUrl(input.endpoint.trim());
  const model = assertModel(input.model, "model");
  const cheapModel = input.cheapModel ? assertModel(input.cheapModel, "cheap model") : null;
  const deepModel = input.deepModel ? assertModel(input.deepModel, "deep model") : null;
  const row: FileProvider = { id, endpoint, keyEnv, model, cheapModel, deepModel };
  const db = openProvidersGuarded(root, "write");
  try {
    if (findProviderRow(db, id)) throw new Error("Provider already exists: " + id);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number };
    if (n >= MAX_PROVIDERS) throw new Error("Provider limit reached (" + MAX_PROVIDERS + ")");
    db.prepare("INSERT INTO providers (id, data) VALUES (?, ?)").run(id, JSON.stringify(row));
  } catch (error) { failProviderStore(root, "write", error); }
  finally { db.close(); }
  return toPublic(env, row);
}

// The single-row patch door (the connectors precedent): updates one
// provider row in place by id, validated exactly as addProvider
// validates; a null cheap/deep model clears that tier. The id is not
// patchable. Returns the updated public shape, or null on a miss -
// and a miss on an install with no store creates nothing.
export function updateProvider(root: string, id: string, patch: { endpoint?: string; keyEnv?: string; model?: string; cheapModel?: string | null; deepModel?: string | null }, env: NodeJS.ProcessEnv = process.env): ConfiguredProvider | null {
  if (!storeExists(root)) return null;
  const endpoint = patch.endpoint !== undefined ? assertChatCompletionsUrl(patch.endpoint.trim()) : undefined;
  const keyEnv = patch.keyEnv !== undefined ? patch.keyEnv.trim() : undefined;
  if (keyEnv !== undefined && !KEY_ENV_RE.test(keyEnv)) throw new Error("keyEnv must be an environment variable NAME (UPPER_SNAKE), never a key value");
  const model = patch.model !== undefined ? assertModel(patch.model, "model") : undefined;
  const cheapModel = patch.cheapModel === undefined ? undefined : (patch.cheapModel ? assertModel(patch.cheapModel, "cheap model") : null);
  const deepModel = patch.deepModel === undefined ? undefined : (patch.deepModel ? assertModel(patch.deepModel, "deep model") : null);
  const db = openProvidersGuarded(root, "write");
  try {
    const existing = findProviderRow(db, id);
    if (!existing) return null;
    const next: FileProvider = {
      id: existing.id,
      endpoint: endpoint ?? existing.endpoint,
      keyEnv: keyEnv ?? existing.keyEnv,
      model: model ?? existing.model,
      cheapModel: cheapModel === undefined ? existing.cheapModel : cheapModel,
      deepModel: deepModel === undefined ? existing.deepModel : deepModel,
    };
    db.prepare("UPDATE providers SET data = ? WHERE id = ?").run(JSON.stringify(next), id);
    return toPublic(env, next);
  } catch (error) { failProviderStore(root, "write", error); }
  finally { db.close(); }
}

export function removeProvider(root: string, id: string): boolean {
  if ((RESERVED_PROVIDER_IDS as readonly string[]).includes(id)) throw new Error("The environment provider is not stored here and cannot be removed");
  if (!storeExists(root)) return false;
  const db = openProvidersGuarded(root, "write");
  try {
    return db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
  } catch (error) { failProviderStore(root, "write", error); }
  finally { db.close(); }
}

function modelForTier(row: { model: string | null; cheapModel: string | null; deepModel: string | null }, tier: ModelTier): string | null {
  if (tier === "cheap") return row.cheapModel || row.model;
  if (tier === "deep") return row.deepModel || row.model;
  return row.model;
}

// The connection a turn would actually open. An unpinned profile (and
// the core profile, which has no row) stays on the env provider, and
// the model resolution is the existing tier table, so a pin-less
// install behaves exactly as before. A provider pin selects that
// provider's endpoint and key name; a model pin still wins over the
// provider's own tier model.
export function resolveTurnConnection(root: string, env: NodeJS.ProcessEnv, profile: { provider?: string | null; model?: string | null } | null | undefined, route: TurnRoute): TurnConnection {
  const pinnedProvider = clean(profile?.provider);
  const profileModel = clean(profile?.model);
  const envRow = envProvider(env);
  if (!pinnedProvider || pinnedProvider === envRow.id) {
    const resolved = resolveModelForRoute({ route, profileModel, env });
    return {
      providerId: envRow.id,
      endpoint: envRow.endpoint,
      keyEnv: envRow.keyEnv,
      key: envRow.key,
      model: resolved.model,
      tier: resolved.tier,
      source: resolved.source,
    };
  }
  const file = readFileProviders(root).find(p => p.id === pinnedProvider);
  const tier = tierForRoute(route);
  if (!file) {
    return {
      providerId: pinnedProvider,
      endpoint: null,
      keyEnv: "",
      key: "absent",
      model: profileModel,
      tier,
      source: "profile",
      unavailable: "Profile provider unavailable: " + pinnedProvider,
    };
  }
  const model = profileModel ?? modelForTier(file, tier);
  return {
    providerId: file.id,
    endpoint: file.endpoint,
    keyEnv: file.keyEnv,
    key: readProviderKey(env, file.keyEnv) ? "present" : "absent",
    model,
    tier,
    source: "profile",
  };
}

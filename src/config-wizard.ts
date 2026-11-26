import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { channels, addChannel, channelProfileBlocker, type Channel } from "./channels.js";
import { connectors, connectorCredentialPresent } from "./connectors.js";
import { parseSamConfig, configReadiness } from "./config.js";
import { modelRoutingTable } from "./model-routing.js";
import { connectEngine, engineConnectStatus, engineProviderDef, isEngineProvider, setEngineProvider, ENGINE_PROVIDERS, type EngineAuthRunner, type EngineConnection, type EngineProvider, type EngineProviderStatus } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { readActivity, recordActivity } from "./activity.js";
import { agentRepinModelLedgerSummary, agentRepinProfileBlocker } from "./agent-repins.js";
import { errorReason } from "./telegram.js";

// CLI dressing item 1 (Dip, 2026-11-10; OpenClaw borrow, research doc
// section 6 items 1+2): a guided `sam config` with sections, riding the
// stores SAM already has, plus first-run detect -> verify -> save under
// the banner. Before this, `sam config` had one readout verb, bare
// `sam config` errored, and `sam tui` on an unconfigured install dropped
// the owner into a chat whose first message died on "Model not
// configured".
//
// The wizard's saves ride REAL stores the runtime reads: profile model
// pins (ChatStore.setAgentModel) and the channel registry. SAM holds no
// secrets - only env-var NAMES - so the keys section reports each
// referenced name as present/absent and never takes custody of a value;
// a key is set in the install's environment, then verified here.
// Verify-before-save (the OpenClaw rule): `config setup --live` runs
// ONE real completion through the existing provider and records the
// verified baseline (.sam/setup.db + a ledger line) only on success;
// a failure saves nothing and never auto-selects another route.

export const CONFIG_SECTIONS = ["model", "channels", "keys", "engine"] as const;
export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number];

function normalizeConfigSectionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The section-name gate for the config doors (refusal-class
 *  sweep, 2026-11-26): every other naming door reads its
 *  registry through a ONE source in its owning module before
 *  acting, but the config section name was refused by TWO
 *  doors improvising the identical text independently - the
 *  CLI sections door (printSections in cli.ts) and the wizard
 *  door (runConfigWizard below) each threw "Unknown config
 *  section" from their own inline filter miss, and neither
 *  offered a fold correction, so a folded name ("Model" for
 *  "model") dead-ended with nothing beyond the list.
 *  configSectionBlocker is now the ONE source carrying the
 *  refusal text (sections listed, fold correction when
 *  exactly one matches); both doors throw it before showing
 *  or running anything. The wizard's interactive pick loop
 *  stays as is - it re-prompts rather than refusing, a
 *  different shape by design. configSections and detectSetup
 *  stay permissive by design - only the doors' refusal
 *  shape changes. */
export function configSectionBlocker(section: string): string | null {
  if ((CONFIG_SECTIONS as readonly string[]).includes(section)) return null;
  const target = normalizeConfigSectionName(section ?? "");
  const matches = target ? CONFIG_SECTIONS.filter(s => normalizeConfigSectionName(s) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown config section \"" + section + "\". Sections: " + CONFIG_SECTIONS.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

export interface KeyState { name: string; purpose: string; state: "present" | "absent" }
export interface SetupDetection {
  firstRun: boolean;
  modelReady: boolean;
  provider: string;
  endpoint: string | null;
  model: string | null;
  cheapModel: string | null;
  deepModel: string | null;
  apiKey: "present" | "absent";
  profiles: Array<{ name: string; model: string | null; connector: string | null }>;
  channels: Array<{ name: string; kind: string; profile: string; tokenEnv: string; credential: "present" | "absent"; owners: number; enabled: boolean }>;
  connectors: Array<{ name: string; enabled: boolean; credential: "present" | "absent" }>;
  keys: KeyState[];
  engine: { provider: EngineProvider; installed: boolean; binary: string | null; connected: boolean; stale: boolean; connection: EngineConnection | null; providers: EngineProviderStatus[] };
  senses: { installed: boolean; binary: string | null };
  nextSteps: string[];
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

// The model endpoint the live turn would use, resolved exactly as
// agent-turn resolves it (SAM_MODEL_ENDPOINT, else the minimax
// default when the provider names minimax). Host only in output -
// the URL is configuration, not a secret, and config show already
// prints the base URL.
export function modelEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const providerName = env.SAM_MODEL_PROVIDER ?? "";
  return clean(env.SAM_MODEL_ENDPOINT) ?? (providerName === "minimax" ? "https://api.minimax.io/v1/chat/completions" : null);
}

export function modelApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return clean(env.SAM_MODEL_API_KEY) ?? (env.SAM_MODEL_PROVIDER === "minimax" ? clean(env.MINIMAX_API_KEY) : null) ?? null;
}

export function detectSetup(root: string, env: NodeJS.ProcessEnv = process.env): SetupDetection {
  const cfg = parseSamConfig(env);
  const ready = configReadiness(cfg);
  const model = modelRoutingTable(env).find(r => r.route === "chat")?.model ?? null;
  const profiles: SetupDetection["profiles"] = [{ name: "sam", model: null, connector: null }];
  try {
    const db = new ChatStore(root);
    try {
      for (const a of db.agents()) profiles.push({ name: a.name, model: a.model ?? null, connector: a.connector_id ?? null });
    } finally { db.close(); }
  } catch { /* a workspace whose chat store cannot open yet reads as core-only */ }
  const chans = channels(root);
  const conns = connectors(root);
  const keys: KeyState[] = [];
  const seen = new Set<string>();
  const key = (name: string, purpose: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    keys.push({ name, purpose, state: clean(env[name]) ? "present" : "absent" });
  };
  key("SAM_MODEL_API_KEY", "model API key (generic)");
  if (cfg.modelProvider === "minimax") key("MINIMAX_API_KEY", "model API key (MiniMax)");
  key("SAM_MODEL_ENDPOINT", "model endpoint override");
  for (const c of chans) key(c.tokenEnv, "channel credential: " + c.name);
  for (const c of conns) key(c.tokenEnv, "connector credential: " + c.name);
  const engineStatus0 = engineConnectStatus(root, env);
  const engineBin = engineStatus0.binary;
  const senses = sensesStatus(env);
  // First-run means the live turn cannot run at all - judged by the
  // turn's own requirements (a resolved model, an endpoint, and a key
  // in env), NOT by configReadiness, which only counts the minimax
  // provider shape and would strand a working endpoint-based install.
  const turnReady = !!model && !!modelEndpoint(env) && !!modelApiKey(env);
  const nextSteps: string[] = [];
  if (!model) nextSteps.push("Set SAM_MODEL in the environment (the model every route tier falls back to).");
  if (!modelApiKey(env)) nextSteps.push("Set the model API key in the environment (SAM_MODEL_API_KEY, or MINIMAX_API_KEY for the minimax provider) - SAM never stores key values, only their names.");
  if (!modelEndpoint(env)) nextSteps.push("Set SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT so SAM knows where the model lives.");
  if (model && modelApiKey(env) && modelEndpoint(env)) nextSteps.push("Run `sam config setup --live` to verify the model with one real completion and record the verified setup.");
  if (!engineBin) nextSteps.push("Optional: install " + engineProviderDef(engineStatus0.provider).label + " on this machine to enable the managed coding engine (an operator install; SAM only detects it). The engine provider is a config choice: `sam engine provider claude-code|codex`.");
  else if (!engineStatus0.connected) nextSteps.push("Optional: connect " + engineProviderDef(engineStatus0.provider).label + " as the coding-engine route with `sam engine connect` (CLI reuse - SAM verifies the CLI's own login and stores only a route marker, never its tokens). If it is not signed in, `sam engine login` runs the provider's own login in your terminal.");
  if (!senses.installed) nextSteps.push("Optional: install and authorize the senses reader (gog) to give the core profile its Gmail and Calendar senses.");
  return {
    firstRun: !turnReady,
    modelReady: ready.modelReady,
    provider: cfg.modelProvider,
    endpoint: modelEndpoint(env),
    model,
    cheapModel: cfg.cheapModel,
    deepModel: cfg.deepModel,
    apiKey: modelApiKey(env) ? "present" : "absent",
    profiles,
    channels: chans.map(c => ({ name: c.name, kind: c.kind, profile: c.profile, tokenEnv: c.tokenEnv, credential: clean(env[c.tokenEnv]) ? "present" as const : "absent" as const, owners: c.ownerIds.length, enabled: c.enabled })),
    connectors: conns.map(c => ({ name: c.name, enabled: c.enabled, credential: (c.vaultKey ? connectorCredentialPresent(root, c) : !!clean(env[c.tokenEnv])) ? "present" as const : "absent" as const })),
    keys,
    engine: (() => { const c = engineStatus0; return { provider: c.provider, installed: c.installed, binary: c.binary, connected: c.connected, stale: c.stale, connection: c.connection, providers: c.providers }; })(),
    senses: { installed: senses.installed, binary: senses.binary },
    nextSteps,
  };
}

export interface ConfigSection { id: ConfigSectionId; title: string; state: "ready" | "missing" | "info"; lines: string[] }

export function configSections(root: string, env: NodeJS.ProcessEnv = process.env): ConfigSection[] {
  const d = detectSetup(root, env);
  const modelLines = [
    "provider: " + d.provider + (d.endpoint ? " · endpoint " + d.endpoint : " · no endpoint resolved"),
    "chat model: " + (d.model ?? "(not set)") + " · cheap: " + (d.cheapModel ?? d.model ?? "(not set)") + " · deep: " + (d.deepModel ?? d.model ?? "(not set)"),
    "api key: " + d.apiKey,
    ...d.profiles.map(p => "profile " + p.name + ": model pin " + (p.model ?? "(route tier decides)") + (p.name === "sam" ? " - the core profile's model is the SAM_MODEL environment value" : "")),
  ];
  const channelLines = d.channels.length
    ? d.channels.map(c => c.name + " (" + c.kind + ") -> profile " + c.profile + " · credential " + c.credential + " · owners " + c.owners + (c.enabled ? "" : " · disabled"))
    : ["no channels yet - add one in this section or with `sam channels add`"];
  const keyLines = d.keys.map(k => k.name + ": " + k.state + " (" + k.purpose + ")");
  keyLines.push("SAM stores only env-var names, never key values; set a missing key in the install's environment, then re-run verify.");
  const engineLines = [
    "engine provider (config choice): " + engineProviderDef(d.engine.provider).label + " - switch with `sam engine provider claude-code|codex` or in this section",
    ...d.engine.providers.map(p => "provider " + p.label + ": " + (p.installed ? "installed (" + p.binary + ")" : "not installed - installing it is the operator's act") + (p.connected ? " · connected" : "")),
    "engine connection (CLI reuse): " + (d.engine.connected
      ? "connected" + (d.engine.connection ? " since " + d.engine.connection.connectedAt + (d.engine.connection.authMethod ? " via " + d.engine.connection.authMethod : "") : "") + " - SAM stores only a route marker, never the CLI's tokens"
      : d.engine.stale
        ? "a connection is recorded but it no longer matches the selected provider or its binary - re-run `sam engine connect` to re-verify it"
        : d.engine.installed
          ? "not connected - run `sam engine connect` (or this section) to verify the CLI's login and record the route; if it is not signed in, `sam engine login` runs the provider's own login in your terminal"
          : "not connected - the selected provider is not installed yet"),
    "senses reader (gog): " + (d.senses.installed ? "installed (" + d.senses.binary + ")" : "not installed - the core profile's Gmail/Calendar senses stay dark until it is installed and authorized"),
  ];
  return [
    { id: "model", title: "Model", state: d.modelReady ? "ready" : "missing", lines: modelLines },
    { id: "channels", title: "Channels", state: d.channels.length ? "ready" : "info", lines: channelLines },
    { id: "keys", title: "Keys", state: d.keys.some(k => k.state === "absent") ? "missing" : "ready", lines: keyLines },
    { id: "engine", title: "Engine & senses", state: d.engine.installed ? "ready" : "info", lines: engineLines },
  ];
}

// --- verify: one real completion through the existing provider -------

export type Completer = (model: string) => Promise<string>;

export function defaultCompleter(env: NodeJS.ProcessEnv = process.env): Completer | null {
  const endpoint = modelEndpoint(env);
  const key = modelApiKey(env);
  const model = modelRoutingTable(env).find(r => r.route === "chat")?.model ?? null;
  if (!endpoint || !key || !model) return null;
  const provider = new OpenAICompatibleProvider(endpoint, key, 30_000);
  return async (m: string) => {
    const res = await provider.complete({ model: m, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    return res.message.content;
  };
}

export interface VerifyResult { ok: boolean; model: string | null; reason: string; reply?: string }

export async function verifyModel(env: NodeJS.ProcessEnv = process.env, complete?: Completer): Promise<VerifyResult> {
  const model = modelRoutingTable(env).find(r => r.route === "chat")?.model ?? null;
  if (!model) return { ok: false, model: null, reason: "No model configured: set SAM_MODEL in the environment first." };
  if (!modelEndpoint(env)) return { ok: false, model, reason: "No model endpoint resolved: set SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT." };
  if (!modelApiKey(env)) return { ok: false, model, reason: "No model API key in the environment (SAM_MODEL_API_KEY, or MINIMAX_API_KEY for minimax)." };
  const run = complete ?? defaultCompleter(env);
  if (!run) return { ok: false, model, reason: "Model connection could not be constructed from the environment." };
  try {
    const reply = (await run(model)).trim();
    if (!reply) return { ok: false, model, reason: "The model answered with an empty completion; nothing was saved." };
    return { ok: true, model, reason: "Verified with one real completion.", reply: reply.slice(0, 120) };
  } catch (err) {
    // The failure reason rides errorReason (the 2026-11-16 04:04
    // bridge seam, cured at the delivery seam at 05:04 and the
    // probe verdict at 06:04): Node's fetch wraps every transport
    // failure in the same "fetch failed" with the real reason on
    // error.cause, so err.message alone reported "Verification
    // failed: fetch failed" for a DNS failure, a refused
    // connection, and a TLS failure alike - the first-run setup
    // and `config verify --live` named nothing at the moment the
    // owner most needs to know what to fix. errorReason walks
    // the cause chain (bounded, deduped), appends errno codes,
    // redacts bot-token segments, and collapses whitespace;
    // causeless errors compose to exactly their message, so
    // they read as before. Verify-before-save is untouched: a
    // failure still saves nothing.
    return { ok: false, model, reason: "Verification failed: " + errorReason(err) };
  }
}

// --- save: the verified baseline record --------------------------------

export interface SetupRecord { model: string; provider: string; endpoint: string | null; verifiedAt: string; reply: string }

function setupPath(root: string) { return join(resolve(root), ".sam", "setup.json"); }
function setupDbPath(root: string) { return join(resolve(root), ".sam", "setup.db"); }

// State convergence (UNIFICATION item 4, twenty-ninth store):
// the verified setup baseline is SQLite (.sam/setup.db, the
// approval-policy / auth-probes singleton pattern), ONE row
// holding the record's full JSON so the singleton keeps its
// exact shape. The old setup.json was rewritten whole by
// verifyAndSaveSetup on every successful setup run - a plain
// writeFileSync - while readSetupRecord readers run in every
// process that builds a status surface (the dashboard status
// path, the CLI overview and config views, auth status). A
// torn write read back as no baseline at all, so a verified
// install silently read as never-verified. Here each save is
// a single-row UPSERT and connections carry a busy_timeout,
// so no reader in any process can ever see a torn baseline.
// First open imports a legacy setup.json (validated through
// the old read shape: a string model plus a string
// verifiedAt) and renames it setup.json.migrated - imported,
// never deleted; a malformed file or a payload failing that
// shape imports nothing and is left in place (the migrated
// shape reads it as no baseline, exactly the old forgiving
// contract). A pure read on an install with neither file
// creates nothing, and a failed verification still saves
// nothing - verify-before-save is untouched. The P9 backup
// snapshots every .sam/*.db generically, so the migrated
// store is carried with no backup change.
function parseSetupRecord(data: unknown): SetupRecord | null {
  const value = data as SetupRecord | null;
  return typeof value?.model === "string" && typeof value?.verifiedAt === "string" ? value : null;
}

// Setup store failure visibility (hourly run 2026-11-15
// 15:04 EST): this store is the verified setup baseline -
// the one row recording that this install's model route was
// proven with a real completion - and every touch was
// unguarded. readSetupRecord rides auth status (whose
// setupVerified header is built from it), the dashboard
// status payload and CLI overview (status.ts reads it
// unguarded), and the CLI config views; saveSetupRecord
// rides verifyAndSaveSetup, where a dead store after a
// SUCCESSFUL verification would kill the setup flow with an
// unnamed throw and no record the verification ever passed.
// Now the store owns its touches (the telegram-state
// precedent, helpers here because this module already
// imports the ledger and is its own leaf for this seam): a
// failed open/read/write ledgers ONE setup-store-failed
// line (phase read for the read door, phase write for the
// write door; actor sam; the verbatim reason collapsed and
// capped; never any record content - the recorded endpoint
// and the verification reply are the install's data) and
// rethrows exactly, tagged so a catching caller records
// nothing more for the same touch. The exists check stays
// outside the seam: an absent store still reads as no
// baseline with no line and creates nothing, and a torn row
// payload still parses forgiving to null - only the store
// touch is guarded. Verify-before-save is untouched: a
// failed verification still saves nothing.
export type SetupStorePhase = "read" | "write";

export function setupStoreFailureSummary(phase: SetupStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Setup store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a setup-store-failed line carries (census sprint
 * 2026-11-17): recordSetupStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function setupStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordSetupStoreFailure(root: string, phase: SetupStorePhase, error: unknown): void {
  const reason = setupStoreFailureReason(error);
  recordActivity(root, "sam", "setup-store-failed", setupStoreFailureSummary(phase, reason));
}

function tagSetupStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { setupStoreLedgered?: boolean }).setupStoreLedgered = true;
  }
}

export function isSetupStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { setupStoreLedgered?: boolean }).setupStoreLedgered === true;
}

function failSetupStore(root: string, phase: SetupStorePhase, error: unknown): never {
  if (!isSetupStoreLedgered(error)) recordSetupStoreFailure(root, phase, error);
  tagSetupStoreLedgered(error);
  throw error;
}

function openSetupStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(setupDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS setup_record (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacySetup(db, root);
  return db;
}
function migrateLegacySetup(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM setup_record WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = setupPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseSetupRecord(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO setup_record (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function setupStoreExists(root: string): boolean {
  return existsSync(setupDbPath(root)) || existsSync(setupPath(root));
}
function saveSetupRecord(root: string, record: SetupRecord): void {
  let db: Database.Database;
  try { db = openSetupStore(root); } catch (error) { failSetupStore(root, "write", error); }
  try {
    db!.prepare("INSERT INTO setup_record (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(record));
  } catch (error) { failSetupStore(root, "write", error); }
  finally { db!.close(); }
}

// The store's read door: the verified baseline through the
// store's own shape, or null when no setup has ever been
// verified - and a read on an install with no store at all
// creates nothing.
export function readSetupRecord(root: string): SetupRecord | null {
  if (!setupStoreExists(root)) return null;
  let db: Database.Database;
  try { db = openSetupStore(root); } catch (error) { failSetupStore(root, "read", error); }
  try {
    const row = db!.prepare("SELECT data FROM setup_record WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseSetupRecord(JSON.parse(row.data)); } catch { return null; }
  } catch (error) { failSetupStore(root, "read", error); }
  finally { db!.close(); }
}

export async function verifyAndSaveSetup(root: string, env: NodeJS.ProcessEnv = process.env, complete?: Completer): Promise<{ verify: VerifyResult; saved: SetupRecord | null }> {
  const verify = await verifyModel(env, complete);
  if (!verify.ok || !verify.model) return { verify, saved: null };
  const record: SetupRecord = {
    model: verify.model,
    provider: parseSamConfig(env).modelProvider,
    endpoint: modelEndpoint(env),
    verifiedAt: new Date().toISOString(),
    reply: verify.reply ?? "",
  };
  saveSetupRecord(root, record);
  recordActivity(root, "owner", "setup-verified", setupVerifiedLedgerSummary(record.model, record.provider));
  return { verify, saved: record };
}

// The setup verification's ledger shape has ONE writer here
// (the measured-proof series, 2026-11-21): the verified line
// lived as inline concatenation at the verifyAndSaveSetup
// seam, and any drift was invisible. The shape is
// byte-identical to what that seam wrote inline before this
// writer existed.
export function setupVerifiedLedgerSummary(model: string, provider: string): string {
  return "Model setup verified: " + model + " via " + provider + " (one real completion; recorded in the setup store)";
}

// Setup history fold (2026-11-21): the setup store is a
// singleton - every successful verification overwrites the
// one baseline row - so the ledger is the only place the
// history of verifications survives. This family has no
// failure class of its own (setup-store-failed rides the
// store-failure fold), so the verdict is attention only
// when a line is unparseable.
export const SETUP_PROVIDERS = ["minimax", "none"] as const;

export function parseSetupVerifiedSummary(summary: string): { model: string; provider: string } | null {
  const m = /^Model setup verified: (\S+) via (\S+) \(one real completion; recorded in the setup store\)$/.exec(summary);
  if (!m) return null;
  if (!(SETUP_PROVIDERS as readonly string[]).includes(m[2])) return null;
  return { model: m[1], provider: m[2] };
}

export function setupHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "setup-verified" });
  let verified = 0;
  let unparseable = 0;
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();
  for (const line of lines) {
    const parsed = parseSetupVerifiedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    verified += 1;
    modelSet.add(parsed.model);
    providerSet.add(parsed.provider);
  }
  const parts: string[] = [];
  parts.push("Setup history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(verified) + " verified");
  parts.push(String(modelSet.size) + " distinct models");
  parts.push(String(providerSet.size) + " distinct providers");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

// The ONE writer for the config-wizard activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. Its shape is byte-identical to what the wizard's
// channels section wrote inline before this writer existed:
// "Channel added via config wizard: <name> -> <profile>",
// where the name passed the channel registry's own name
// validation in addChannel and the profile its profile
// validation - a refused add writes nothing.
export function configWizardChannelLedgerSummary(name: string, profile: string): string {
  return "Channel added via config wizard: " + name + " -> " + profile;
}

// The config wizard history scorecard (2026-11-24, the
// measured-proof series): the wizard ledgers exactly one
// act - a channel added through the guided flow - as a
// "config-wizard" line, and the config-acts fold covers the
// other seven configuration kinds but not this one, so how
// often the guided first-run door has ever completed its
// one save was invisible in aggregate. The channel registry
// witnesses that a channel exists, not that it arrived
// through the wizard, nor how many distinct channels or
// profiles that door has bound. Adding a channel through
// the wizard is the operator working as designed, so the
// verdict is attention only when a line is unparseable (the
// config-acts rule), else clear. The parser validates the
// fixed shape exactly: the channel name against the
// registry's own name alphabet (consumed, counted as a
// distinct number only, never printed) and the profile
// against the registry's profile alphabet (likewise);
// cross-kind lines never parse. This text folds the kind
// to counts only, on ONE line: the added count, the
// distinct-channel and distinct-profile counts as numbers
// only, and the total - and it names its scope honestly:
// it counts wizard channel adds only, never all channel
// adds (CLI channel adds ledger nothing). No stamp, no
// actor, no channel name, no profile name, and no verbatim
// summary enters the text. A pure read: it creates nothing,
// spends no model call, and adds, configures, and verifies
// nothing - the wizard seam itself is untouched beyond
// naming its writer.
export function parseConfigWizardSummary(summary: string): { channel: string; profile: string } | null {
  const m = /^Channel added via config wizard: (.+) -> ([a-z][a-z0-9._-]*)$/.exec(summary);
  if (!m) return null;
  if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(m[1] as string)) return null;
  return { channel: m[1] as string, profile: m[2] as string };
}
export function configWizardHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "config-wizard" });
  let added = 0;
  let unparseable = 0;
  const channelSet = new Set<string>();
  const profileSet = new Set<string>();
  for (const line of lines) {
    const parsed = parseConfigWizardSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    added += 1;
    channelSet.add(parsed.channel);
    profileSet.add(parsed.profile);
  }
  const parts: string[] = [];
  parts.push("Config wizard history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(added) + " added");
  parts.push(String(channelSet.size) + " distinct channels");
  parts.push(String(profileSet.size) + " distinct profiles");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

// --- the interactive wizard ---------------------------------------------

export interface WizardIo {
  print(line: string): void;
  ask(question: string): Promise<string>;
}

// The wizard runner, with injectable IO so the whole flow is testable
// without a terminal. Saves ride the real stores; a refusal from a
// store is shown with its reason and the wizard continues.
export async function runConfigWizard(root: string, io: WizardIo, opts: { section?: string; env?: NodeJS.ProcessEnv; engineAuthRunner?: EngineAuthRunner } = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const sections = configSections(root, env);
  const wanted = opts.section ? sections.filter(s => s.id === opts.section) : sections;
  if (opts.section && !wanted.length) throw new Error(configSectionBlocker(opts.section)!);
  const show = (s: ConfigSection) => {
    io.print("");
    io.print("== " + s.title + " (" + s.state + ") ==");
    for (const line of s.lines) io.print("  " + line);
  };
  if (opts.section) {
    const s = wanted[0];
    show(s);
    await wizardSection(root, io, s.id, env, opts.engineAuthRunner);
    return;
  }
  for (const s of sections) show(s);
  for (;;) {
    const pick = (await io.ask("\nSection to change [model/channels/keys/engine, or Enter to finish]: ")).trim().toLowerCase();
    if (!pick) return;
    if (!CONFIG_SECTIONS.includes(pick as ConfigSectionId)) { io.print("Sections: " + CONFIG_SECTIONS.join(", ")); continue; }
    const fresh = configSections(root, env).find(s => s.id === pick)!;
    show(fresh);
    await wizardSection(root, io, pick as ConfigSectionId, env, opts.engineAuthRunner);
  }
}

async function wizardSection(root: string, io: WizardIo, id: ConfigSectionId, env: NodeJS.ProcessEnv, engineAuthRunner?: EngineAuthRunner): Promise<void> {
  if (id === "model") {
    const d = detectSetup(root, env);
    io.print("The main model comes from SAM_MODEL in the environment; this wizard saves per-profile pins, which the runtime reads on every turn.");
    io.print("Profiles: " + d.profiles.map(p => p.name).join(", "));
    const name = (await io.ask("Profile to re-pin [Enter to skip]: ")).trim();
    if (!name) return;
    // The wizard's model section is a re-pin door (it rides
    // setAgentModel and ledgers an agent-repin line), so its
    // profile refusal reads the registry through the ONE
    // source that owns the re-pin refusal text - before the
    // model is even asked for, so a folded name ("Second
    // Shift" for "second-shift") gets the correction instead
    // of dead-ending after the operator typed a model. "sam"
    // is a valid profile and passes the blocker, then refuses
    // for its own core reason below, exactly as the CLI doors.
    const profileBlocker = agentRepinProfileBlocker(root, name);
    if (profileBlocker) { io.print("Refused: " + profileBlocker); return; }
    if (name === "sam") { io.print("Profile \"sam\" is the core profile and carries no pin row; its model is the SAM_MODEL environment value."); return; }
    const model = (await io.ask("Model for " + name + " ['none' clears the pin]: ")).trim();
    if (!model) return;
    try {
      const db = new ChatStore(root);
      try {
        const updated = db.setAgentModel(name, model === "none" ? null : model);
        if (!updated) { io.print("Refused: " + (agentRepinProfileBlocker(root, name) ?? "Unknown profile \"" + name + "\" in agent re-pin detail.")); return; }
        recordActivity(root, name, "agent-repin", agentRepinModelLedgerSummary(updated.model, true));
        io.print("Saved: " + name + " model pin is now " + (updated.model ?? "(route tier decides)") + ".");
      } finally { db.close(); }
    } catch (err) { io.print("Refused: " + (err instanceof Error ? err.message : String(err))); return; }
    const check = (await io.ask("Verify the model connection with one real completion now? [y/N]: ")).trim().toLowerCase();
    if (check === "y" || check === "yes") {
      const v = await verifyModel(env);
      io.print(v.ok ? "Verified: " + v.model + " answered." : "Not verified: " + v.reason);
    }
    return;
  }
  if (id === "channels") {
    const add = (await io.ask("Add a telegram channel? [y/N]: ")).trim().toLowerCase();
    if (add !== "y" && add !== "yes") return;
    const name = (await io.ask("Channel name: ")).trim();
    const profile = (await io.ask("Profile it talks to: ")).trim();
    const tokenEnv = (await io.ask("Env var NAME holding its token (never the token itself): ")).trim();
    if (!name || !profile || !tokenEnv) { io.print("A channel needs a name, a profile, and a token env name; nothing was added."); return; }
    const profileBlocker = channelProfileBlocker(root, profile);
    if (profileBlocker) { io.print("Refused: " + profileBlocker); return; }
    try {
      const created: Channel = addChannel(root, "telegram", name, profile, tokenEnv);
      recordActivity(root, "owner", "config-wizard", configWizardChannelLedgerSummary(created.name, created.profile));
      io.print("Saved: channel " + created.name + " -> profile " + created.profile + " (credential read from env " + created.tokenEnv + " at runtime).");
    } catch (err) { io.print("Refused: " + (err instanceof Error ? err.message : String(err))); }
    return;
  }
  if (id === "keys") {
    io.print("SAM never stores key values. Set a missing key in this install's environment (export it, or the service env file), then run `sam config verify --live`.");
    return;
  }
  // engine: the senses reader stays detect-and-report (installing and
  // authorizing gog is the operator's act), but the coding engine now
  // has a connect step (CLI dressing item 3): verify the host CLI's
  // login and record the route marker. SAM never takes custody of
  // the login itself.
  let status = engineConnectStatus(root, env);
  // The provider is a config choice, settable here first: the owner's
  // pick rides the same store the CLI's `engine provider` verb uses.
  const pick = (await io.ask("Engine provider [" + ENGINE_PROVIDERS.map(p => p.id).join("/") + ", or Enter to keep " + status.provider + "]: ")).trim().toLowerCase();
  if (pick) {
    if (!isEngineProvider(pick)) { io.print("Refused: \"" + pick + "\" is not an engine provider (valid: " + ENGINE_PROVIDERS.map(p => p.id).join(", ") + "). The selection is unchanged."); return; }
    try { setEngineProvider(root, pick); } catch (err) { io.print("Refused: " + (err instanceof Error ? err.message : String(err))); return; }
    io.print("Saved: " + engineProviderDef(pick).label + " is now the coding-engine provider (a config choice only - nothing was connected or removed).");
    status = engineConnectStatus(root, env);
  }
  const def = engineProviderDef(status.provider);
  if (!status.installed) {
    io.print(def.label + " is not installed on this machine, so there is no engine to connect. Installing it (and signing in with " + def.loginHint + ", or `sam engine login` once it exists) is the operator's act; SAM picks it up automatically once present. The gog senses reader is likewise detected, not configured here.");
    return;
  }
  if (status.connected) {
    io.print(def.label + " is already connected as the coding-engine route (CLI reuse, connected " + (status.connection?.connectedAt ?? "") + "). To re-verify it, run `sam engine connect`; to disconnect SAM's route marker, run `sam engine disconnect` (that never touches the CLI's own login).");
    return;
  }
  const go = (await io.ask("Connect " + def.label + " as the coding-engine route now? This runs `" + def.command + " " + def.authArgv.join(" ") + "` and, only if the CLI reports a signed-in login, records a route marker - SAM never reads or stores the CLI's tokens. [y/N]: ")).trim().toLowerCase();
  if (go !== "y" && go !== "yes") return;
  try {
    const result = engineAuthRunner ? await connectEngine(root, env, engineAuthRunner) : await connectEngine(root, env);
    io.print(result.connected ? "Connected: " + def.label + " is the coding-engine route via CLI reuse (marker recorded; no credentials held by SAM)." : "Not connected: " + result.probe.reason + (result.probe.state === "signed-out" ? " Run `sam engine login` in this terminal to sign in with the provider's own login flow, then connect again." : ""));
  } catch (err) { io.print("Refused: " + (err instanceof Error ? err.message : String(err))); }
}

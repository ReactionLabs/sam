import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { channels, addChannel, type Channel } from "./channels.js";
import { connectors } from "./connectors.js";
import { parseSamConfig, configReadiness } from "./config.js";
import { modelRoutingTable } from "./model-routing.js";
import { engineBinary } from "./engine.js";
import { connectEngine, engineConnectStatus, type EngineAuthRunner, type EngineConnection } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { recordActivity } from "./activity.js";

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
// verified baseline (.sam/setup.json + a ledger line) only on success;
// a failure saves nothing and never auto-selects another route.

export const CONFIG_SECTIONS = ["model", "channels", "keys", "engine"] as const;
export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number];

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
  engine: { installed: boolean; binary: string | null; connected: boolean; stale: boolean; connection: EngineConnection | null };
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
  const engineBin = engineBinary(env);
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
  if (!engineBin) nextSteps.push("Optional: install Claude Code on this machine to enable the managed coding engine (an operator install; SAM only detects it).");
  else if (!engineConnectStatus(root, env).connected) nextSteps.push("Optional: connect Claude Code as the coding-engine route with `sam engine connect` (CLI reuse - SAM verifies the CLI's login and stores only a route marker, never its tokens).");
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
    connectors: conns.map(c => ({ name: c.name, enabled: c.enabled, credential: clean(env[c.tokenEnv]) ? "present" as const : "absent" as const })),
    keys,
    engine: (() => { const c = engineConnectStatus(root, env); return { installed: !!engineBin, binary: engineBin, connected: c.connected, stale: c.stale, connection: c.connection }; })(),
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
    "coding engine (Claude Code): " + (d.engine.installed ? "installed (" + d.engine.binary + ")" : "not installed - installing it is the operator's act"),
    "engine connection (CLI reuse): " + (d.engine.connected
      ? "connected" + (d.engine.connection ? " since " + d.engine.connection.connectedAt + (d.engine.connection.authMethod ? " via " + d.engine.connection.authMethod : "") : "") + " - SAM stores only a route marker, never the CLI's tokens"
      : d.engine.stale
        ? "a connection is recorded but its binary is no longer the one detected - re-run `sam engine connect` to re-verify it"
        : d.engine.installed
          ? "not connected - run `sam engine connect` (or this section) to verify the CLI's login and record the route"
          : "not connected - no engine to connect yet"),
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
    return { ok: false, model, reason: "Verification failed: " + (err instanceof Error ? err.message : String(err)) };
  }
}

// --- save: the verified baseline record --------------------------------

export interface SetupRecord { model: string; provider: string; endpoint: string | null; verifiedAt: string; reply: string }

function setupPath(root: string) { return join(resolve(root), ".sam", "setup.json"); }

export function readSetupRecord(root: string): SetupRecord | null {
  const file = setupPath(root);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as SetupRecord;
    return typeof value?.model === "string" && typeof value?.verifiedAt === "string" ? value : null;
  } catch { return null; }
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
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(setupPath(root), JSON.stringify(record, null, 2), { mode: 0o600 });
  recordActivity(root, "owner", "setup-verified", "Model setup verified: " + record.model + " via " + record.provider + " (one real completion; recorded in setup.json)");
  return { verify, saved: record };
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
  if (opts.section && !wanted.length) throw new Error("Unknown config section \"" + opts.section + "\". Sections: " + CONFIG_SECTIONS.join(", "));
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
    if (name === "sam") { io.print("Profile \"sam\" is the core profile and carries no pin row; its model is the SAM_MODEL environment value."); return; }
    const model = (await io.ask("Model for " + name + " ['none' clears the pin]: ")).trim();
    if (!model) return;
    try {
      const db = new ChatStore(root);
      try {
        const updated = db.setAgentModel(name, model === "none" ? null : model);
        if (!updated) { io.print("Unknown profile \"" + name + "\". Known profiles: " + d.profiles.map(p => p.name).join(", ")); return; }
        recordActivity(root, name, "agent-repin", "Model pin " + (updated.model ? "set to " + updated.model : "cleared (route tier decides)") + " via config wizard");
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
    try {
      const created: Channel = addChannel(root, "telegram", name, profile, tokenEnv);
      recordActivity(root, "owner", "config-wizard", "Channel added via config wizard: " + created.name + " -> " + created.profile);
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
  const status = engineConnectStatus(root, env);
  if (!status.installed) {
    io.print("Claude Code is not installed on this machine, so there is no engine to connect. Installing it (and signing in with `claude auth login`) is the operator's act; SAM picks it up automatically once present. The gog senses reader is likewise detected, not configured here.");
    return;
  }
  if (status.connected) {
    io.print("Claude Code is already connected as the coding-engine route (CLI reuse, connected " + (status.connection?.connectedAt ?? "") + "). To re-verify it, run `sam engine connect`; to disconnect SAM's route marker, run `sam engine disconnect` (that never touches the CLI's own login).");
    return;
  }
  const go = (await io.ask("Connect Claude Code as the coding-engine route now? This runs `claude auth status` and, only if the CLI reports a signed-in login, records a route marker - SAM never reads or stores the CLI's tokens. [y/N]: ")).trim().toLowerCase();
  if (go !== "y" && go !== "yes") return;
  try {
    const result = engineAuthRunner ? await connectEngine(root, env, engineAuthRunner) : await connectEngine(root, env);
    io.print(result.connected ? "Connected: Claude Code is the coding-engine route via CLI reuse (marker recorded; no credentials held by SAM)." : "Not connected: " + result.probe.reason);
  } catch (err) { io.print("Refused: " + (err instanceof Error ? err.message : String(err))); }
}

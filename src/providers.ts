import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelEndpoint, modelApiKey } from "./config-wizard.js";
import { resolveModelForRoute, tierForRoute, type ModelSource, type ModelTier } from "./model-routing.js";
import type { TurnRoute } from "./budgets.js";

// Multi-provider (sprint item 1). SAM used to run one provider: the
// env triple SAM_MODEL_PROVIDER / SAM_MODEL_ENDPOINT / SAM_MODEL_API_KEY
// (or MINIMAX_API_KEY). That env provider still exists and is still
// the default for every unpinned profile. Additional providers live
// in .sam/providers.json as endpoint + key ENV NAME + model. The file
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

interface FileProvider {
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
  const file = providersPath(root);
  if (!existsSync(file)) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Invalid providers file: " + file); }
  if (!Array.isArray(value)) throw new Error("Invalid providers file: " + file);
  return value.map(row => {
    if (!row || typeof row !== "object") throw new Error("Invalid providers file: " + file);
    const r = row as Partial<FileProvider>;
    if (typeof r.id !== "string" || typeof r.endpoint !== "string" || typeof r.keyEnv !== "string" || typeof r.model !== "string")
      throw new Error("Invalid providers file: " + file);
    return {
      id: r.id,
      endpoint: r.endpoint,
      keyEnv: r.keyEnv,
      model: r.model,
      cheapModel: typeof r.cheapModel === "string" ? r.cheapModel : null,
      deepModel: typeof r.deepModel === "string" ? r.deepModel : null,
    };
  });
}

function writeFileProviders(root: string, items: FileProvider[]): void {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true });
  const file = providersPath(root);
  writeFileSync(file, JSON.stringify(items, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
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
  const items = readFileProviders(root);
  if (items.some(p => p.id === id)) throw new Error("Provider already exists: " + id);
  if (items.length >= MAX_PROVIDERS) throw new Error("Provider limit reached (" + MAX_PROVIDERS + ")");
  const row: FileProvider = { id, endpoint, keyEnv, model, cheapModel, deepModel };
  writeFileProviders(root, [...items, row]);
  return toPublic(env, row);
}

export function removeProvider(root: string, id: string): boolean {
  if ((RESERVED_PROVIDER_IDS as readonly string[]).includes(id)) throw new Error("The environment provider is not stored in the providers file");
  const items = readFileProviders(root);
  const next = items.filter(p => p.id !== id);
  if (next.length === items.length) return false;
  writeFileProviders(root, next);
  return true;
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

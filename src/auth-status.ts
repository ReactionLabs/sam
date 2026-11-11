import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { modelRoutingTable, type ModelSource, type ModelTier } from "./model-routing.js";
import { parseSamConfig } from "./config.js";
import { modelEndpoint, modelApiKey, readSetupRecord, defaultCompleter, type Completer } from "./config-wizard.js";
import { engineBinary } from "./engine.js";
import { engineConnectStatus, type EngineConnection } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { recordActivity } from "./activity.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { listProviders, modelKeyEnvName, readProviderKey, resolveTurnConnection, type ConfiguredProvider } from "./providers.js";

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
// (.sam/auth-probes.json) so plain status reads the last verdict
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
  engine: { route: "cli-reuse"; installed: boolean; binary: string | null; connected: boolean; stale: boolean; connection: EngineConnection | null };
  senses: { installed: boolean; binary: string | null };
  lastProbeAt: string | null;
  healthy: boolean;
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

export function readProbeStore(root: string): ProbeStore | null {
  const file = probePath(root);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ProbeStore;
    return typeof value?.at === "string" && Array.isArray(value?.results) ? value : null;
  } catch { return null; }
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
    engine: (() => { const c = engineConnectStatus(root, env); return { route: "cli-reuse" as const, installed: !!engineBinary(env), binary: engineBinary(env), connected: c.connected, stale: c.stale, connection: c.connection }; })(),
    senses: sensesStatus(env),
    lastProbeAt: store?.at ?? null,
    healthy: authCheckOk({ routes: routeRows }),
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

// Bucket a probe failure the way OpenClaw's models status --probe
// does: the owner (and a script) needs the KIND of failure, not a
// raw stack. Order matters: a 429 that mentions quota is a rate
// limit; a 402 / insufficient-balance is billing.
export function classifyProbeError(err: unknown): { bucket: ProbeBucket; reason: string } {
  const message = err instanceof Error ? err.message : String(err);
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
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(probePath(root), JSON.stringify({ at, results }, null, 2), { mode: 0o600 });
  const bad = results.filter(r => r.bucket !== "ok");
  recordActivity(root, "owner", "auth-probe", "Auth probe: " + (results.length - bad.length) + "/" + results.length + " targets ok (" + calls + " model call(s))" + (bad.length ? "; not ok: " + bad.map(r => r.target + "=" + r.bucket).join(", ") : ""));
  return { at, results, ok: bad.length === 0, calls };
}

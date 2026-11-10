import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { modelRoutingTable, resolveModelForRoute, type ModelSource, type ModelTier } from "./model-routing.js";
import { parseSamConfig } from "./config.js";
import { modelEndpoint, modelApiKey, readSetupRecord, defaultCompleter, type Completer } from "./config-wizard.js";
import { engineBinary } from "./engine.js";
import { sensesStatus } from "./senses.js";
import { recordActivity } from "./activity.js";

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
  kind: "route" | "profile";
  model: string | null;
  bucket: ProbeBucket;
  reason: string;
  at: string;
  latencyMs: number | null;
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
  engine: { route: "cli-reuse"; installed: boolean; binary: string | null };
  senses: { installed: boolean; binary: string | null };
  lastProbeAt: string | null;
  healthy: boolean;
}

// The env NAME that carries the model key for this install - the
// generic name when it is the one in play, else the provider's own
// (modelApiKey's resolution order, mirrored so the name we print is
// the name whose value the turn would actually spend).
export function modelKeyEnvName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SAM_MODEL_API_KEY?.trim()) return "SAM_MODEL_API_KEY";
  if (env.SAM_MODEL_PROVIDER === "minimax") return "MINIMAX_API_KEY";
  return "SAM_MODEL_API_KEY";
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
  const chatModel = routes.find(r => r.route === "chat")?.model ?? null;
  const profiles: Array<Omit<AuthTarget, "lastProbe">> = [
    { target: "profile:sam", kind: "profile", route: null, profile: "sam", tier: "main", source: "main-env", model: chatModel, ...base },
  ];
  try {
    const db = new ChatStore(root);
    try {
      for (const a of db.agents()) {
        const r = resolveModelForRoute({ route: "chat", profileModel: a.model ?? null, env });
        profiles.push({ target: "profile:" + a.name, kind: "profile", route: null, profile: a.name, tier: r.tier, source: r.source, model: r.model, ...base });
      }
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
    engine: { route: "cli-reuse", installed: !!engineBinary(env), binary: engineBinary(env) },
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
export async function probeAuth(root: string, env: NodeJS.ProcessEnv = process.env, complete?: Completer): Promise<ProbeRun> {
  const { routes, profiles } = targets(root, env);
  const all = [...routes, ...profiles];
  const at = new Date().toISOString();
  const run = complete ?? defaultCompleter(env);
  const endpoint = modelEndpoint(env);
  const key = modelApiKey(env);
  const verdicts = new Map<string, { bucket: ProbeBucket; reason: string; latencyMs: number | null }>();
  let calls = 0;
  for (const model of [...new Set(all.map(t => t.model).filter((m): m is string => !!m))]) {
    if (!endpoint) { verdicts.set(model, { bucket: "missing", reason: "No model endpoint resolved: set SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT.", latencyMs: null }); continue; }
    if (!key) { verdicts.set(model, { bucket: "auth", reason: "No model API key in the environment (" + modelKeyEnvName(env) + ").", latencyMs: null }); continue; }
    if (!run) { verdicts.set(model, { bucket: "error", reason: "Model connection could not be constructed from the environment.", latencyMs: null }); continue; }
    calls++;
    const started = Date.now();
    try {
      const reply = (await run(model)).trim();
      verdicts.set(model, reply
        ? { bucket: "ok", reason: "Verified with one real completion.", latencyMs: Date.now() - started }
        : { bucket: "empty", reason: "The model answered with an empty completion.", latencyMs: Date.now() - started });
    } catch (err) {
      const { bucket, reason } = classifyProbeError(err);
      verdicts.set(model, { bucket, reason, latencyMs: Date.now() - started });
    }
  }
  const results: ProbeRecord[] = all.map(t => {
    if (!t.model) return { target: t.target, kind: t.kind, model: null, bucket: "missing" as const, reason: "No model resolved for this target: set SAM_MODEL or a profile pin.", at, latencyMs: null };
    const v = verdicts.get(t.model)!;
    return { target: t.target, kind: t.kind, model: t.model, bucket: v.bucket, reason: v.reason, at, latencyMs: v.latencyMs };
  });
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(probePath(root), JSON.stringify({ at, results }, null, 2), { mode: 0o600 });
  const bad = results.filter(r => r.bucket !== "ok");
  recordActivity(root, "owner", "auth-probe", "Auth probe: " + (results.length - bad.length) + "/" + results.length + " targets ok (" + calls + " model call(s))" + (bad.length ? "; not ok: " + bad.map(r => r.target + "=" + r.bucket).join(", ") : ""));
  return { at, results, ok: bad.length === 0, calls };
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";
import { listProviders, resolveTurnConnection, type TurnConnection } from "./providers.js";

// Model failover (sprint item 2). A profile's primary route is its
// provider+model pin (or the environment provider when it has none).
// Ordered fallbacks live in .sam/fallbacks.json as provider id + model,
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

function readAll(root: string): Record<string, FallbackRoute[]> {
  const file = pathFor(root);
  if (!existsSync(file)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Invalid fallbacks file"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fallbacks file");
  const out: Record<string, FallbackRoute[]> = {};
  for (const [profile, rows] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw new Error("Invalid fallbacks file");
    out[profile] = rows.map(row => {
      if (!row || typeof row !== "object") throw new Error("Invalid fallbacks file");
      const r = row as Partial<FallbackRoute>;
      if (typeof r.provider !== "string" || typeof r.model !== "string") throw new Error("Invalid fallbacks file");
      return { provider: r.provider, model: r.model };
    });
  }
  return out;
}

function writeAll(root: string, data: Record<string, FallbackRoute[]>): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const file = pathFor(root);
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function fallbackRoutes(root: string, profile: string): FallbackRoute[] {
  return readAll(root)[profile] ?? [];
}

export function addFallbackRoute(root: string, profile: string, route: FallbackRoute, env: NodeJS.ProcessEnv = process.env): FallbackRoute[] {
  if (!ID_RE.test(profile)) throw new Error("Invalid profile");
  if (!ID_RE.test(route.provider)) throw new Error("Invalid provider id");
  if (!MODEL_RE.test(route.model)) throw new Error("Invalid model");
  if (!listProviders(root, env).some(p => p.id === route.provider))
    throw new Error("Unknown provider \"" + route.provider + "\". Configured providers: " + listProviders(root, env).map(p => p.id).join(", "));
  const all = readAll(root);
  const current = all[profile] ?? [];
  if (current.some(r => r.provider === route.provider && r.model === route.model)) return current;
  if (current.length >= MAX_FALLBACKS) throw new Error("Fallback limit reached (" + MAX_FALLBACKS + ")");
  const next = [...current, { provider: route.provider, model: route.model }];
  all[profile] = next;
  writeAll(root, all);
  return next;
}

export function clearFallbackRoutes(root: string, profile: string): boolean {
  const all = readAll(root);
  if (!all[profile]) return false;
  delete all[profile];
  writeAll(root, all);
  return true;
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

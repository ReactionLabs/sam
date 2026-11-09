import type { TurnRoute } from "./budgets.js";

// Model routing (program P11): per-route model tiers. P5 tiered the tool
// budgets by route, but the model itself never tiered - a 15-minute
// heartbeat poll burned the same main model as a deep background question.
// Now the route also picks the model:
//   heartbeat  -> cheap tier  (SAM_MODEL_CHEAP, falls back to SAM_MODEL)
//   chat       -> main tier   (SAM_MODEL)
//   background -> deep tier   (SAM_MODEL_DEEP, falls back to SAM_MODEL)
// An explicit per-profile model pin always wins over the tier table: a pin
// is the owner's deliberate choice for that person, and routing must never
// silently override it. Consolidation and episodes make no model call at
// all (deterministic), so they cost zero on every tier.
export type ModelTier = "cheap" | "main" | "deep";
export type ModelSource = "profile" | "cheap-env" | "main-env" | "deep-env";

const TIER_FOR_ROUTE: Record<TurnRoute, ModelTier> = {
  heartbeat: "cheap",
  chat: "main",
  background: "deep",
};

export function tierForRoute(route: TurnRoute): ModelTier {
  return TIER_FOR_ROUTE[route] ?? "main";
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export interface ResolvedModel {
  model: string | null;
  tier: ModelTier;
  source: ModelSource;
}

export function resolveModelForRoute(input: {
  route: TurnRoute;
  profileModel?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedModel {
  const env = input.env ?? process.env;
  const tier = tierForRoute(input.route);
  const profileModel = clean(input.profileModel ?? undefined);
  if (profileModel) return { model: profileModel, tier, source: "profile" };
  const main = clean(env.SAM_MODEL);
  if (tier === "cheap") {
    const cheap = clean(env.SAM_MODEL_CHEAP);
    if (cheap) return { model: cheap, tier, source: "cheap-env" };
    return { model: main, tier, source: "main-env" };
  }
  if (tier === "deep") {
    const deep = clean(env.SAM_MODEL_DEEP);
    if (deep) return { model: deep, tier, source: "deep-env" };
    return { model: main, tier, source: "main-env" };
  }
  return { model: main, tier, source: "main-env" };
}

export interface RoutingRow extends ResolvedModel {
  route: TurnRoute;
}

// The full routing table for status surfaces (dashboard, CLI overview):
// one row per route, resolved from the environment alone (no profile pin).
export function modelRoutingTable(env: NodeJS.ProcessEnv = process.env): RoutingRow[] {
  const routes: TurnRoute[] = ["heartbeat", "chat", "background"];
  return routes.map(route => ({ route, ...resolveModelForRoute({ route, env }) }));
}

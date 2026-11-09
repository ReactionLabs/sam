import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";
import type { ModelTier } from "./model-routing.js";

// Token spend accounting (program P11): every model response that carries
// a provider usage object lands one line in .sam/usage.jsonl, stamped with
// the actor, route, tier, and model that actually ran. The dashboard status
// and `sam usage` aggregate the same ledger, so spend is visible per model,
// per route/tier, and per profile - a heartbeat poll on the cheap tier
// reads differently from a deep background run because it IS recorded
// differently. Recording is best-effort: accounting never breaks a turn.
// A provider that reports no usage records nothing (never an invented 0).
export interface UsageEntry {
  at: string;
  actor: string;
  route: TurnRoute;
  tier: ModelTier;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function usagePath(root: string): string {
  return join(resolve(root), ".sam", "usage.jsonl");
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function recordUsage(
  root: string,
  entry: Omit<UsageEntry, "at" | "totalTokens"> & { totalTokens?: number },
): UsageEntry | null {
  try {
    if (!validCount(entry.promptTokens) || !validCount(entry.completionTokens)) return null;
    const total = validCount(entry.totalTokens)
      ? entry.totalTokens
      : entry.promptTokens + entry.completionTokens;
    const line: UsageEntry = {
      at: new Date().toISOString(),
      actor: String(entry.actor || "sam").slice(0, 64),
      route: entry.route,
      tier: entry.tier,
      model: String(entry.model || "unknown").slice(0, 128),
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: total,
    };
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    appendFileSync(usagePath(root), JSON.stringify(line) + "\n");
    return line;
  } catch {
    return null;
  }
}

export function readUsage(root: string): UsageEntry[] {
  const file = usagePath(root);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(raw => {
        try { return JSON.parse(raw) as UsageEntry; } catch { return null; }
      })
      .filter((x): x is UsageEntry => x !== null && validCount(x.totalTokens));
  } catch {
    return [];
  }
}

export interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary extends UsageBucket {
  byModel: Record<string, UsageBucket>;
  byRoute: Record<string, UsageBucket>;
  byTier: Record<string, UsageBucket>;
  byActor: Record<string, UsageBucket>;
  lastAt: string | null;
}

function emptyBucket(): UsageBucket {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function add(bucket: UsageBucket, entry: UsageEntry): void {
  bucket.calls++;
  bucket.promptTokens += entry.promptTokens || 0;
  bucket.completionTokens += entry.completionTokens || 0;
  bucket.totalTokens += entry.totalTokens || 0;
}

export function usageSummary(
  root: string,
  filter: { actor?: string; route?: string; model?: string } = {},
): UsageSummary {
  const summary: UsageSummary = {
    ...emptyBucket(),
    byModel: {},
    byRoute: {},
    byTier: {},
    byActor: {},
    lastAt: null,
  };
  for (const entry of readUsage(root)) {
    if (filter.actor && entry.actor !== filter.actor) continue;
    if (filter.route && entry.route !== filter.route) continue;
    if (filter.model && entry.model !== filter.model) continue;
    add(summary, entry);
    for (const [map, key] of [
      [summary.byModel, entry.model],
      [summary.byRoute, entry.route],
      [summary.byTier, entry.tier],
      [summary.byActor, entry.actor],
    ] as Array<[Record<string, UsageBucket>, string]>) {
      if (!map[key]) map[key] = emptyBucket();
      add(map[key], entry);
    }
    if (!summary.lastAt || entry.at > summary.lastAt) summary.lastAt = entry.at;
  }
  return summary;
}

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";
import type { ModelTier } from "./model-routing.js";
import { recordActivity } from "./activity.js";

// Token spend accounting (program P11): every model response that carries
// a provider usage object lands one line in .sam/usage.jsonl, stamped with
// the actor, route, tier, and model that actually ran. The dashboard status
// and `sam usage` aggregate the same ledger, so spend is visible per model,
// per route/tier, and per profile - a heartbeat poll on the cheap tier
// reads differently from a deep background run because it IS recorded
// differently. Recording is best-effort: accounting never breaks a turn,
// and a failed write ledgers one usage-failed activity line instead of
// vanishing (the summaries keep reading the frozen totals as truth, so
// the failure line is the only signal they have stopped moving).
// Reading is the opposite discipline: a failed read ledgers the same
// one line and rethrows, because a summary folded from an unreadable
// ledger would report zero spend as truth (see readUsage).
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

// One ledger line per failed usage write (gap found 2026-11-13):
// accounting never breaks a turn, but a dead usage ledger must not
// read as frozen-but-true spend forever either - the summaries
// below keep reporting the totals they can read, so the failure
// line in the activity ledger is the only signal that the numbers
// have stopped moving. The reason is the error's own words
// (collapsed, capped); the entry's token counts never enter it.
export function usageFailureSummary(model: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Usage record failed for model " + model + ": " + clean).slice(0, 200);
}

export function recordUsageFailure(root: string, actor: string, model: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, actor, "usage-failed", usageFailureSummary(model, reason));
}

// One ledger line per failed usage READ (gap found 2026-11-13,
// hourly run 19:04): the read seam was the one silent touch left
// in the accounting pair - readUsage folded a dead read to []
// with no line anywhere, so every summary reported 0 calls /
// 0 tokens for all time, indistinguishable from a fresh install
// that has spent nothing. The reader is the system, so the line
// carries actor "sam" (the session-caps read precedent) and no
// model; token counts never enter it.
export function usageReadFailureSummary(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Usage ledger read failed: " + clean).slice(0, 200);
}

export function recordUsageReadFailure(root: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "usage-failed", usageReadFailureSummary(reason));
}

export function recordUsage(
  root: string,
  entry: Omit<UsageEntry, "at" | "totalTokens"> & { totalTokens?: number },
): UsageEntry | null {
  // Validation stays silent by design: a provider that reports no
  // (or malformed) usage records nothing - that is not a failure.
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
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    appendFileSync(usagePath(root), JSON.stringify(line) + "\n");
    return line;
  } catch (error) {
    recordUsageFailure(root, line.actor, line.model, error);
    return null;
  }
}

export function readUsage(root: string): UsageEntry[] {
  // The read seam follows the house contract fail-closed (gap
  // found 2026-11-13, hourly run 19:04): this ledger is a spend
  // RECORD whose summaries are quoted as truth, and a dead read
  // folded to [] reads as zero spend for all time - the unsafe
  // lie, understating spend to nothing while the class stayed
  // uncountable. So a failed filesystem touch ledgers ONE
  // usage-failed line (the read recorder above) and rethrows
  // exactly: usageSummary / usageToday / the CLI list surface
  // the error instead of a false zero, now with the true cause
  // countable under its own kind (the session-caps /
  // verification / goldfish read precedent). An absent ledger
  // still reads [] - a fresh install has genuinely spent
  // nothing - and per-line torn parsing stays forgiving; only
  // the filesystem touch is guarded.
  const file = usagePath(root);
  let raw: string | null;
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch (error) {
    recordUsageReadFailure(root, error);
    throw error;
  }
  if (raw === null) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as UsageEntry; } catch { return null; }
    })
    .filter((x): x is UsageEntry => x !== null && validCount(x.totalTokens));
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

function summarize(entries: UsageEntry[]): UsageSummary {
  const summary: UsageSummary = {
    ...emptyBucket(),
    byModel: {},
    byRoute: {},
    byTier: {},
    byActor: {},
    lastAt: null,
  };
  for (const entry of entries) {
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

export function usageSummary(
  root: string,
  filter: { actor?: string; route?: string; model?: string } = {},
): UsageSummary {
  return summarize(readUsage(root).filter(entry => {
    if (filter.actor && entry.actor !== filter.actor) return false;
    if (filter.route && entry.route !== filter.route) return false;
    if (filter.model && entry.model !== filter.model) return false;
    return true;
  }));
}

/** Today's ledger only. The all-time summary is a different number and
 *  must not be labeled as today. The day is the UTC date of `now`. */
export function usageToday(root: string, now: Date = new Date()): UsageSummary {
  const day = now.toISOString().slice(0, 10);
  return summarize(readUsage(root).filter(entry => typeof entry.at === "string" && entry.at.slice(0, 10) === day));
}

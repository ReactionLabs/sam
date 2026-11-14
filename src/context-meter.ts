import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";
import { recordActivity } from "./activity.js";

// Context metering (Program H, self-knowledge item D - filed
// requirement 5): injected-context size per turn is a
// first-class measured metric, next to cost per completed task.
//
// The lesson is Mita's own 2026-11-13 bloat diagnosis: standing
// context had regrown to ~72K tokens carried on EVERY turn
// before anyone measured it; the felt slowness was real for
// weeks before the number existed. Sam already counted
// provider tokens after the fact (usage.jsonl) and audited the
// FIXED system load on demand (context-audit), but the actual
// context a turn injected - system tiers, standing law, recall,
// the compaction summary, the kept history - was never measured
// per turn, so growth in the volatile tiers was invisible until
// it hurt. Now every assembled chat turn records one line in
// .sam/context.jsonl with the breakdown, and `sam usage
// context` reads it beside the token spend.
//
// The accounting discipline is the usage ledger's own:
// recording is best-effort (a failed write ledgers ONE
// context-failed line and never breaks a turn), reading fails
// closed (a failed read ledgers the same one line and
// rethrows, because a summary folded from an unreadable ledger
// would report zero context as truth). Sizes are characters and
// word counts measured locally at assembly - the honest local
// measure, independent of any provider's tokenizer.
export interface ContextMeterEntry {
  at: string;
  actor: string;
  route: TurnRoute;
  systemChars: number;
  lawChars: number;
  recallChars: number;
  standingChars: number;
  summaryChars: number;
  historyChars: number;
  totalChars: number;
  totalWords: number;
}

function contextPath(root: string): string {
  return join(resolve(root), ".sam", "context.jsonl");
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function contextMeterFailureSummary(phase: "write" | "read", reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Context meter " + phase + " failed: " + clean).slice(0, 200);
}

export function recordContextMeterFailure(root: string, actor: string, phase: "write" | "read", error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, actor, "context-failed", contextMeterFailureSummary(phase, reason));
}

export function recordContextMeter(
  root: string,
  entry: Omit<ContextMeterEntry, "at">,
): ContextMeterEntry | null {
  const fields = [entry.systemChars, entry.lawChars, entry.recallChars, entry.standingChars, entry.summaryChars, entry.historyChars, entry.totalChars, entry.totalWords];
  if (!fields.every(validCount)) return null;
  const line: ContextMeterEntry = {
    at: new Date().toISOString(),
    actor: String(entry.actor || "sam").slice(0, 64),
    route: entry.route,
    systemChars: entry.systemChars,
    lawChars: entry.lawChars,
    recallChars: entry.recallChars,
    standingChars: entry.standingChars,
    summaryChars: entry.summaryChars,
    historyChars: entry.historyChars,
    totalChars: entry.totalChars,
    totalWords: entry.totalWords,
  };
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    appendFileSync(contextPath(root), JSON.stringify(line) + "\n");
    return line;
  } catch (error) {
    recordContextMeterFailure(root, line.actor, "write", error);
    return null;
  }
}

export function readContextMeters(root: string): ContextMeterEntry[] {
  const file = contextPath(root);
  let raw: string | null;
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch (error) {
    recordContextMeterFailure(root, "sam", "read", error);
    throw error;
  }
  if (raw === null) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as ContextMeterEntry; } catch { return null; }
    })
    .filter((x): x is ContextMeterEntry => x !== null && validCount(x.totalChars) && validCount(x.totalWords));
}

export interface ContextSummary {
  turns: number;
  totalChars: number;
  totalWords: number;
  avgTotalChars: number;
  avgTotalWords: number;
  maxTotalChars: number;
  systemChars: number;
  lawChars: number;
  recallChars: number;
  standingChars: number;
  summaryChars: number;
  historyChars: number;
  lastAt: string | null;
}

function summarize(entries: ContextMeterEntry[]): ContextSummary {
  const sum = (pick: (e: ContextMeterEntry) => number) => entries.reduce((n, e) => n + (pick(e) || 0), 0);
  const turns = entries.length;
  const totalChars = sum(e => e.totalChars);
  const totalWords = sum(e => e.totalWords);
  return {
    turns,
    totalChars,
    totalWords,
    avgTotalChars: turns ? Math.round(totalChars / turns) : 0,
    avgTotalWords: turns ? Math.round(totalWords / turns) : 0,
    maxTotalChars: entries.reduce((m, e) => Math.max(m, e.totalChars || 0), 0),
    systemChars: sum(e => e.systemChars),
    lawChars: sum(e => e.lawChars),
    recallChars: sum(e => e.recallChars),
    standingChars: sum(e => e.standingChars),
    summaryChars: sum(e => e.summaryChars),
    historyChars: sum(e => e.historyChars),
    lastAt: entries.reduce<string | null>((latest, e) => (!latest || e.at > latest ? e.at : latest), null),
  };
}

export function contextSummary(
  root: string,
  filter: { actor?: string; route?: string } = {},
): ContextSummary {
  return summarize(readContextMeters(root).filter(entry => {
    if (filter.actor && entry.actor !== filter.actor) return false;
    if (filter.route && entry.route !== filter.route) return false;
    return true;
  }));
}

/** Today's meter only (UTC date of `now`), mirroring
 *  usageToday: the all-time summary is a different number and
 *  must not be labeled as today. */
export function contextToday(root: string, now: Date = new Date()): ContextSummary {
  const day = now.toISOString().slice(0, 10);
  return summarize(readContextMeters(root).filter(entry => typeof entry.at === "string" && entry.at.slice(0, 10) === day));
}

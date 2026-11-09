import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The activity ledger: one append-only line per thing SAM did, so the owner can
// answer "what did you do today and why" from a single place. Turns, proposals,
// approvals, executions, heartbeat work - all of it lands here. Writing is
// best-effort by design: the ledger must never break the work it records.
export interface ActivityLine { at: string; actor: string; kind: string; summary: string }
function ledgerPath(root: string): string { return join(resolve(root), ".sam", "activity.jsonl"); }
export function recordActivity(root: string, actor: string, kind: string, summary: string): void {
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    const line: ActivityLine = { at: new Date().toISOString(), actor, kind, summary: summary.slice(0, 300) };
    appendFileSync(ledgerPath(root), JSON.stringify(line) + "\n");
  } catch { /* the ledger never breaks a turn */ }
}
export interface ActivityFilter { actor?: string; kind?: string }
export function readActivity(root: string, limit = 30, filter: ActivityFilter = {}): ActivityLine[] {
  const file = ledgerPath(root);
  if (!existsSync(file)) return [];
  try {
    // Filter BEFORE the limit: slicing the raw tail first would starve a
    // per-profile view whenever other actors were busier (P8 console filter).
    let lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => {
      try { return JSON.parse(raw) as ActivityLine; } catch { return null; }
    }).filter((x): x is ActivityLine => x !== null);
    if (filter.actor) lines = lines.filter(l => l.actor === filter.actor);
    if (filter.kind) lines = lines.filter(l => l.kind === filter.kind);
    return lines.slice(-limit);
  } catch { return []; }
}

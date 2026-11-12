import { connectors, readConnectorTool, type Connector } from "./connectors.js";
import { recordActivity } from "./activity.js";

/**
 * The deterministic stack watch (the stack-watch deterministic
 * count, recorded 2026-11-10 under the turn-failure gap and
 * proven live the same night).
 *
 * The stack watch heartbeat job used to be a model prompt: "count
 * how many paper setups are in state entered, using the
 * paper_setups tool." The tool cannot support that ask - it pages
 * (limit clamped 1..100, default 20), has no offset, and its count
 * field is the page length, not a total. So the model reported the
 * page it happened to fetch: 20 on most ticks, 100 once it asked
 * for the max page, and P3 - behaving exactly as designed - read
 * each flip as a fact change and delivered it (22:59 UTC entered
 * 100, 23:30 UTC entered 20, every other fact identical). The true
 * entered count is >= 100 and unknowable through the tool today.
 *
 * This module moves the count into code, where counting belongs:
 *
 * - READS: stack_health (candidates total, newest candidate time,
 *   candidate verdict counts - all server-side aggregates) plus ONE
 *   paper_setups fetch for state "entered" at the page cap, through
 *   the existing read-only connector door. Nothing here can write.
 * - COUNT: rows are counted in code, never by a model. A numeric
 *   `total` on the tool result, if the server ever returns one, is
 *   cited exactly (the report is total-aware ahead of the recorded
 *   server fix). A short page is an exact count. A full page is a
 *   FLOOR - "100 or more (the tool pages at 100 and reports no
 *   total)" - never dressed up as an exact number.
 * - DETERMINISM: same tool results, same text, byte for byte. The
 *   report is a Phase C script job's stdout (sam-stack-watch), so
 *   P3 diffing compares stable text and a frozen stack stays
 *   silent; when a real fact moves, the text moves and delivers.
 * - FROZEN: the job prompt's own standing fact - while the newest
 *   candidate is still the 2026-11-04 crash stamp, the report says
 *   the stack is still frozen. The comparison is at second
 *   precision (the P3 timestamp lesson: rendering wobble is not a
 *   fact change), and the line disappears on its own the day the
 *   newest candidate advances past the stamp.
 */

export const STACK_WATCH_SCRIPT = "sam-stack-watch";
export const ENTERED_PAGE_LIMIT = 100;
export const ENTERED_STATE = "entered";
export const FROZEN_CANDIDATE_NEWEST = "2026-11-04T22:45:59.894Z";
export const STACK_WATCH_ACTOR = "sam";

export type StackToolCaller = (connector: Connector, tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The connector the stack watch reads through: an enabled
 *  connector whose allowlist carries both stack tools. The Nines
 *  connector wins by name; any other enabled connector offering
 *  both tools is the fallback, so a renamed install still reads. */
export function findStackConnector(root: string): Connector | null {
  const candidates = connectors(root).filter(c => c.enabled && c.allowedTools.includes("stack_health") && c.allowedTools.includes("paper_setups"));
  return candidates.find(c => c.name === "Nines") ?? candidates[0] ?? null;
}

export function stackWatchStatus(root: string): { connector: string | null; script: string } {
  const connector = findStackConnector(root);
  return { connector: connector ? connector.name : null, script: STACK_WATCH_SCRIPT };
}

/** An MCP tools/call result, unwrapped to the tool's own JSON:
 *  the {content:[{type:"text",text}]} envelope is parsed, a bare
 *  JSON string is parsed, and an already-structured result rides
 *  as-is. Anything else is a named failure, never a guess. */
export function unwrapToolResult(raw: unknown): Record<string, unknown> {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new Error("Stack tool returned non-JSON text"); }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const text = content.find(x => x && typeof x === "object" && (x as Record<string, unknown>).type === "text");
      const body = text ? (text as Record<string, unknown>).text : undefined;
      if (typeof body !== "string") throw new Error("Stack tool returned no text content");
      try { value = JSON.parse(body); } catch { throw new Error("Stack tool returned non-JSON text"); }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stack tool returned an unexpected shape");
  return value as Record<string, unknown>;
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("stack_health is missing a usable " + field);
  return Math.floor(value);
}

export interface StackHealthFacts {
  candidatesTotal: number;
  candidatesNewest: string;
  verdicts: Array<{ verdict: string; n: number }>;
  paperSetupsTotal: number | null;
}

/** stack_health's aggregates, read strictly: a missing or
 *  malformed field fails the report (the script job logs
 *  job-failed and delivers nothing) instead of printing a
 *  half-invented watch line. */
export function parseStackHealth(raw: unknown): StackHealthFacts {
  const result = unwrapToolResult(raw);
  const tables = result.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) throw new Error("stack_health returned no tables");
  const t = tables as Record<string, unknown>;
  const candidatesTotal = asCount(t.candidates_count, "candidates_count");
  const candidatesNewest = t.candidates_newest;
  if (typeof candidatesNewest !== "string" || !candidatesNewest) throw new Error("stack_health is missing candidates_newest");
  const rawVerdicts = result.candidate_verdicts;
  if (!Array.isArray(rawVerdicts) || !rawVerdicts.length) throw new Error("stack_health returned no candidate verdicts");
  const verdicts = rawVerdicts.map(v => {
    const row = v as Record<string, unknown>;
    if (typeof row.verdict !== "string" || !row.verdict) throw new Error("stack_health returned a verdict without a name");
    return { verdict: row.verdict, n: asCount(row.n, "verdict count") };
  });
  const paperSetupsTotal = typeof t.paper_setups_count === "number" && Number.isFinite(t.paper_setups_count) ? Math.floor(t.paper_setups_count) : null;
  return { candidatesTotal, candidatesNewest, verdicts, paperSetupsTotal };
}

export interface EnteredCount { count: number; exact: boolean }

/** The entered count, computed in code from ONE page fetched at
 *  the cap: a server `total` (when the tool grows one) is exact;
 *  a short page is exact; a full page is a floor at the cap. */
export function countEnteredSetups(raw: unknown): EnteredCount {
  const result = unwrapToolResult(raw);
  if (typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0) {
    return { count: Math.floor(result.total), exact: true };
  }
  const rows = result.paper_setups;
  if (!Array.isArray(rows)) throw new Error("paper_setups returned no setups array");
  if (rows.length < ENTERED_PAGE_LIMIT) return { count: rows.length, exact: true };
  return { count: ENTERED_PAGE_LIMIT, exact: false };
}

/** Second-precision form (the P3 lesson): fractional-second
 *  rendering wobble is not a different fact. */
export function secondPrecision(iso: string): string {
  return iso.replace(/\.\d+(Z|[+-]\d{2}:?\d{2})$/, "$1");
}

export function isFrozenStack(candidatesNewest: string): boolean {
  return secondPrecision(candidatesNewest) === secondPrecision(FROZEN_CANDIDATE_NEWEST);
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export interface StackWatchReport {
  text: string;
  connector: string;
  candidatesTotal: number;
  candidatesNewest: string;
  verdicts: Array<{ verdict: string; n: number }>;
  entered: EnteredCount;
  frozen: boolean;
}

/** Assemble the watch report from the connector's own numbers.
 *  Throws - naming the seam - when no connector offers the stack
 *  tools or a read fails, so the script job fails honestly
 *  (job-failed, nothing delivered) instead of printing a guess. */
export async function buildStackWatchReport(root: string, opts: { call?: StackToolCaller; actor?: string } = {}): Promise<StackWatchReport> {
  const connector = findStackConnector(root);
  if (!connector) {
    const registered = connectors(root).map(c => c.name);
    throw new Error("No enabled connector offers the Nines stack tools (stack_health, paper_setups), so the stack watch has nothing to read. Registered connectors: " + (registered.length ? registered.join(", ") : "(none)"));
  }
  const call = opts.call ?? ((c: Connector, tool: string, args: Record<string, unknown>) => readConnectorTool(c, tool, args, root));
  const health = parseStackHealth(await call(connector, "stack_health", {}));
  const entered = countEnteredSetups(await call(connector, "paper_setups", { state: ENTERED_STATE, limit: ENTERED_PAGE_LIMIT }));
  const frozen = isFrozenStack(health.candidatesNewest);
  const lines = [
    "Candidates total: " + formatCount(health.candidatesTotal),
    "Newest candidate: " + health.candidatesNewest,
    "Alert verdicts: " + health.verdicts.map(v => v.verdict + " " + formatCount(v.n)).join(" / "),
    entered.exact
      ? "Paper setups in state entered: " + formatCount(entered.count)
      : "Paper setups in state entered: " + formatCount(entered.count) + " or more (the paper_setups tool pages at " + ENTERED_PAGE_LIMIT + " and reports no total, so the exact count is not knowable from the tool)",
  ];
  if (frozen) lines.push("The stack is still frozen.");
  const report: StackWatchReport = {
    text: lines.join("\n"),
    connector: connector.name,
    candidatesTotal: health.candidatesTotal,
    candidatesNewest: health.candidatesNewest,
    verdicts: health.verdicts,
    entered,
    frozen,
  };
  recordActivity(root, opts.actor ?? STACK_WATCH_ACTOR, "stack-watch",
    "Stack watch (deterministic): candidates " + formatCount(report.candidatesTotal) +
    ", newest " + secondPrecision(report.candidatesNewest) +
    ", entered " + (entered.exact ? String(entered.count) : entered.count + "+ (page cap)") +
    ", frozen " + (frozen ? "yes" : "no"));
  return report;
}

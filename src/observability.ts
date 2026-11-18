import { ChatStore } from "./chats.js";
import { readActivity, type ActivityLine } from "./activity.js";
import { usageSummary, type UsageBucket, type UsageSummary } from "./usage.js";
import { listProviders } from "./providers.js";
import { readProbeStore, type ProbeBucket } from "./auth-status.js";

// Observability data (sprint item 7). One read model for the status API
// and the CLI. The Rust terminal reads this same shape from /api/status:
// provider health, per-agent activity, spend, and turn failures.
// Data only. No team UI.

export interface ProviderHealthRow {
  id: string;
  source: "env" | "file";
  endpoint: string | null;
  keyEnv: string;
  key: "present" | "absent";
  model: string | null;
  health: { bucket: ProbeBucket; reason: string; at: string; latencyMs: number | null } | null;
}
export interface AgentFailure { at: string; reason: string; summary: string }
export interface AgentObservability {
  name: string;
  activity: ActivityLine[];
  spend: UsageBucket;
  failures: AgentFailure[];
}
export interface TurnFailure extends AgentFailure { actor: string }
export interface ObservabilityReport {
  providerHealth: ProviderHealthRow[];
  agents: AgentObservability[];
  spend: UsageSummary;
  failures: TurnFailure[];
}

function emptySpend(): UsageBucket {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

// "Turn failed in chat 12345678 (chat): Unsafe model output" -> the reason
// is the error text after the last colon. A line that does not match still
// returns its whole summary, so the count is never hidden.
export function failureReason(summary: string): string {
  const cut = summary.lastIndexOf(": ");
  return cut >= 0 ? summary.slice(cut + 2) : summary;
}

export function observabilityReport(root: string, env: NodeJS.ProcessEnv = process.env): ObservabilityReport {
  const probes = readProbeStore(root);
  const byTarget = new Map((probes?.results ?? []).map(row => [row.target, row]));
  const providerHealth: ProviderHealthRow[] = listProviders(root, env).map(provider => {
    const probe = byTarget.get("provider:" + provider.id) ?? null;
    return {
      id: provider.id,
      source: provider.source,
      endpoint: provider.endpoint,
      keyEnv: provider.keyEnv,
      key: provider.key,
      model: provider.model,
      health: probe ? { bucket: probe.bucket, reason: probe.reason, at: probe.at, latencyMs: probe.latencyMs } : null,
    };
  });
  const spend = usageSummary(root);
  const failures: TurnFailure[] = readActivity(root, 200, { kind: "turn-failed" }).map(line => ({
    at: line.at,
    actor: line.actor,
    summary: line.summary,
    reason: failureReason(line.summary),
  }));
  let names = ["sam"];
  try {
    const db = new ChatStore(root);
    try { names = ["sam", ...db.agents().map(agent => agent.name).filter(name => name !== "sam")]; }
    finally { db.close(); }
  } catch { /* a workspace that cannot open its chat store still reports the core profile */ }
  const agents: AgentObservability[] = names.map(name => ({
    name,
    activity: readActivity(root, 20, { actor: name }),
    spend: spend.byActor[name] ?? emptySpend(),
    failures: failures.filter(failure => failure.actor === name).map(({ at, reason, summary }) => ({ at, reason, summary })),
  }));
  return { providerHealth, agents, spend, failures };
}

// The turn-failure scorecard (2026-11-18, the measured-proof
// series): the 2026-11-10 turn-failed seam made dead turns
// countable, but no daily surface ever counted them - the
// observability fold above is a last-200 list carrying
// stamps, actors, and verbatim reasons, so it can never be
// P3-diffed. This text folds the whole ledger's turn-failed
// lines to counts only: the total, and counts per fixed
// in-code reason bucket. The buckets mirror the self-work
// defect classifier's turn-failed shapes, extended only
// with the two buckets the live ledger proves (provider
// HTTP failures, invalid requests); a reason matching no
// shape is "other" and is never printed. No stamp, no chat
// id, no actor, no verbatim reason enters the text, so a
// day no turn dies is byte-identical and P3-silent, and
// the first new dead turn is the news. A pure read: it
// creates nothing, spends no model call, and retries
// nothing - the ledger and the turn seam are untouched.
export type TurnFailureBucket = "unsafe-output" | "empty-response" | "too-many-tool-calls" | "timeout" | "not-configured" | "provider-error" | "invalid-request" | "other";
export function turnFailureBucket(reason: string): TurnFailureBucket {
  if (/unsafe model output/i.test(reason)) return "unsafe-output";
  if (/empty model response/i.test(reason)) return "empty-response";
  if (/too many tool calls/i.test(reason)) return "too-many-tool-calls";
  if (/timed out|timeout/i.test(reason)) return "timeout";
  if (/not configured/i.test(reason)) return "not-configured";
  if (/connector request failed|http \d{3}/i.test(reason)) return "provider-error";
  if (/^invalid /i.test(reason)) return "invalid-request";
  return "other";
}
export function turnFailureScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "turn-failed" });
  const buckets = new Map<TurnFailureBucket, number>();
  for (const line of lines) {
    const bucket = turnFailureBucket(failureReason(line.summary));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const byBucket = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  out.push("Turn failures: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Failed turns: " + String(lines.length));
  out.push("By reason: " + (byBucket.length ? byBucket.map(([bucket, n]) => bucket + " " + String(n)).join(", ") : "none"));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a turn or prints a reason; a new dead turn is the news");
  return out.join("\n");
}

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

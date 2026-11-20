import { readActivity } from "./activity.js";

// The agent re-pin writers and scorecard (2026-11-20, the
// measured-proof series): every profile re-pin - a model pin
// set or cleared (the agents CLI or the config wizard's model
// section), a provider pin set or cleared, a connector pin
// set or cleared, and an instructions rewrite - ledgers as
// an "agent-repin" line, but until now the summaries were
// inline string concatenation at five call sites (four in
// the CLI, one in the wizard) with no ONE writer, and the
// class was never folded: how often profiles are re-pinned,
// which field moves, and whether pins are set or cleared was
// invisible in aggregate, even though a re-pin silently
// changes what every later turn for that profile runs on.
// Re-pinning is the operator working as designed, so the
// verdict is attention only when a line is unparseable (a
// writer's shape broken or the ledger tampered), else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and never a profile name, a
// model name, a provider id, a connector id, or any
// instruction text - the summaries carry the pin values,
// which a fold consumes and never prints. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and re-pins nothing; every state is built through
// the ledger's own public door (recordActivity) with these
// summary writers, never around either.

export function agentRepinModelLedgerSummary(model: string | null, viaWizard = false): string {
  const base = "Model pin " + (model ? "set to " + model : "cleared (route tier decides)");
  return viaWizard ? base + " via config wizard" : base;
}

export function agentRepinProviderLedgerSummary(provider: string | null): string {
  return "Provider pin " + (provider ? "set to " + provider : "cleared (environment provider)");
}

export function agentRepinConnectorLedgerSummary(connectorId: string | null): string {
  return "Connector pin " + (connectorId ? "set to " + connectorId : "cleared");
}

export function agentRepinInstructionsLedgerSummary(chars: number): string {
  return "Instructions rewritten (" + String(chars) + " chars)";
}

export type AgentRepinField = "model" | "provider" | "connector" | "instructions";

export function parseAgentRepinSummary(
  summary: string,
): { field: AgentRepinField; act: "set" | "cleared" | "rewritten"; chars?: number } | null {
  if (summary === "Model pin cleared (route tier decides)" || summary === "Model pin cleared (route tier decides) via config wizard") {
    return { field: "model", act: "cleared" };
  }
  // A set line's value is consumed, never surfaced; the
  // wizard's suffix is part of the shape, not the value.
  if (/^Model pin set to \S/.test(summary)) return { field: "model", act: "set" };
  if (summary === "Provider pin cleared (environment provider)") return { field: "provider", act: "cleared" };
  if (/^Provider pin set to \S.*$/.test(summary)) return { field: "provider", act: "set" };
  if (summary === "Connector pin cleared") return { field: "connector", act: "cleared" };
  if (/^Connector pin set to \S+$/.test(summary)) return { field: "connector", act: "set" };
  const rewritten = /^Instructions rewritten \((\d+) chars\)$/.exec(summary);
  if (rewritten) return { field: "instructions", act: "rewritten", chars: Number(rewritten[1]) };
  return null;
}

export function agentRepinScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "agent-repin" });
  let unparseable = 0;
  let modelSet = 0, modelCleared = 0;
  let providerSet = 0, providerCleared = 0;
  let connectorSet = 0, connectorCleared = 0;
  let instructionsRewritten = 0, instructionChars = 0;
  for (const line of lines) {
    const parsed = parseAgentRepinSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.field === "model") { if (parsed.act === "set") modelSet += 1; else modelCleared += 1; }
    else if (parsed.field === "provider") { if (parsed.act === "set") providerSet += 1; else providerCleared += 1; }
    else if (parsed.field === "connector") { if (parsed.act === "set") connectorSet += 1; else connectorCleared += 1; }
    else { instructionsRewritten += 1; instructionChars += parsed.chars ?? 0; }
  }
  const parsedTotal = modelSet + modelCleared + providerSet + providerCleared + connectorSet + connectorCleared + instructionsRewritten;
  const parts: string[] = [];
  parts.push("Agent repins: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(parsedTotal) + " acts");
  parts.push("model set " + String(modelSet) + " / cleared " + String(modelCleared));
  parts.push("provider set " + String(providerSet) + " / cleared " + String(providerCleared));
  parts.push("connector set " + String(connectorSet) + " / cleared " + String(connectorCleared));
  parts.push("instructions rewritten " + String(instructionsRewritten) + " (" + String(instructionChars) + " chars)");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

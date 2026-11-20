import { readActivity } from "./activity.js";
import { STANDING_FILES } from "./standing-files.js";
import { APPROVAL_MODES } from "./approval-policy.js";
import { ENGINE_PROVIDERS } from "./engine-connect.js";

// The operator configuration scorecard (2026-11-20, the
// measured-proof series): the acts that configure the
// install itself have ledgered across seven kinds since
// their seams landed - "code-root" (designated / cleared),
// "standing-file" (set / cleared), "approval-mode" (one
// line per mode set), "connector-paired" (one line per
// pairing, carrying its approved read-only tool count),
// and "engine-provider" / "engine-connected" /
// "engine-disconnected" (the coding-engine route acts) -
// in the fixed shapes the seams' ONE writers write, but
// the family was never folded: the vault scorecard folds
// the vault's own lines and the code scorecards fold
// writes and runs, yet who designated the code root, set
// a standing file, loosened the approval mode, paired a
// connector and with how many tools approved, or selected
// and connected an engine was invisible in aggregate, even
// though it is the highest-trust record SAM keeps.
// Configuring is the operator working as designed, so the
// verdict is attention only when a line is unparseable (a
// writer's shape broken or the ledger tampered), else
// clear. The parsers validate free values against the
// fixed sets the seams themselves validate against - a
// standing-file name against STANDING_FILES, a mode
// against APPROVAL_MODES, an engine label against
// ENGINE_PROVIDERS' labels - and an unrecognized value
// fails the parse rather than surfacing as free text. The
// scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, and never a code-root
// path, a standing file's content, a connector's name,
// host, or vault credential name, a profile, an approved
// tool's name, or a verbatim summary - the summaries carry
// all of those, which a fold must never print. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and configures, designates, pairs,
// connects, and disconnects nothing; every state is built
// through the ledger's own public door (recordActivity)
// with the seams' own summary writers, never around
// either.

const ENGINE_LABELS: string[] = ENGINE_PROVIDERS.map(p => p.label);
const STANDING_NAMES: string[] = STANDING_FILES.map(f => f.name);

export function parseCodeRootSummary(summary: string): { act: "designated" } | { act: "cleared" } | null {
  if (summary === "Cleared the designated code root") return { act: "cleared" };
  if (/^Designated code root: \S.*$/.test(summary)) return { act: "designated" };
  return null;
}

export function parseStandingFileSummary(summary: string): { act: "set"; chars: number } | { act: "cleared" } | null {
  const set = /^Standing file ([a-z][a-z0-9._-]*) \([a-z]+\) set, (\d+) chars$/.exec(summary);
  if (set) {
    if (!STANDING_NAMES.includes(set[1])) return null;
    return { act: "set", chars: Number(set[2]) };
  }
  const cleared = /^Standing file ([a-z][a-z0-9._-]*) cleared$/.exec(summary);
  if (cleared) {
    if (!STANDING_NAMES.includes(cleared[1])) return null;
    return { act: "cleared" };
  }
  return null;
}

export function parseApprovalModeSummary(summary: string): { mode: string } | null {
  const m = /^Approval mode set to ([a-z]+)( \(auto: [a-z][a-z0-9-]*(, [a-z][a-z0-9-]*)*\))?$/.exec(summary);
  if (!m) return null;
  if (!(APPROVAL_MODES as string[]).includes(m[1])) return null;
  return { mode: m[1] };
}

export function parseConnectorPairedSummary(summary: string): { approved: number } | null {
  const m = /^Paired connector ".+" at \S+ using vault credential \S+ for profile [a-z][a-z0-9._-]* \((pinned|core profile - no pin row)\) - (\d+) approved read-only tool\(s\): .+$/.exec(summary);
  if (!m) return null;
  return { approved: Number(m[2]) };
}

export function parseEngineProviderSummary(summary: string): { provider: true } | null {
  const m = /^(.+) selected as the coding-engine provider \(config choice; no connection was recorded or removed by this act\)$/.exec(summary);
  if (!m) return null;
  if (!ENGINE_LABELS.includes(m[1])) return null;
  return { provider: true };
}

export function parseEngineConnectedSummary(summary: string): { connected: true } | null {
  const m = /^(.+) connected as the coding-engine route via CLI reuse \(auth verified by `.+`; SAM stored only a route marker in the engine connection store, no credentials\)$/.exec(summary);
  if (!m) return null;
  if (!ENGINE_LABELS.includes(m[1])) return null;
  return { connected: true };
}

export function parseEngineDisconnectedSummary(summary: string): { disconnected: true } | null {
  const m = /^(.+) engine connection marker removed \(CLI reuse route disconnected; the CLI's own login was not touched\)$/.exec(summary);
  if (!m) return null;
  if (!ENGINE_LABELS.includes(m[1]) && m[1] !== "Engine") return null;
  return { disconnected: true };
}

export function configActsScorecardText(root: string): string {
  const codeRoots = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "code-root" });
  const standingFiles = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "standing-file" });
  const approvalModes = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "approval-mode" });
  const pairings = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "connector-paired" });
  const providers = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-provider" });
  const connectedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-connected" });
  const disconnectedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-disconnected" });
  let unparseable = 0;
  let rootsDesignated = 0, rootsCleared = 0;
  for (const line of codeRoots) {
    const parsed = parseCodeRootSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.act === "designated") rootsDesignated += 1; else rootsCleared += 1;
  }
  let filesSet = 0, filesCleared = 0, setChars = 0;
  for (const line of standingFiles) {
    const parsed = parseStandingFileSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.act === "set") { filesSet += 1; setChars += parsed.chars; } else filesCleared += 1;
  }
  const byMode = new Map<string, number>();
  for (const line of approvalModes) {
    const parsed = parseApprovalModeSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    byMode.set(parsed.mode, (byMode.get(parsed.mode) ?? 0) + 1);
  }
  let approvedTools = 0, paired = 0;
  for (const line of pairings) {
    const parsed = parseConnectorPairedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    paired += 1; approvedTools += parsed.approved;
  }
  let providersSelected = 0;
  for (const line of providers) {
    if (!parseEngineProviderSummary(line.summary)) { unparseable += 1; continue; }
    providersSelected += 1;
  }
  let enginesConnected = 0;
  for (const line of connectedLines) {
    if (!parseEngineConnectedSummary(line.summary)) { unparseable += 1; continue; }
    enginesConnected += 1;
  }
  let enginesDisconnected = 0;
  for (const line of disconnectedLines) {
    if (!parseEngineDisconnectedSummary(line.summary)) { unparseable += 1; continue; }
    enginesDisconnected += 1;
  }
  const total = codeRoots.length + standingFiles.length + approvalModes.length + pairings.length + providers.length + connectedLines.length + disconnectedLines.length;
  const parsedTotal = rootsDesignated + rootsCleared + filesSet + filesCleared + [...byMode.values()].reduce((a, b) => a + b, 0) + paired + providersSelected + enginesConnected + enginesDisconnected;
  const parts: string[] = [];
  parts.push("Configuration acts: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(parsedTotal) + " acts");
  parts.push("code roots designated " + String(rootsDesignated) + " / cleared " + String(rootsCleared));
  parts.push("standing files set " + String(filesSet) + " / cleared " + String(filesCleared) + " (" + String(setChars) + " chars set)");
  parts.push("approval mode sets " + String([...byMode.values()].reduce((a, b) => a + b, 0)) + " (manual " + String(byMode.get("manual") ?? 0) + " / smart " + String(byMode.get("smart") ?? 0) + " / off " + String(byMode.get("off") ?? 0) + ")");
  parts.push("connectors paired " + String(paired) + " (" + String(approvedTools) + " approved tools)");
  parts.push("engine providers selected " + String(providersSelected));
  parts.push("engines connected " + String(enginesConnected) + " / disconnected " + String(enginesDisconnected));
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

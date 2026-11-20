import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import {
  addConnectorVault, allowlistPairHost, connectors, isLoopbackHost,
  removeConnector, testConnector, updateConnector, type Connector,
} from "./connectors.js";
import { listVaultCredentials, VAULT_NAME_RE } from "./vault.js";
import { errorReason } from "./telegram.js";

/**
 * SELF-PAIRING (Dip ruling 2026-11-12 13:18 EST: "we want it to be
 * able to do it himself"): SAM provisions an MCP pairing himself -
 * first target the Desktop Bridge on the owner's PC - instead of
 * the owner hand-wiring env vars and dashboard forms.
 *
 * The shape, exactly as ruled:
 * - A connector may name a VAULT credential instead of an env var.
 *   The executor resolves the value at call time (connectors.ts);
 *   the value never enters the process environment, a log, or the
 *   model's view. This module only ever handles the credential's
 *   NAME.
 * - The pair flow registers the connector, binds the vault
 *   credential, allowlists a loopback host when the URL is
 *   loopback, tests the endpoint with the harmless initialize +
 *   tools/list call, and pins the connector to a profile - every
 *   step ledgered. A failed test or pin rolls the registration
 *   back: a pairing that did not prove itself leaves no enabled
 *   connector behind.
 * - The flow runs ONLY through the ONE approval gate (kind
 *   "pair", consequential, never auto-approved in any mode -
 *   pairing widens SAM's reach) or as a direct operator CLI act
 *   (`sam pair`), which is the owner's own hands.
 * - NEVER self-done, by design: minting the server-side key (the
 *   Bridge key is owner-only in the Bridge app) and depositing
 *   any secret into the vault (owner-only CLI). The owner
 *   deposits once; SAM does every step after.
 */

export interface PairSpec { name: string; url: string; vaultKey: string; profile: string }
export interface PairResult {
  connector: Connector;
  profile: string;
  pinned: boolean;
  tools: string[];
  approvedTools: string[];
}

const NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

export function pairProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; }
  finally { db.close(); }
}

/** Proposal-time validation: a pair card that cannot execute is
 *  never shown. Checks shape, a fresh connector name, a vault
 *  credential that EXISTS by name, a known profile, and a URL
 *  that is either a plain https URL (its host allowlist is
 *  enforced at registration, the addConnector rule) or a
 *  loopback http URL with an explicit port (the pairing flow
 *  itself records the loopback allowlist entry at execution). */
export function validatePairSpec(root: string, spec: PairSpec): PairSpec {
  const name = typeof spec?.name === "string" ? spec.name.trim() : "";
  const url = typeof spec?.url === "string" ? spec.url.trim() : "";
  const vaultKey = typeof spec?.vaultKey === "string" ? spec.vaultKey.trim() : "";
  const profile = typeof spec?.profile === "string" ? spec.profile.trim() : "";
  if (!NAME_RE.test(name)) throw new Error("Invalid pair name: a connector name is 1-64 letters, digits, spaces, or _ . -");
  if (connectors(root).some(c => c.name === name)) throw new Error("A connector named \"" + name + "\" already exists - pairing registers a new connector, it never rebinds an existing one");
  if (!VAULT_NAME_RE.test(vaultKey)) throw new Error("Invalid vault credential name in pair detail");
  if (!listVaultCredentials(root).some(c => c.name === vaultKey)) throw new Error("No vault credential named \"" + vaultKey + "\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one");
  const profiles = pairProfileNames(root);
  if (!profiles.includes(profile)) throw new Error("Unknown profile \"" + profile + "\" in pair detail. Valid profiles: " + profiles.join(", "));
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid pair URL"); }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("Pair URL must be a plain URL");
  const host = parsed.hostname.toLowerCase();
  if (isLoopbackHost(host)) {
    if (parsed.protocol !== "http:") throw new Error("A loopback pair URL must use plain http on this machine");
    if (!parsed.port) throw new Error("A loopback pair URL needs an explicit port");
  } else if (parsed.protocol !== "https:" || parsed.port) {
    throw new Error("A remote pair URL must be a plain HTTPS URL");
  }
  return { name, url, vaultKey, profile };
}

export function parsePairDetail(detail: string): PairSpec {
  let raw: unknown;
  try { raw = JSON.parse(detail); } catch { throw new Error("Invalid pair detail: expected JSON {name, url, vaultKey, profile}"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid pair detail: expected JSON {name, url, vaultKey, profile}");
  const s = raw as Record<string, unknown>;
  return {
    name: typeof s.name === "string" ? s.name : "",
    url: typeof s.url === "string" ? s.url : "",
    vaultKey: typeof s.vaultKey === "string" ? s.vaultKey : "",
    profile: typeof s.profile === "string" ? s.profile : "sam",
  };
}

export function validatePairDetail(root: string, detail: string): PairSpec {
  return validatePairSpec(root, parsePairDetail(detail));
}

export type PairTester = (connector: Connector, root: string) => Promise<{ tools: string[]; approved: string[] }>;

// Pair failure reasons carry their cause (gap found
// 2026-11-16, hourly run 20:04 EST): the rollback line below
// took e.message alone over testConnector's MCP exchange, so
// a pairing dying on transport ledgered the bare undici
// wrapper "fetch failed" and named nothing (DNS vs connect
// vs socket vs TLS indistinguishable, the real reason rides
// error.cause) - beside the vault-use line for the very same
// test, which since the 08:04 cure names the cause: the same
// death, two lines, one diagnosable and one not. The reason
// now composes through telegram.ts errorReason (the 04:04
// bridge seam, cured at delivery 05:04, probe 06:04, verify
// 07:04, vault-use 08:04, turn 09:04, queued message 11:04,
// background/loop 12:04, heartbeat jobs 13:04, subagent
// 14:04, action execution 15:04, coding 16:04,
// turn-failure-note 17:04, turn-retry 18:04, failover
// 19:04): causeless errors read byte-identically, a
// non-Error throw keeps the "unknown error" fallback, and
// the line still carries name + host + the vault
// credential's NAME only, never its value.
export function pairFailureReason(error: unknown): string {
  return error instanceof Error ? errorReason(error) : "unknown error";
}

export function pairFailedSummary(name: string, host: string, vaultKey: string, error: unknown): string {
  return "Pairing connector \"" + name + "\" at " + host + " using vault credential " + vaultKey +
    " failed and was rolled back: " + pairFailureReason(error);
}

// The ONE writer for the pair flow's success activity line, so
// the connection-events scorecard's parser below can never
// drift from the seam it counts. The shape is byte-identical
// to what pairConnector wrote inline before this writer
// existed.
export function pairedLedgerSummary(name: string, host: string, vaultKey: string, profile: string, pinned: boolean, approved: string[]): string {
  return "Paired connector \"" + name + "\" at " + host + " using vault credential " + vaultKey +
    " for profile " + profile + (pinned ? " (pinned)" : " (core profile - no pin row)") +
    " - " + approved.length + " approved read-only tool(s): " + (approved.join(", ") || "none");
}

/** The pair flow itself. The tester is injectable for tests; the
 *  real one is testConnector - initialize + tools/list, the
 *  harmless list call, which also ledgers the vault use. */
export async function pairConnector(
  root: string,
  actor: string,
  spec: PairSpec,
  opts: { test?: PairTester } = {},
): Promise<PairResult> {
  const clean = validatePairSpec(root, spec);
  const host = new URL(clean.url).hostname.toLowerCase();
  if (isLoopbackHost(host)) allowlistPairHost(root, host);
  const connector = addConnectorVault(root, clean.name, clean.url, clean.vaultKey);
  try {
    const tested = await (opts.test ?? (async (c: Connector, r: string) => {
      const t = await testConnector(c, r);
      return { tools: t.tools, approved: t.approved };
    }))(connector, root);
    // The registration seeded the record with the whole
    // read-only ceiling; the test just proved which of those
    // tools this endpoint actually advertises and approves,
    // so the stored record narrows to the connector's own
    // approved set. Anything reading the record back (the
    // Mission Status wall above all) then reports this
    // connector's count, not the ceiling's size. Call-time
    // authorization already intersects the ceiling, this set,
    // and the server's advertised tools, so narrowing to the
    // pair-time approved set cannot widen or break a call.
    const narrowed = updateConnector(root, connector.id, { allowedTools: [...tested.approved] }) ?? connector;
    let pinned = false;
    if (clean.profile !== "sam") {
      const db = new ChatStore(root);
      try {
        const updated = db.setAgentConnector(clean.profile, connector.id);
        if (!updated) throw new Error("Profile \"" + clean.profile + "\" no longer exists - the pairing was rolled back");
        pinned = true;
      } finally { db.close(); }
    }
    recordActivity(root, actor, "connector-paired",
      pairedLedgerSummary(clean.name, host, clean.vaultKey, clean.profile, pinned, tested.approved));
    return { connector: narrowed, profile: clean.profile, pinned, tools: tested.tools, approvedTools: tested.approved };
  } catch (e) {
    removeConnector(root, connector.id);
    recordActivity(root, actor, "connector-pair-failed",
      pairFailedSummary(clean.name, host, clean.vaultKey, e));
    throw e;
  }
}

// The connection-events scorecard (2026-11-20, the
// measured-proof series, census-finish sprint): four ledger
// classes record how SAM's connections and identity-level
// configuration came to be - connector-paired (a self-pairing
// proved itself against a live endpoint), engine-provider (the
// owner picked the coding-engine provider), engine-connected
// (the engine route was verified and marked), and approval-mode
// (the owner set the gate's mode) - one line per act, in fixed
// shapes, since each seam landed, but the classes were never
// folded, so how SAM came to be connected the way he is was
// invisible in aggregate. Every act here is an operator or
// owner act, so the verdict is attention only when a line is
// unparseable, else clear - a shape nobody can count is the
// news. This text folds the four classes to counts only, on
// ONE line: the paired count, the summed approved read-only
// tools across pairings, the provider-selection, engine-
// connection, and approval-mode counts, and the total. No
// stamp, no actor, no connector name, no host, no credential
// name, no profile, no tool name, and no verbatim summary
// enters the text - a credential NAME is still a pointer at a
// secret and never surfaces. A pure read: it creates nothing,
// pairs nothing, connects nothing, and sets no mode - the
// seams themselves are untouched.
export function parsePairedSummary(summary: string): { approved: number } | null {
  const m = /^Paired connector ".+" at \S+ using vault credential [a-z0-9][a-z0-9-]* for profile .+ \((?:pinned|core profile - no pin row)\) - (\d+) approved read-only tool\(s\): .+$/.exec(summary);
  if (!m) return null;
  return { approved: Number(m[1]) };
}

export function parseEngineProviderSummary(summary: string): Record<string, never> | null {
  if (!/^.+ selected as the coding-engine provider \(config choice; no connection was recorded or removed by this act\)$/.test(summary)) return null;
  return {};
}

export function parseEngineConnectedSummary(summary: string): Record<string, never> | null {
  if (!/^.+ connected as the coding-engine route via CLI reuse \(auth verified by `.+`; SAM stored only a route marker in the engine connection store, no credentials\)$/.test(summary)) return null;
  return {};
}

export function parseApprovalModeSummary(summary: string): { mode: string } | null {
  const m = /^Approval mode set to (manual|smart|off)(?: \(auto: .+\))?$/.exec(summary);
  if (!m) return null;
  return { mode: m[1] };
}

export function connectionScorecardText(root: string): string {
  const pairedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "connector-paired" });
  const providerLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-provider" });
  const connectedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-connected" });
  const modeLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "approval-mode" });
  let paired = 0;
  let approvedTools = 0;
  let providerSelected = 0;
  let engineConnected = 0;
  let approvalModeSet = 0;
  let unparseable = 0;
  for (const line of pairedLines) {
    const parsed = parsePairedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    paired += 1;
    approvedTools += parsed.approved;
  }
  for (const line of providerLines) {
    if (!parseEngineProviderSummary(line.summary)) { unparseable += 1; continue; }
    providerSelected += 1;
  }
  for (const line of connectedLines) {
    if (!parseEngineConnectedSummary(line.summary)) { unparseable += 1; continue; }
    engineConnected += 1;
  }
  for (const line of modeLines) {
    if (!parseApprovalModeSummary(line.summary)) { unparseable += 1; continue; }
    approvalModeSet += 1;
  }
  const total = pairedLines.length + providerLines.length + connectedLines.length + modeLines.length;
  const parts: string[] = [];
  parts.push("Connection events: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(paired) + " paired");
  parts.push(String(approvedTools) + " approved tools");
  parts.push(String(providerSelected) + " provider selected");
  parts.push(String(engineConnected) + " engine connected");
  parts.push(String(approvalModeSet) + " approval mode set");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

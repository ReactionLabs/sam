import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import {
  addConnectorVault, allowlistPairHost, connectors, isLoopbackHost,
  removeConnector, testConnector, updateConnector, type Connector,
} from "./connectors.js";
import { vaultCredentialBlocker } from "./vault.js";
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

function normalizePairProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The ONE source carrying the pair door's profile refusal
 *  text (per-field audit, 2026-11-25): validatePairSpec
 *  checked the pair detail's profile against the registry
 *  inline and refused with the bare list - a folded name
 *  ("Second Shift" for "second-shift") got no correction,
 *  while every sibling profile door names the correction
 *  when exactly one registered profile matches folded.
 *  pairProfileBlocker carries the refusal text (valid
 *  profiles listed, fold correction when exactly one
 *  matches); validatePairSpec throws it, so the ONE gate's
 *  proposal validation, the gate's executor, and the
 *  operator CLI `sam pair` door all refuse in the same
 *  words before anything is registered, bound, or pinned. */
export function pairProfileBlocker(root: string, profile: string): string | null {
  const names = pairProfileNames(root);
  if (names.includes(profile)) return null;
  const target = normalizePairProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizePairProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in pair detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
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
  const vaultBlocker = vaultCredentialBlocker(root, vaultKey);
  if (vaultBlocker) throw new Error(vaultBlocker);
  const profileBlocker = pairProfileBlocker(root, profile);
  if (profileBlocker) throw new Error(profileBlocker);
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

// The ONE writer for the connector-paired activity line,
// so the config-acts scorecard's parser can never drift
// from the seam it counts. Its shape is byte-identical to
// what pairConnector wrote inline before this writer
// existed. The shape carries the connector's name, host,
// vault credential NAME, profile, and approved tool names;
// a fold counts them and never prints them.
export function connectorPairedLedgerSummary(name: string, host: string, vaultKey: string, profile: string, pinned: boolean, approved: string[]): string {
  return "Paired connector \"" + name + "\" at " + host + " using vault credential " + vaultKey +
    " for profile " + profile + (pinned ? " (pinned)" : " (core profile - no pin row)") +
    " - " + approved.length + " approved read-only tool(s): " + (approved.join(", ") || "none");
}

export function pairFailedSummary(name: string, host: string, vaultKey: string, error: unknown): string {
  return "Pairing connector \"" + name + "\" at " + host + " using vault credential " + vaultKey +
    " failed and was rolled back: " + pairFailureReason(error);
}

// The connector pair failed history scorecard (2026-11-23, the
// measured-proof series): pairConnector's rollback ledgers every
// failed pairing as a "connector-pair-failed" line through the
// ONE writer above (pairFailedSummary, fixed shape "Pairing
// connector \"<name>\" at <host> using vault credential
// <vaultKey> failed and was rolled back: <reason>", actor the
// acting profile) - and while self-work's classifyDefect labels
// single lines and the success side carries its own fold (the
// config-acts scorecard over "connector-paired"), no surface
// folds this kind, so a pairing endpoint or vault binding that
// dies on every attempt - the self-pairing flow is how SAM
// gains new reach, and every failure rolls back fully, leaving
// no enabled connector behind - can fail repeatedly with
// nothing counting the class in aggregate. Every failure line
// is by construction a pairing that did not complete, so the
// verdict is attention when any failure was ever recorded or
// any line is unparseable, else clear. This parser is strict:
// only the fixed shape parses (the name is 1-64 chars of the
// NAME_RE alphabet in quotes, the host is a single spaceless
// token, the vault credential name matches VAULT_NAME_RE), and
// a non-empty reason is required and consumed, never printed -
// a reason can carry a transport cause and never surfaces here,
// and no connector name, host, or vault credential name ever
// enters the fold (distinct values surface as numbers only).
// A line from any other kind never parses. A pure read: it
// creates nothing, updates nothing, and pairs nothing - the
// pair seam itself is untouched.
export function parsePairFailedSummary(summary: string): { name: string; host: string; vaultKey: string } | null {
  const m = /^Pairing connector "([A-Za-z0-9 _.\-]{1,64})" at (\S+) using vault credential ([a-z0-9][a-z0-9-]{0,63}) failed and was rolled back: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[4] ?? "").trim()) return null;
  return { name: m[1] ?? "", host: m[2] ?? "", vaultKey: m[3] ?? "" };
}

export function connectorPairFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "connector-pair-failed" });
  let failed = 0;
  let unparseable = 0;
  const names = new Set<string>();
  const hosts = new Set<string>();
  const vaultKeys = new Set<string>();
  for (const line of lines) {
    const parsed = parsePairFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      names.add(parsed.name);
      hosts.add(parsed.host);
      vaultKeys.add(parsed.vaultKey);
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Connector pair failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(names.size) + " distinct connectors");
  parts.push(String(hosts.size) + " distinct hosts");
  parts.push(String(vaultKeys.size) + " distinct vault credentials");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
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
      connectorPairedLedgerSummary(clean.name, host, clean.vaultKey, clean.profile, pinned, tested.approved));
    return { connector: narrowed, profile: clean.profile, pinned, tools: tested.tools, approvedTools: tested.approved };
  } catch (e) {
    removeConnector(root, connector.id);
    recordActivity(root, actor, "connector-pair-failed",
      pairFailedSummary(clean.name, host, clean.vaultKey, e));
    throw e;
  }
}

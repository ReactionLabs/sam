import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import {
  addConnectorVault, allowlistPairHost, connectors, isLoopbackHost,
  removeConnector, testConnector, type Connector,
} from "./connectors.js";
import { listVaultCredentials, VAULT_NAME_RE } from "./vault.js";

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
      "Paired connector \"" + clean.name + "\" at " + host + " using vault credential " + clean.vaultKey +
      " for profile " + clean.profile + (pinned ? " (pinned)" : " (core profile - no pin row)") +
      " - " + tested.approved.length + " approved read-only tool(s): " + (tested.approved.join(", ") || "none"));
    return { connector, profile: clean.profile, pinned, tools: tested.tools, approvedTools: tested.approved };
  } catch (e) {
    removeConnector(root, connector.id);
    recordActivity(root, actor, "connector-pair-failed",
      "Pairing connector \"" + clean.name + "\" at " + host + " using vault credential " + clean.vaultKey +
      " failed and was rolled back: " + (e instanceof Error ? e.message : "unknown error"));
    throw e;
  }
}

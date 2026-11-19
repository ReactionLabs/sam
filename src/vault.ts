import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";

/**
 * The SAM VAULT (Dip ruling 2026-11-12 09:13 EST): an owner-only
 * store for the few keys SAM's hands may need, specced before
 * code per the ruling.
 *
 * CUSTODY: the vault lives OUTSIDE the SAM home and outside .sam
 * (the vault directory sits beside the workspace root, or at
 * SAM_VAULT_DIR when the operator sets one), so the P9 backup -
 * which snapshots .sam generically - never carries a secret off
 * the box, and the confined workspace readers can never reach a
 * value. The directory is 0700 and the store 0600. Deposit is an
 * operator CLI act only: the value arrives from an env var, a
 * file, or stdin - never argv, never chat. No surface returns a
 * value: lists, status, and the overview carry metadata only,
 * and there is no chat tool for the vault at all.
 *
 * INJECTION: SAM's hands reference a credential by NAME only.
 * The first consumer is git-clone: for an http(s) clone whose
 * hostname matches a credential's declared hosts, the executor
 * (code.ts) adds GIT_ASKPASS - a static script in the vault
 * directory that contains no secret - plus the value in one env
 * var on the child process alone. The second consumer is the
 * gated git-push executor (git-work.ts): the same host-matched
 * injection into the push child alone, after an owner approval.
 * The third consumer is a vault-bound MCP connector
 * (connectors.ts, SELF-PAIRING): the executor resolves the value
 * at call time into the Authorization header alone.
 * The value never enters argv, a tool result, or the ledger.
 * Credentials with no declared hosts never auto-inject; they
 * wait for a named consumer.
 *
 * AUDIT: every deposit, removal, and use writes one activity
 * line (vault-set / vault-remove / vault-use) carrying the
 * name, purpose, and outcome - never the value.
 */

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_VALUE_CHARS = 8192;
const MAX_CREDENTIALS = 64;

/** The env var the injected value rides into the child process
 *  on. Named here so the askpass script and the executor can
 *  never disagree about it. The script itself holds no secret. */
export const VAULT_CREDENTIAL_ENV = "SAM_VAULT_CREDENTIAL";
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  "# SAM vault askpass: prints the username git expects for a",
  "# token credential, or the credential the executor injected",
  "# via " + VAULT_CREDENTIAL_ENV + ". This file holds no secret.",
  "case \"$1\" in",
  "  *[Uu]sername*) printf '%s' \"x-access-token\" ;;",
  "  *) printf '%s' \"$" + VAULT_CREDENTIAL_ENV + "\" ;;",
  "esac",
  "",
].join("\n");

export interface VaultCredential {
  name: string;
  value: string;
  purpose: string;
  hosts: string[];
  createdAt: string;
  updatedAt: string;
}

/** What every surface may see: the credential's metadata, never
 *  its value. */
export interface VaultCredentialView {
  name: string;
  purpose: string;
  hosts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VaultStatus {
  dir: string;
  exists: boolean;
  credentials: VaultCredentialView[];
}

export function vaultDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.SAM_VAULT_DIR === "string" ? env.SAM_VAULT_DIR.trim() : "";
  if (override) {
    if (!isAbsolute(override)) throw new Error("SAM_VAULT_DIR must be an absolute path");
    return override;
  }
  return join(dirname(resolve(root)), ".sam-vault");
}

function vaultDbPath(root: string, env?: NodeJS.ProcessEnv): string {
  return join(vaultDir(root, env), "vault.db");
}

function viewOf(c: VaultCredential): VaultCredentialView {
  return { name: c.name, purpose: c.purpose, hosts: [...c.hosts], createdAt: c.createdAt, updatedAt: c.updatedAt };
}

function parseCredential(data: unknown): VaultCredential | null {
  if (!data || typeof data !== "object") return null;
  const c = data as Record<string, unknown>;
  if (typeof c.name !== "string" || !VAULT_NAME_RE.test(c.name)) return null;
  if (typeof c.value !== "string" || c.value.length === 0) return null;
  return {
    name: c.name,
    value: c.value,
    purpose: typeof c.purpose === "string" ? c.purpose : "",
    hosts: Array.isArray(c.hosts) ? c.hosts.filter((h): h is string => typeof h === "string") : [],
    createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
  };
}

function openVault(root: string, create: boolean, env?: NodeJS.ProcessEnv): Database.Database | null {
  const dir = vaultDir(root, env);
  const file = vaultDbPath(root, env);
  if (!existsSync(file)) {
    if (!create) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const db = openDatabase(file);
  db.exec("CREATE TABLE IF NOT EXISTS vault_credentials (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
  if (create) tightenVaultFiles(root, env);
  return db;
}

/** The custody contract in permissions: the directory admits
 *  only its owner and the store files are owner-read/write
 *  only. Best effort on platforms without POSIX modes. */
function tightenVaultFiles(root: string, env?: NodeJS.ProcessEnv): void {
  const dir = vaultDir(root, env);
  try { chmodSync(dir, 0o700); } catch { /* non-POSIX platform */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = vaultDbPath(root, env) + suffix;
    try { if (existsSync(file)) chmodSync(file, 0o600); } catch { /* non-POSIX platform */ }
  }
}

function readAll(db: Database.Database): VaultCredential[] {
  const rows = db.prepare("SELECT data FROM vault_credentials ORDER BY rowid").all() as { data: string }[];
  const out: VaultCredential[] = [];
  for (const row of rows) {
    try { const c = parseCredential(JSON.parse(row.data)); if (c) out.push(c); } catch { /* a torn row reads as absent, never as a value */ }
  }
  return out;
}

export function validateVaultName(name: string): string {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name)) {
    throw new Error("Vault credential name must be a lowercase slug (letters, digits, hyphens; at most 64 characters)");
  }
  return name;
}

export function validateVaultHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of hosts) {
    const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!HOST_RE.test(host)) throw new Error("Vault hosts must be bare hostnames (for example github.com) - no scheme, port, or path: " + String(raw));
    if (!out.includes(host)) out.push(host);
  }
  if (out.length > 8) throw new Error("A vault credential may declare at most 8 hosts");
  return out;
}

/** The ONE writer for the vault-set ledger line. Every deposit
 *  or replacement composes its audit line here, so the shape
 *  the vault scorecard parses is the shape this function
 *  writes - name, stored/replaced, hosts, purpose; never the
 *  value. */
export function vaultSetLedgerSummary(name: string, replaced: boolean, hosts: readonly string[], purpose: string): string {
  return "Vault credential " + name + " " + (replaced ? "replaced" : "stored") +
    (hosts.length ? " for hosts " + hosts.join(", ") : " (no hosts - named consumers only)") +
    (purpose ? " - " + purpose : "");
}

/** The ONE writer for the vault-remove ledger line. */
export function vaultRemoveLedgerSummary(name: string): string {
  return "Vault credential " + name + " removed";
}

/** The ONE writer for a connector call's vault-use ledger line
 *  (connectors.ts rides it): the credential name, the connector,
 *  the call's purpose, and the outcome - never the value. */
export function vaultConnectorUseLedgerSummary(name: string, connector: string, purpose: string, outcome: string): string {
  return "Vault credential " + name + " used for connector \"" + connector + "\" (" + purpose + ") - " + outcome;
}

/** The ONE writer for a git-clone injection's vault-use ledger
 *  line (code.ts rides it, through its boundedLedger cap). */
export function vaultCloneUseLedgerSummary(name: string, host: string, status: string): string {
  return "Vault credential " + name + " injected for git-clone of " + host + ": " + status;
}

/** The ONE writer for a git-push injection's vault-use ledger
 *  line (git-work.ts rides it). */
export function vaultPushUseLedgerSummary(name: string, branch: string, host: string, status: string): string {
  return "Vault credential " + name + " injected for git-push of " + branch + " to " + host + ": " + status;
}

/** Deposit or replace a credential. Operator act only - the CLI
 *  is the sole caller; the value arrives out of band and is
 *  never printed, returned, or ledgered. */
export function setVaultCredential(
  root: string,
  actor: string,
  name: string,
  value: string,
  opts: { purpose?: string; hosts?: readonly string[] } = {},
): VaultCredentialView {
  validateVaultName(name);
  if (typeof value !== "string" || value.length === 0) throw new Error("Vault credential value must not be empty");
  if (value.length > MAX_VALUE_CHARS) throw new Error("Vault credential value exceeds " + MAX_VALUE_CHARS + " characters");
  if (/[\0\r\n]/.test(value)) throw new Error("Vault credential value must be a single line with no NUL bytes");
  const hosts = validateVaultHosts(opts.hosts ?? []);
  const purpose = typeof opts.purpose === "string" ? opts.purpose.slice(0, 200) : "";
  const db = openVault(root, true);
  if (!db) throw new Error("Vault store could not be opened");
  try {
    const existing = readAll(db).find(c => c.name === name) ?? null;
    if (!existing && readAll(db).length >= MAX_CREDENTIALS) throw new Error("The vault holds at most " + MAX_CREDENTIALS + " credentials");
    const now = new Date().toISOString();
    const record: VaultCredential = {
      name, value, purpose, hosts,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    db.prepare("INSERT INTO vault_credentials (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data")
      .run(name, JSON.stringify(record));
    tightenVaultFiles(root);
    recordActivity(root, actor, "vault-set",
      vaultSetLedgerSummary(name, !!existing, hosts, purpose));
    return viewOf(record);
  } finally { db.close(); }
}

/** Remove a credential. Returns false when no such credential
 *  exists (and writes nothing). */
export function removeVaultCredential(root: string, actor: string, name: string): boolean {
  validateVaultName(name);
  const db = openVault(root, false);
  if (!db) return false;
  try {
    const info = db.prepare("DELETE FROM vault_credentials WHERE name = ?").run(name);
    if (Number(info.changes) === 0) return false;
    tightenVaultFiles(root);
    recordActivity(root, actor, "vault-remove", vaultRemoveLedgerSummary(name));
    return true;
  } finally { db.close(); }
}

/** Every credential's metadata. A pure read on an install with
 *  no vault creates nothing - not even the directory. */
export function listVaultCredentials(root: string): VaultCredentialView[] {
  const db = openVault(root, false);
  if (!db) return [];
  try { return readAll(db).map(viewOf); } finally { db.close(); }
}

export function vaultStatus(root: string, env: NodeJS.ProcessEnv = process.env): VaultStatus {
  return { dir: vaultDir(root, env), exists: existsSync(vaultDbPath(root, env)), credentials: listVaultCredentials(root) };
}

/** EXECUTOR-ONLY: the one door to a value. Its callers are the
 *  injection paths in code.ts - never a CLI read, never a chat
 *  tool, never a status surface. The value it returns goes into
 *  a child process env and nowhere else. */
export function getVaultCredentialValue(root: string, name: string): string | null {
  const db = openVault(root, false);
  if (!db) return null;
  try { return readAll(db).find(c => c.name === name)?.value ?? null; } finally { db.close(); }
}

/** Resolve the credential a clone of this URL may use: http(s)
 *  only (askpass is an HTTPS mechanism - SSH clones take no
 *  vault credential), hostname must be one of the credential's
 *  declared hosts, first match in deposit order. */
export function vaultCredentialForUrl(root: string, url: string): { name: string; value: string; purpose: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  const db = openVault(root, false);
  if (!db) return null;
  try {
    const match = readAll(db).find(c => c.hosts.includes(host));
    return match ? { name: match.name, value: match.value, purpose: match.purpose } : null;
  } finally { db.close(); }
}

// The vault scorecard (2026-11-19, the measured-proof
// series): the vault's audit classes (vault-set / vault-remove
// / vault-use) have ledgered in the ONE writers' fixed shapes
// since the vault landed, but the classes were never folded,
// so how many deposits SAM holds, how often a credential is
// actually spent, on which surface, and whether any spend
// ever failed was invisible in aggregate - until 2026-11-19
// the classes held no real credential at all, and the day the
// first one landed (the Second Shift operator key) it was
// spent within the hour. Every line is by construction an
// audit record of custody, so the verdict is attention only
// when a use failed or a line is unparseable, else clear - a
// deposit or removal is an operator act, a failed spend is
// the news. This text folds the three classes to counts only,
// on ONE line: stored / replaced / removed, uses split ok /
// failed and per surface (connector / git-clone / git-push),
// the distinct-credential count as a number only, and the
// total. No stamp, no actor, no credential name, no host, and
// no purpose enters the text - a vault fold that printed
// names would leak the custody map it exists to watch, and
// the value never enters the ledger at all. A pure read: it
// creates nothing, opens no credential, and spends nothing -
// the vault store and the use seams are untouched.
export function parseVaultSetSummary(summary: string): { name: string; replaced: boolean } | null {
  const m = /^Vault credential ([a-z0-9][a-z0-9-]{0,63}) (stored|replaced) (?:for hosts .+|\(no hosts - named consumers only\))/.exec(summary);
  if (!m) return null;
  return { name: m[1], replaced: m[2] === "replaced" };
}

export function parseVaultRemoveSummary(summary: string): { name: string } | null {
  const m = /^Vault credential ([a-z0-9][a-z0-9-]{0,63}) removed$/.exec(summary);
  if (!m) return null;
  return { name: m[1] };
}

export type VaultUseSurface = "connector" | "git-clone" | "git-push";
export function parseVaultUseSummary(summary: string): { name: string; surface: VaultUseSurface; ok: boolean } | null {
  const conn = /^Vault credential ([a-z0-9][a-z0-9-]{0,63}) used for connector "[^"]*" \(.*\) - (ok|failed: .*)$/.exec(summary);
  if (conn) return { name: conn[1], surface: "connector", ok: conn[2] === "ok" };
  const clone = /^Vault credential ([a-z0-9][a-z0-9-]{0,63}) injected for git-clone of \S+: (ok|exit .+)$/.exec(summary);
  if (clone) return { name: clone[1], surface: "git-clone", ok: clone[2] === "ok" };
  const push = /^Vault credential ([a-z0-9][a-z0-9-]{0,63}) injected for git-push of \S+ to \S+: (ok|exit .+)$/.exec(summary);
  if (push) return { name: push[1], surface: "git-push", ok: push[2] === "ok" };
  return null;
}

export function vaultScorecardText(root: string): string {
  const setLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "vault-set" });
  const removeLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "vault-remove" });
  const useLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "vault-use" });
  let stored = 0;
  let replaced = 0;
  let removed = 0;
  let usesOk = 0;
  let usesFailed = 0;
  let connector = 0;
  let gitClone = 0;
  let gitPush = 0;
  let unparseable = 0;
  const names = new Set<string>();
  for (const line of setLines) {
    const parsed = parseVaultSetSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    names.add(parsed.name);
    if (parsed.replaced) replaced += 1; else stored += 1;
  }
  for (const line of removeLines) {
    const parsed = parseVaultRemoveSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    names.add(parsed.name);
    removed += 1;
  }
  for (const line of useLines) {
    const parsed = parseVaultUseSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    names.add(parsed.name);
    if (parsed.ok) usesOk += 1; else usesFailed += 1;
    if (parsed.surface === "connector") connector += 1;
    else if (parsed.surface === "git-clone") gitClone += 1;
    else gitPush += 1;
  }
  const uses = usesOk + usesFailed;
  const total = setLines.length + removeLines.length + useLines.length;
  const parts: string[] = [];
  parts.push("Vault: " + (usesFailed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(stored) + " stored");
  parts.push(String(replaced) + " replaced");
  parts.push(String(removed) + " removed");
  parts.push(String(uses) + " uses (ok " + String(usesOk) + ", failed " + String(usesFailed) + ")");
  parts.push("connector " + String(connector));
  parts.push("git-clone " + String(gitClone));
  parts.push("git-push " + String(gitPush));
  parts.push(String(names.size) + " distinct credentials");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

/** The askpass script git invokes for HTTPS prompts. Static
 *  content (no secret), written into the vault directory at
 *  0700 on first injection use. */
export function vaultAskpassPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = vaultDir(root, env);
  const file = join(dir, "askpass.sh");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, ASKPASS_SCRIPT, { mode: 0o700 });
  }
  try { chmodSync(file, 0o700); } catch { /* non-POSIX platform */ }
  return file;
}

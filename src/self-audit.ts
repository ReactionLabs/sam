import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { auditStoreTouch } from "./audit-store-failure.js";
import { listActions } from "./actions.js";
import { loadApprovalPolicy, neverListSummary } from "./approval-policy.js";
import { authStatus } from "./auth-status.js";
import { channels } from "./channels.js";
import { codeCommandNames, codeSummary } from "./code.js";
import { connectors, connectorCredentialPresent } from "./connectors.js";
import { engineStatus } from "./engine.js";
import { engineConnectStatus, engineProviderDef } from "./engine-connect.js";
import { heartbeatJobs } from "./heartbeat.js";
import { minis } from "./minis.js";
import { OWN_TOOLS } from "./own-tools.js";
import { scriptCommandNames } from "./schedule.js";
import { sensesStatus } from "./senses.js";
import { discoverSkills, skillAllowlists } from "./skills.js";
import { CORE_OWN_TOOLS, toolNameOf } from "./tool-tiers.js";

/**
 * The capability self-audit (SELF-WORK program, Dip 2026-11-11,
 * step 0): before SAM picks defects to fix in himself, he
 * inventories what he actually is - his own tools, connectors,
 * code root, gates, engine, senses, skills, channels, and jobs -
 * and records what he can and cannot do, with the reason for
 * every cannot, so defect picks rest on a true map of himself
 * instead of a model's impression of itself.
 *
 * - DETERMINISTIC: the audit is assembled in code from the same
 *   status reads every other surface uses (the brief / curator
 *   precedent). No model call, no self-report: a capability is
 *   "can" only when the underlying door reads ready (a code root
 *   is designated, the engine binary is installed AND its route
 *   marker reads connected, the senses reader is installed, a
 *   connector is enabled with its credential env present).
 * - HONEST CANNOTS: every cannot names the act that would clear
 *   it and whose act it is (the operator designates the code
 *   root; signing Claude Code in is the operator's act). Two
 *   cannots are standing fences, not gaps: SAM never sends
 *   externally (drafts only, P12) and never edits his own gate,
 *   policy, or allowlist code (the SELF-WORK hard boundary -
 *   self-work on the approval machinery is owner-only, forever).
 * - RECORDED: a run persists to SQLite (.sam/self-audit.db, the
 *   singleton pattern - ONE row holding the audit's full JSON)
 *   and writes one self-audit activity line carrying counts
 *   only. A pure read (readSelfAudit) creates nothing. The
 *   record is what the self-work loop's later steps read; this
 *   module builds no loop, queue, or job of its own - "sam-self-
 *   audit" joins the Phase C script allowlist so a heartbeat
 *   job CAN refresh the map on a schedule when the operator or
 *   SAM installs one.
 */

export const SELF_AUDIT_SCRIPT = "sam-self-audit";

export interface CapabilityVerdict { capability: string; detail: string }
export interface SelfAudit {
  at: string;
  tools: { own: string[]; ownCount: number; core: string[]; scriptCommands: string[] };
  connectors: Array<{ name: string; enabled: boolean; credentialPresent: boolean; tools: number }>;
  channels: Array<{ name: string; kind: string; profile: string; owners: number; enabled: boolean }>;
  people: string[];
  code: { root: string | null; writes: number; commands: string[] };
  gates: { mode: string; autoKinds: string[]; neverList: number; pendingApprovals: number };
  engine: { installed: boolean; binary: string | null; connected: boolean; stale: boolean };
  senses: { installed: boolean; binary: string | null; senses: string[] };
  skills: { installed: string[]; allowlistedProfiles: number };
  jobs: { heartbeat: number; names: string[] };
  model: { healthy: boolean };
  can: CapabilityVerdict[];
  cannot: CapabilityVerdict[];
}

function auditPath(root: string) { return join(resolve(root), ".sam", "self-audit.json"); }
function auditDbPath(root: string) { return join(resolve(root), ".sam", "self-audit.db"); }

function parseAudit(data: unknown): SelfAudit | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<SelfAudit>;
  if (typeof value.at !== "string" || !value.at) return null;
  if (!Array.isArray(value.can) || !Array.isArray(value.cannot)) return null;
  return value as SelfAudit;
}
function openAuditStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(auditDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS self_audit (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyAudit(db, root);
  return db;
}
function migrateLegacyAudit(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM self_audit WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = auditPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseAudit(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO self_audit (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function auditStoreExists(root: string): boolean {
  return existsSync(auditDbPath(root)) || existsSync(auditPath(root));
}

/** The recorded audit through the store's own shape, or null
 *  when no audit has ever run - and a read on an install with
 *  no store at all creates nothing. */
export function readSelfAudit(root: string): SelfAudit | null {
  if (!auditStoreExists(root)) return null;
  return auditStoreTouch(root, "self-audit", "read", () => readSelfAuditRecord(root));
}

function readSelfAuditRecord(root: string): SelfAudit | null {
  const db = openAuditStore(root);
  try {
    const row = db.prepare("SELECT data FROM self_audit WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseAudit(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function saveSelfAudit(root: string, audit: SelfAudit): void {
  auditStoreTouch(root, "self-audit", "write", () => {
    const db = openAuditStore(root);
    try {
      db.prepare("INSERT INTO self_audit (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(audit));
    } finally { db.close(); }
  });
}

/** Assemble the audit from the live doors. Deterministic, no
 *  model call; env is injectable so tests and the CLI read the
 *  same map the service would. */
export function buildSelfAudit(root: string, env: NodeJS.ProcessEnv = process.env): SelfAudit {
  const own = OWN_TOOLS.map(toolNameOf).filter(Boolean).sort();
  const conns = connectors(root).map(c => ({ name: c.name, enabled: c.enabled, credentialPresent: c.tokenEnv ? !!env[c.tokenEnv] : connectorCredentialPresent(root, c), tools: c.allowedTools.length }));
  const chans = channels(root).map(c => ({ name: c.name, kind: c.kind, profile: c.profile, owners: c.ownerIds.length, enabled: c.enabled }));
  const code = codeSummary(root);
  const policy = loadApprovalPolicy(root);
  const pending = listActions(root).filter(a => a.status === "pending").length;
  const engine = engineStatus(root, env);
  const connection = engineConnectStatus(root, env);
  const senses = sensesStatus(env);
  const skills = discoverSkills(root);
  const allowlists = skillAllowlists(root);
  const jobs = heartbeatJobs(root);
  const auth = authStatus(root, env);

  const can: CapabilityVerdict[] = [];
  const cannot: CapabilityVerdict[] = [];
  can.push({ capability: "chat, memory, and standing law", detail: String(own.length) + " own tools across persistent profile-scoped chats" });
  if (auth.healthy) can.push({ capability: "model turns", detail: "the chat route resolves a model with its key present" });
  else cannot.push({ capability: "model turns", detail: "the chat route does not resolve a working model/key - the operator checks 'sam models status'" });
  can.push({ capability: "propose gated actions", detail: "the ONE gate in " + policy.mode + " mode" + (policy.autoKinds.length ? " (smart-auto: " + policy.autoKinds.join(", ") + ")" : "") + "; the never-list (" + String(neverListSummary().length) + " patterns) binds in every mode" });
  for (const c of conns) {
    if (c.enabled && c.credentialPresent) can.push({ capability: "read through the " + c.name + " connector", detail: String(c.tools) + " read-only tools, credential present" });
    else cannot.push({ capability: "read through the " + c.name + " connector", detail: c.enabled ? "its credential env is not present in this process" : "the connector is disabled in the registry" });
  }
  if (!conns.length) cannot.push({ capability: "connector reads", detail: "no connector is registered - a scoped profile's world is its connector pin, registered by the operator" });
  if (code.root) can.push({ capability: "coder hands in the code root", detail: code.root + " - write/edit plus the named verify commands (" + codeCommandNames().join(", ") + ")" });
  else cannot.push({ capability: "coder hands", detail: "no code root is designated - designation is the operator's act (sam code set-root), never SAM's" });
  if (engine.installed && connection.connected) can.push({ capability: "managed coding-engine runs", detail: engineProviderDef(connection.provider).label + " (the selected provider) installed and connected by CLI reuse; runs stay gated, branched, verified, and reviewed" });
  else cannot.push({ capability: "managed coding-engine runs", detail: !engine.installed ? "the " + engineProviderDef(connection.provider).label + " binary (the selected provider) is not installed on this machine - installing it is the operator's act" : engineProviderDef(connection.provider).label + " is installed but SAM's route marker reads " + (connection.stale ? "stale" : "not connected") + " - signing in and 'sam engine connect' are the operator's acts" });
  if (senses.installed) can.push({ capability: "read the owner's mail and calendar (core profile only)", detail: "the senses reader is installed; read-only by construction" });
  else cannot.push({ capability: "read the owner's mail and calendar", detail: "the senses reader (gog) is not installed - installing and authorizing it is the operator's act" });
  if (skills.length) can.push({ capability: "follow installed skills", detail: skills.map(s => s.name).join(", ") });
  else cannot.push({ capability: "follow installed skills", detail: "no skill is installed in this workspace" });
  if (jobs.length) can.push({ capability: "heartbeat jobs", detail: String(jobs.length) + " job(s): " + jobs.map(j => j.name).join(", ") });
  else cannot.push({ capability: "heartbeat jobs", detail: "no heartbeat job is installed - jobs are proposed through the gate or installed by the operator" });
  if (chans.length) can.push({ capability: "channel delivery", detail: chans.map(c => c.name + " -> " + c.profile).join(", ") });
  else cannot.push({ capability: "channel delivery", detail: "no channel is registered" });
  cannot.push({ capability: "send anything externally", detail: "standing fence (P12): no send surface exists - drafts are records the owner sends themselves" });
  cannot.push({ capability: "edit SAM's own gate, policy, or allowlist code", detail: "the SELF-WORK hard boundary: self-work on the approval machinery is owner-only, forever" });
  cannot.push({ capability: "arbitrary shell, money movement, or trading", detail: "standing fences: commands are named allowlist entries only, and no money or trade surface exists" });

  return {
    at: new Date().toISOString(),
    tools: { own, ownCount: own.length, core: [...CORE_OWN_TOOLS], scriptCommands: scriptCommandNames() },
    connectors: conns,
    channels: chans,
    people: minis(root).map(m => m.name),
    code: { root: code.root, writes: code.writes, commands: codeCommandNames() },
    gates: { mode: policy.mode, autoKinds: policy.autoKinds, neverList: neverListSummary().length, pendingApprovals: pending },
    engine: { installed: engine.installed, binary: engine.binary, connected: connection.connected, stale: connection.stale },
    senses: { installed: senses.installed, binary: senses.binary, senses: senses.senses },
    skills: { installed: skills.map(s => s.name), allowlistedProfiles: Object.keys(allowlists).length },
    jobs: { heartbeat: jobs.length, names: jobs.map(j => j.name) },
    model: { healthy: auth.healthy },
    can, cannot,
  };
}

/** Run the audit: build it, record it (one UPSERT), and ledger
 *  one line carrying counts only. Returns the recorded audit. */
export function runSelfAudit(root: string, env: NodeJS.ProcessEnv = process.env): SelfAudit {
  const audit = buildSelfAudit(root, env);
  saveSelfAudit(root, audit);
  recordActivity(root, "sam", "self-audit", selfAuditLedgerSummary(audit.can.length, audit.cannot.length, audit.tools.ownCount, audit.code.root));
  return audit;
}

// The ONE writer for the self audit's activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. The shape is byte-identical to what runSelfAudit
// wrote inline before this writer existed.
export function selfAuditLedgerSummary(can: number, cannot: number, ownCount: number, codeRoot: string | null): string {
  return "Capability self-audit recorded: " + String(can) + " can, " + String(cannot) + " cannot, " + String(ownCount) + " own tools, code root " + (codeRoot ?? "none");
}

// The self audit history scorecard (2026-11-20, the
// measured-proof series): the audit's ledger class
// (self-audit) has ledgered one line per recorded run since
// the audit landed, but the class was never folded - the
// audit's own surfaces execute a run (self-audit run) or
// read the last one (self-audit show, over a singleton
// store holding ONE row), so how many runs ever recorded
// and how the capability map it records (the can and
// cannot counts, the own-tool count, and whether a code
// root was designated) has moved across runs were
// invisible as a trend; a capability gained and later lost
// would leave no daily surface remembering it happened.
// The verdict is attention only when a line is
// unparseable, else clear: the can and cannot counts are
// inventory, not alarms - the cannot list carries
// standing fences by design (no external sends, no gate
// edits, no arbitrary shell), so a nonzero cannot count
// is permanent and can never be the news; what the fold
// exists to keep is the map's movement. This text folds
// the class to counts only, on ONE line: runs, the latest
// can and cannot counts, the peak can count, the latest
// and peak own-tool counts, counts of runs with and
// without a designated code root, and the total. No
// stamp, no actor, no capability text, and no verbatim
// summary enters the text - and the code-root PATH the
// summary carries is counted as present or absent and
// never printed. A pure read: it creates nothing, runs
// no audit, and spends no model call - the audit seam
// itself is untouched.
export function parseSelfAuditSummary(summary: string): { can: number; cannot: number; ownCount: number; hasCodeRoot: boolean } | null {
  const m = /^Capability self-audit recorded: (\d+) can, (\d+) cannot, (\d+) own tools, code root (.+)$/.exec(summary);
  if (!m) return null;
  const root = m[4].trim();
  if (!root) return null;
  return { can: Number(m[1]), cannot: Number(m[2]), ownCount: Number(m[3]), hasCodeRoot: root !== "none" };
}

export function selfAuditHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "self-audit" });
  let runs = 0;
  let latestCan = 0;
  let latestCannot = 0;
  let peakCan = 0;
  let latestOwn = 0;
  let peakOwn = 0;
  let rootPresent = 0;
  let rootAbsent = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseSelfAuditSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    runs += 1;
    latestCan = parsed.can;
    latestCannot = parsed.cannot;
    if (parsed.can > peakCan) peakCan = parsed.can;
    latestOwn = parsed.ownCount;
    if (parsed.ownCount > peakOwn) peakOwn = parsed.ownCount;
    if (parsed.hasCodeRoot) rootPresent += 1;
    else rootAbsent += 1;
  }
  const parts: string[] = [];
  parts.push("Self audit history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(runs) + " runs");
  parts.push("latest " + String(latestCan) + " can");
  parts.push("latest " + String(latestCannot) + " cannot");
  parts.push("peak " + String(peakCan) + " can");
  parts.push("latest " + String(latestOwn) + " own tools");
  parts.push("peak " + String(peakOwn) + " own tools");
  parts.push("code root present " + String(rootPresent) + " / absent " + String(rootAbsent));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

/** The audit as plain text (the sam-self-audit script job's
 *  stdout shape): the map a person - or the self-work loop -
 *  reads. The text carries NO clock reading: it is P3-diffed
 *  as a script job's output, and the record's `at` stamp is
 *  an ISO date fact that would announce "changed" daily at
 *  an identical map (the eval battery's 2026-11-17 lesson).
 *  The recorded record keeps its stamp; the text keeps the
 *  verdicts and the inventory, which are the facts. */
export function selfAuditText(audit: SelfAudit): string {
  const lines: string[] = ["Capability self-audit"];
  lines.push("", "Can:");
  for (const c of audit.can) lines.push("- " + c.capability + ": " + c.detail);
  lines.push("", "Cannot:");
  for (const c of audit.cannot) lines.push("- " + c.capability + ": " + c.detail);
  lines.push("", "Inventory: " + String(audit.tools.ownCount) + " own tools; connectors " + (audit.connectors.map(c => c.name).join(", ") || "none") + "; channels " + (audit.channels.map(c => c.name).join(", ") || "none") + "; skills " + (audit.skills.installed.join(", ") || "none") + "; heartbeat jobs " + String(audit.jobs.heartbeat) + "; gate mode " + audit.gates.mode + ".");
  return lines.join("\n");
}

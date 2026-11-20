import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Approvals engine (Plan Phase D item 1 - lands BEFORE coder hands;
// the Hermes borrow recorded in the roadmap: named modes plus a
// fixed blocklist). This module is the policy layer of the ONE
// proposal gate (actions.ts). It decides HOW a proposal is decided;
// it never executes anything itself, and it never widens the
// executor allowlist - that stays Dip's ruling, untouched.
//
// MODES (stored in .sam/approval-policy.db, set ONLY by the
// operator through the CLI - a mode change is an owner act, never
// a model act, and it is activity-ledgered by the caller):
// - manual (the default, and the posture every install has had):
//   every proposal waits for an explicit owner decision.
// - smart: deterministic triage. A proposal auto-executes only
//   when its kind is on the owner's auto list AND its class is
//   internal. Consequential kinds can never be smart-approved,
//   even if listed - the set verb refuses them with the reason.
// - off: every proposal auto-executes - except the never-list,
//   which binds in every mode including this one.
// FAIL-CLOSED: a missing or corrupt policy file reads as manual
// with an empty auto list, an unknown kind classifies as
// consequential, and any doubt gates. Unattended contexts get no
// special trust: auto-execution is a posture the owner chose, and
// classification uncertainty always falls back to the gate.
//
// THE NEVER-LIST is a hardline blocklist of command-form payloads:
// rm -rf /, fork bombs, mkfs, dd onto a disk device, and piping a
// downloaded URL into a root shell. It is scanned at proposal time
// (a hit is refused outright - it is never shown as an approval
// card) and again at decision time (a legacy or tampered record
// can never execute one either). Patterns match COMMAND FORM, not
// discussion: a standing law that says "never run mkfs" is prose
// and passes; a payload that would run it does not.

export type ApprovalMode = "manual" | "smart" | "off";
export const APPROVAL_MODES: ApprovalMode[] = ["manual", "smart", "off"];
export interface ApprovalPolicy { mode: ApprovalMode; autoKinds: string[]; updatedAt: string | null }

export function defaultApprovalPolicy(): ApprovalPolicy {
  return { mode: "manual", autoKinds: [], updatedAt: null };
}
function policyFile(root: string): string { return join(resolve(root), ".sam", "approval-policy.json"); }
function policyDbFile(root: string): string { return join(resolve(root), ".sam", "approval-policy.db"); }

// State convergence (UNIFICATION item 4, twenty-seventh store):
// the approval policy is SQLite (.sam/approval-policy.db, the
// telegram-state singleton pattern), ONE row holding the policy's
// full JSON so the singleton keeps its exact shape. The old
// approval-policy.json was rewritten whole on every
// saveApprovalPolicy - a non-atomic writeFileSync by the operator
// CLI - while loadApprovalPolicy readers run in every process
// that consults the ONE gate: settleAutoApprovals in the
// dashboard, Telegram, and heartbeat processes, plus dashboard
// /api/status and the CLI overview. A torn write read fail-closed
// to manual, which is the safe direction but silently REVERTED
// the owner's chosen posture: a smart auto list vanished with no
// error anywhere, listed internal kinds stopped auto-executing,
// and an off posture silently became a gate again - the policy
// the owner set was simply gone until someone noticed. Here each
// save is a single-row UPSERT and connections carry a
// busy_timeout, so no reader in any process can ever see a torn
// policy. The migrated loader keeps the old fail-closed shape
// exactly: a missing, malformed, or invalid-mode policy reads as
// manual with an empty auto list. First open imports a legacy
// approval-policy.json (normalized through the old read shape:
// invalid auto kinds filtered, duplicates removed) and renames
// it approval-policy.json.migrated - imported, never deleted; a
// malformed file, a non-object payload, or an invalid mode
// imports nothing and is left in place. A pure read on an
// install with neither file creates nothing. The P9 backup
// snapshots every .sam/*.db generically, so the migrated store
// is carried with no backup change.
function parsePolicy(data: unknown): ApprovalPolicy | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = data as { mode?: unknown; autoKinds?: unknown; updatedAt?: unknown };
  if (!APPROVAL_MODES.includes(raw.mode as ApprovalMode)) return null;
  const autoKinds = Array.isArray(raw.autoKinds) ? raw.autoKinds.filter((k): k is string => typeof k === "string" && /^[a-z][a-z-]{0,31}$/.test(k)) : [];
  return { mode: raw.mode as ApprovalMode, autoKinds: [...new Set(autoKinds)], updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
}
function openPolicyStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(policyDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS approval_policy (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyPolicy(db, root);
  return db;
}
function migrateLegacyPolicy(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM approval_policy WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = policyFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const policy = parsePolicy(data);
  if (!policy) return;
  db.prepare("INSERT OR IGNORE INTO approval_policy (id, data) VALUES (1, ?)").run(JSON.stringify(policy));
  renameSync(file, file + ".migrated");
}
function policyStoreExists(root: string): boolean {
  return existsSync(policyDbFile(root)) || existsSync(policyFile(root));
}
function rowToPolicy(data: string): ApprovalPolicy {
  try { return parsePolicy(JSON.parse(data)) ?? defaultApprovalPolicy(); } catch { return defaultApprovalPolicy(); }
}

// Failure visibility (gap found 2026-11-14, hourly run
// 18:04 EST): the approval policy is the ONE gate's own
// posture - the mode and smart auto list that decide HOW
// every proposal is decided - and every touch opened its
// store raw. loadApprovalPolicy is the one read door
// (settleAutoApprovals in every process that consults the
// gate, dashboard /api/status, the self-audit, and the CLI
// mode view all ride it); saveApprovalPolicy is the
// operator CLI's write door. A dead approval-policy.db
// threw into whichever catch happened to wrap the call with
// the seam unnamed, and no approval-policy failure kind
// existed, so the class was uncountable - and the only
// alternative a caller could invent, folding a dead store
// to the manual default, would silently revert the owner's
// chosen posture, the exact torn-write defect the SQLite
// migration above was built to kill. Now the store's
// touches own their failure (the dashboard-config
// precedent, this store's closest sibling - a one-row
// singleton whose torn row payload parses forgiving to the
// default): a failed touch ledgers ONE approval-policy-
// failed line (phase read for loadApprovalPolicy, write
// for saveApprovalPolicy's UPSERT; actor sam; the verbatim
// reason collapsed and capped; never any policy content -
// the mode and auto list are the owner's gate posture, not
// failure data), tags the error, and rethrows exactly, so
// every caller's handling is unchanged and reads still
// fail closed (never folded as manual, which would hide a
// smart/off posture the owner set). saveApprovalPolicy's
// internal current-policy read rides the read door, so a
// dead store ledgers its one read line there and gains no
// second write line for the same touch. Validation errors
// (invalid mode, the smart-mode consequential-kind
// refusal) are not store failures and ledger nothing. An
// absent store still reads as the manual default with no
// line and creates nothing, a malformed legacy file still
// imports nothing silently, and a torn row payload still
// parses forgiving to manual - only the store touch is
// guarded.
export type ApprovalPolicyPhase = "read" | "write";

export function approvalPolicyFailureSummary(phase: ApprovalPolicyPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Approval policy " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a approval-policy-failed line carries (census sprint
 * 2026-11-17): recordApprovalPolicyFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function approvalPolicyFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordApprovalPolicyFailure(root: string, phase: ApprovalPolicyPhase, error: unknown): void {
  const reason = approvalPolicyFailureReason(error);
  recordActivity(root, "sam", "approval-policy-failed", approvalPolicyFailureSummary(phase, reason));
}

function tagApprovalPolicyLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { approvalPolicyLedgered?: boolean }).approvalPolicyLedgered = true;
  }
}

export function isApprovalPolicyLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { approvalPolicyLedgered?: boolean }).approvalPolicyLedgered === true;
}

function failApprovalPolicy(root: string, phase: ApprovalPolicyPhase, error: unknown): never {
  if (!isApprovalPolicyLedgered(error)) recordApprovalPolicyFailure(root, phase, error);
  tagApprovalPolicyLedgered(error);
  throw error;
}

// The store's read door: the full approval policy through the
// store's own shape, or the fail-closed default when none has
// ever been persisted - and a read on an install with no store
// at all creates nothing.
export function readApprovalPolicyStore(root: string): ApprovalPolicy {
  return loadApprovalPolicy(root);
}

export function loadApprovalPolicy(root: string): ApprovalPolicy {
  if (!policyStoreExists(root)) return defaultApprovalPolicy();
  let db: Database.Database;
  try { db = openPolicyStore(root); } catch (error) { failApprovalPolicy(root, "read", error); }
  try {
    const row = db!.prepare("SELECT data FROM approval_policy WHERE id = 1").get() as { data: string } | undefined;
    return row ? rowToPolicy(row.data) : defaultApprovalPolicy();
  } catch (error) { failApprovalPolicy(root, "read", error); }
  finally { db!.close(); }
}

export function saveApprovalPolicy(root: string, patch: { mode?: ApprovalMode; autoKinds?: string[] }): ApprovalPolicy {
  if (patch.mode !== undefined && !APPROVAL_MODES.includes(patch.mode)) throw new Error("Invalid approval mode \"" + patch.mode + "\". Modes: " + APPROVAL_MODES.join(", "));
  const current = loadApprovalPolicy(root);
  const next: ApprovalPolicy = {
    mode: patch.mode ?? current.mode,
    autoKinds: patch.autoKinds !== undefined ? [...new Set(patch.autoKinds)] : current.autoKinds,
    updatedAt: new Date().toISOString(),
  };
  // Smart mode's fence is enforced at set time, not discovered at
  // run time: a consequential kind on the auto list is refused here
  // with the reason, so the stored policy can never promise an
  // auto-approval the engine would have to break.
  if (next.mode === "smart") {
    const bad = next.autoKinds.filter(k => classifyProposal(k, null).risk !== "internal");
    if (bad.length) throw new Error("Smart mode cannot auto-approve consequential kind(s): " + bad.join(", ") + " - they always need the owner's decision. Remove them from the auto list, or use off mode if the owner truly means it.");
  }
  let db: Database.Database;
  try { db = openPolicyStore(root); } catch (error) { failApprovalPolicy(root, "write", error); }
  try {
    db!.prepare("INSERT INTO approval_policy (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(next));
  } catch (error) { failApprovalPolicy(root, "write", error); }
  finally { db!.close(); }
  return next;
}

// The ONE writer for the approval-mode activity line (the
// actions set-mode seam ledgers it), so the connection-events
// scorecard's parser (connector-pairing.ts) can never drift
// from the seam it counts. The shape is byte-identical to what
// the seam wrote inline before this writer existed.
export function approvalModeLedgerSummary(mode: ApprovalMode, autoKinds: string[]): string {
  return "Approval mode set to " + mode + (autoKinds.length ? " (auto: " + autoKinds.join(", ") + ")" : "");
}

// --- The hardline never-list -------------------------------------
export interface NeverHit { id: string; label: string }
const NEVER_PATTERNS: Array<{ id: string; label: string; pattern: RegExp }> = [
  {
    id: "rm-rf-root", label: "recursive force-delete of the filesystem root (rm -rf /)",
    // Command position (start, or after ; & | ` or a newline), rm with
    // recursive+force flags in any order, target exactly / or /*.
    pattern: /(?:^|[;&|`:]|\n)\s*rm\s+(?:-\S+\s+)*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\*|\s|$)|(?:^|[;&|`:]|\n)\s*rm\s+(?:-\S+\s+)*-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\*|\s|$)|\brm\b[^|;&\n]*--no-preserve-root/,
  },
  {
    id: "fork-bomb", label: "a fork bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|[A-Za-z_]\w*\s*\(\s*\)\s*\{\s*[A-Za-z_]\w*\s*\|\s*[A-Za-z_]\w*\s*&\s*\}/,
  },
  {
    id: "mkfs", label: "formatting a filesystem (mkfs)",
    pattern: /(?:^|[;&|`:]|\n)\s*(?:sudo\s+)?mkfs(?:\.[a-z0-9]+)?\b/,
  },
  {
    id: "dd-to-device", label: "raw disk write with dd onto a device (dd of=/dev/...)",
    pattern: /(?:^|[;&|`:]|\n)\s*(?:sudo\s+)?dd\s+[^|;&\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk\d)/,
  },
  {
    id: "pipe-to-root-shell", label: "piping a downloaded URL into a root shell (curl/wget | sudo sh)",
    pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|da|z)?sh\b/,
  },
];
export function neverListSummary(): Array<{ id: string; label: string }> {
  return NEVER_PATTERNS.map(p => ({ id: p.id, label: p.label }));
}
export function scanNeverList(text: string): NeverHit | null {
  const hay = text ?? "";
  for (const entry of NEVER_PATTERNS) if (entry.pattern.test(hay)) return { id: entry.id, label: entry.label };
  return null;
}

// --- Deterministic classification --------------------------------
// Internal = the effect stays inside SAM's own memory and is
// owner-reversible (an ordinary note; notes are archived, never
// deleted). Consequential = standing rules, recurring jobs, posts,
// outbound text, code writes, and skills SAM authors itself - the
// kinds Dip's ruling keeps approval-gated. A registry skill INSTALL
// is the one deliberate exception (Dip, 2026-11-10: SAM finds and
// installs its own skills so it keeps getting smarter): skill text
// is untrusted reference that can never override law, the install
// is shape/size validated, provenance-logged, curator-watched and
// removable, and on the auto path its content is scanned first - a
// flagged skill holds for the owner instead of executing.
// Unknown kinds classify consequential (fail-closed).
export type ProposalRisk = "internal" | "consequential";
const CONSEQUENTIAL_KINDS = new Set(["law", "heartbeat", "say", "draft", "skill-author", "git-push", "engine", "spawn", "delegate", "pair"]);
export function classifyProposal(kind: string, supersedes: string | null | undefined): { risk: ProposalRisk; reason: string } {
  if (CONSEQUENTIAL_KINDS.has(kind)) return { risk: "consequential", reason: "kind \"" + kind + "\" has owner-facing effects and always needs the owner's decision in manual and smart modes" };
  if (kind === "skill") return { risk: "internal", reason: "a registry skill install: validated, provenance-logged, curator-watched and removable untrusted reference; content-scanned on the auto path, where a flagged skill holds for the owner" };
  if (kind === "note") {
    if (supersedes) return { risk: "consequential", reason: "the note supersedes record " + supersedes + ", retiring an existing record" };
    return { risk: "internal", reason: "an ordinary memory note: internal and owner-reversible" };
  }
  return { risk: "consequential", reason: "unknown kind \"" + kind + "\" - classified consequential (fail-closed)" };
}

// The one decision function the gate consults. Returns the via
// stamp for an auto-execution, or null when the proposal must wait
// for the owner.
export function approvalAutoVia(policy: ApprovalPolicy, kind: string, supersedes: string | null | undefined): { via: string; risk: ProposalRisk } | null {
  // A coding-operative delegation always cards the owner, including
  // when the install's mode is off. The process must not start on a
  // policy setting alone.
  if (kind === "delegate") return null;
  // Self-pairing always cards the owner too, in every mode:
  // pairing widens SAM's reach, and no policy setting grants it.
  if (kind === "pair") return null;
  const { risk } = classifyProposal(kind, supersedes);
  if (policy.mode === "off") return { via: "auto:off", risk };
  if (policy.mode === "smart" && risk === "internal" && policy.autoKinds.includes(kind)) return { via: "auto:smart", risk };
  return null;
}

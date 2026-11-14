import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { budgetFallbackAnswer, toolBudget, trimHistoryForRetry } from "./budgets.js";
import { loaderLoopFallbackAnswer } from "./tool-tiers.js";
import { recordChange, recordVerification, verificationGate, verificationStatus, type VerificationStatus } from "./verification.js";
import { dueLoops, openLoop, openLoopCount, updateOpenLoop } from "./loops.js";
import { codeVerificationNote, failureSignature, repeatedFailureStubContent, toolResultError } from "./loop-guards.js";

/**
 * The loop audit (HARNESS INTELLIGENCE item 3, Dip 2026-11-11):
 * items 1 and 2 measured the prompts and the context; this
 * measures the TURN LOOP itself - whether a turn verifies
 * before claiming, repairs a failed tool call instead of
 * surrendering or repeating it, plans across sessions through
 * the open-loop machinery, spends its budgets where correctness
 * buys the most, and ends honestly when it cannot finish.
 *
 * - FUNCTIONAL ANCHORED CHECKS: each check runs the REAL loop
 *   machinery (the prompt/context-audit precedent: the
 *   instrument must be able to say no). The verification gate
 *   is exercised over a synthetic ledger in a scratch directory;
 *   the open-loop check opens a loop in a scratch store and
 *   reads it back due; the guard checks run the shared
 *   loop-guards shapes both chat loops ride.
 * - MEASURED LIVE STATE: the audit also reads the install's
 *   own loop state - the verification ledger's current state
 *   and the open-loop counts - so a turn population sitting on
 *   unverified changes or a pile of due loops is visible, not
 *   vibes. Those reads create nothing.
 * - RECORDED: a run persists to SQLite (.sam/loop-audit.db,
 *   the singleton pattern through openDatabase - ONE row
 *   holding the audit's full JSON, legacy JSON import-once)
 *   and writes one loop-audit activity line carrying counts
 *   only. A pure read (readLoopAudit) creates nothing.
 *   "sam-loop-audit" joins the Phase C script allowlist so a
 *   heartbeat job CAN re-measure on a schedule. No model call
 *   anywhere.
 */

export const LOOP_AUDIT_SCRIPT = "sam-loop-audit";

export interface LoopCheck { id: string; label: string; passed: boolean }
export interface LoopDimension { id: string; label: string; passed: number; total: number; checks: LoopCheck[] }
export interface LoopLiveState { verification: VerificationStatus["state"]; pendingChanges: number; openLoops: number; dueLoops: number }
export interface LoopAudit {
  at: string;
  overall: { passed: number; total: number };
  dimensions: LoopDimension[];
  findings: Array<{ dimension: string; check: string; missing: string }>;
  live: LoopLiveState;
  budgets: { heartbeat: { rounds: number; maxCalls: number }; chat: { rounds: number; maxCalls: number }; background: { rounds: number; maxCalls: number } };
}

function verifyGateCheck(): boolean {
  const root = mkdtempSync(join(tmpdir(), "sam-loop-audit-verify-"));
  try {
    if (verificationGate(root).state !== "clean" || !verificationGate(root).closable) return false;
    recordChange(root, { path: "src/probe.ts", replacementHash: "probe-hash", source: "loop-audit" });
    const unverified = verificationGate(root);
    if (unverified.closable || unverified.state !== "unverified") return false;
    recordVerification(root, { kind: "build", passed: true, runId: "loop-audit-build" });
    if (verificationGate(root).closable) return false;
    recordVerification(root, { kind: "test", passed: true, runId: "loop-audit-test" });
    const verified = verificationGate(root);
    return verified.closable && verified.state === "verified";
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function dueLoopCheck(): boolean {
  const root = mkdtempSync(join(tmpdir(), "sam-loop-audit-loops-"));
  try {
    if (dueLoops(root).length !== 0 || openLoopCount(root) !== 0) return false;
    const loop = openLoop(root, { profile: "sam", question: "Has the probe shipped?", answer: "Not yet.", watchFor: "the probe release", dueInHours: 1 });
    if (dueLoops(root).length !== 0) return false;
    updateOpenLoop(root, loop.id, { dueAt: new Date(Date.now() - 60_000).toISOString() });
    const due = dueLoops(root);
    return due.length === 1 && due[0].id === loop.id && openLoopCount(root) === 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function unverifiedStatus(): VerificationStatus {
  return { state: "unverified", pendingChanges: [{ path: "src/probe.ts", replacementHash: "h", at: "", source: "loop-audit" }], lastChangeAt: null, lastVerificationAt: null, buildPassedAfterChange: false, testPassedAfterChange: false };
}

interface CheckSpec { id: string; label: string; missing: string; run: () => boolean }

const DIMENSIONS: Array<{ id: string; label: string; checks: CheckSpec[] }> = [
  { id: "verify", label: "Verify before claiming", checks: [
    { id: "verify-gate", label: "the verification gate refuses an unverified change and closes a verified one", missing: "a verification gate that closes only on a fresh build AND test pass after the last change", run: verifyGateCheck },
    { id: "verify-note", label: "a code-changing chat turn closes with a verification note unless the ledger reads verified", missing: "the deterministic verification note appended to a code-changing chat turn's reply when the ledger does not read verified", run: () => { const note = codeVerificationNote(unverifiedStatus()); return note !== null && note.includes("src/probe.ts") && /not verified/.test(note) && codeVerificationNote({ ...unverifiedStatus(), state: "verified", pendingChanges: [] }) === null && codeVerificationNote({ ...unverifiedStatus(), state: "failed" }) !== null; } },
  ] },
  { id: "repair", label: "Tool-failure repair", checks: [
    { id: "repair-signature", label: "a repeated call is recognized by name plus stable-ordered arguments", missing: "a failure signature over the tool name and its arguments with stable key ordering", run: () => failureSignature("sam_code", { b: 1, a: { d: 2, c: 3 } }) === failureSignature("sam_code", { a: { c: 3, d: 2 }, b: 1 }) && failureSignature("sam_code", { a: 1 }) !== failureSignature("sam_code", { a: 2 }) && failureSignature("sam_code", { a: 1 }) !== failureSignature("sam_read", { a: 1 }) },
    { id: "repair-stub", label: "the repeated-failure stub names the first error and orders a changed approach or an honest report", missing: "a repeated-failure stub that is not executed, names the first error, and orders a changed approach or an honest report instead of a retry", run: () => { const stub = repeatedFailureStubContent("sam_code", "Exact text not found"); return stub.includes("not executed") && stub.includes("Exact text not found") && /Change the arguments or the approach/.test(stub) && /report the failure plainly/.test(stub); } },
    { id: "repair-error-shape", label: "tool errors are read as data: an error result is a failure, a payload is not", missing: "error extraction that reads {error} tool results as failures and leaves payloads alone", run: () => toolResultError({ error: "boom" }) === "boom" && toolResultError({ status: "ok", rows: 3 }) === null && toolResultError("plain text") === null && toolResultError(null) === null },
  ] },
  { id: "planning", label: "Planning and budget spend", checks: [
    { id: "planning-budgets", label: "budgets tier by route: background goes deeper than chat, chat at least as deep as a heartbeat poll", missing: "route-tiered tool budgets (background deeper than chat, chat at least a heartbeat poll's)", run: () => { const h = toolBudget("heartbeat"); const c = toolBudget("chat"); const b = toolBudget("background"); return b.rounds > c.rounds && b.maxCalls > c.maxCalls && c.maxCalls >= h.maxCalls && c.rounds >= h.rounds; } },
    { id: "planning-due-loops", label: "an open loop is stored, reads back due on its schedule, and counts as open", missing: "the open-loop store: a recorded question that comes due on schedule for the revisit engine", run: dueLoopCheck },
  ] },
  { id: "endings", label: "Honest endings", checks: [
    { id: "endings-budget", label: "a budget ending names the checks that did not run and says the answer is incomplete", missing: "an honest budget fallback (the unfinished checks named, the answer marked incomplete)", run: () => { const text = budgetFallbackAnswer(["sam_code"], ["sam_brief"], 6); return text.includes("sam_brief") && /incomplete/.test(text); } },
    { id: "endings-loader", label: "a loader-loop ending is reported as a loader loop, never dressed as a budget failure", missing: "the loader-loop fallback (loading named as the failure, not a budget or step limit)", run: () => /loading tools is not progress/.test(loaderLoopFallbackAnswer(["sam_load_tools"])) },
    { id: "endings-retry-trim", label: "the context-reset retry keeps the system line plus the last six messages", missing: "the retry trim (system line plus the last six messages) that lets a poisoned turn recover once", run: () => { const msgs = Array.from({ length: 10 }, (_, i) => "m" + String(i)); const trimmed = trimHistoryForRetry(msgs); return trimmed.length === 7 && trimmed[0] === "m0" && trimmed[6] === "m9" && trimHistoryForRetry(msgs.slice(0, 5)).length === 5; } },
  ] },
];

/** Read the install's own loop state without creating anything:
 *  the verification ledger's projection and the open-loop
 *  counts, exactly as the loops themselves leave them. */
export function measureLoopLive(root: string): LoopLiveState {
  let verification: VerificationStatus["state"] = "clean";
  let pendingChanges = 0;
  try {
    const status = verificationStatus(root);
    verification = status.state;
    pendingChanges = status.pendingChanges.length;
  } catch { /* an unreadable ledger reads as its safest shape */ }
  let open = 0; let due = 0;
  try { open = openLoopCount(root); } catch { /* absent store: zero loops */ }
  try { due = dueLoops(root).length; } catch { /* absent store: none due */ }
  return { verification, pendingChanges, openLoops: open, dueLoops: due };
}

/** Score the loop machinery and read the live state.
 *  Deterministic: the same tree and stores always produce the
 *  same audit (apart from `at`). */
export function buildLoopAudit(root: string): LoopAudit {
  const dimensions: LoopDimension[] = [];
  const findings: LoopAudit["findings"] = [];
  let passed = 0; let total = 0;
  for (const dim of DIMENSIONS) {
    const checks: LoopCheck[] = dim.checks.map(spec => {
      let ok = false;
      try { ok = spec.run(); } catch { ok = false; }
      if (!ok) findings.push({ dimension: dim.id, check: spec.id, missing: spec.missing });
      return { id: spec.id, label: spec.label, passed: ok };
    });
    const p = checks.filter(c => c.passed).length;
    passed += p; total += checks.length;
    dimensions.push({ id: dim.id, label: dim.label, passed: p, total: checks.length, checks });
  }
  return {
    at: new Date().toISOString(),
    overall: { passed, total },
    dimensions, findings,
    live: measureLoopLive(root),
    budgets: { heartbeat: toolBudget("heartbeat"), chat: toolBudget("chat"), background: toolBudget("background") },
  };
}

function auditPath(root: string) { return join(resolve(root), ".sam", "loop-audit.json"); }
function auditDbPath(root: string) { return join(resolve(root), ".sam", "loop-audit.db"); }

function parseAudit(data: unknown): LoopAudit | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<LoopAudit>;
  if (typeof value.at !== "string" || !value.at) return null;
  if (!value.overall || typeof value.overall.passed !== "number" || typeof value.overall.total !== "number") return null;
  if (!Array.isArray(value.dimensions) || !Array.isArray(value.findings) || !value.live || !value.budgets) return null;
  return value as LoopAudit;
}
function openAuditStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(auditDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS loop_audit (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyAudit(db, root);
  return db;
}
function migrateLegacyAudit(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM loop_audit WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = auditPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseAudit(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO loop_audit (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function auditStoreExists(root: string): boolean {
  return existsSync(auditDbPath(root)) || existsSync(auditPath(root));
}

/** The recorded audit through the store's own shape, or null
 *  when no audit has ever run - and a read on an install with
 *  no store at all creates nothing. */
export function readLoopAudit(root: string): LoopAudit | null {
  if (!auditStoreExists(root)) return null;
  const db = openAuditStore(root);
  try {
    const row = db.prepare("SELECT data FROM loop_audit WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseAudit(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function saveLoopAudit(root: string, audit: LoopAudit): void {
  const db = openAuditStore(root);
  try {
    db.prepare("INSERT INTO loop_audit (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(audit));
  } finally { db.close(); }
}

/** Run the audit over the live loop machinery and stores: build
 *  it, record it (one UPSERT), and ledger one line carrying
 *  counts only. Returns the recorded audit. */
export function runLoopAudit(root: string): LoopAudit {
  const audit = buildLoopAudit(root);
  saveLoopAudit(root, audit);
  recordActivity(root, "sam", "loop-audit", "Loop audit recorded: " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks, " + String(audit.findings.length) + " finding(s), verification " + audit.live.verification + ", open loops " + String(audit.live.openLoops) + " (" + String(audit.live.dueLoops) + " due)");
  return audit;
}

/** The audit as plain text (the sam-loop-audit script job's
 *  stdout shape): the scorecard a person reads. */
export function loopAuditText(audit: LoopAudit): string {
  const lines: string[] = ["Loop audit - " + audit.at + " - " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks passed"];
  for (const dim of audit.dimensions) lines.push("- " + dim.label + ": " + String(dim.passed) + "/" + String(dim.total));
  if (audit.findings.length) {
    lines.push("", "Findings:");
    for (const f of audit.findings) lines.push("- [" + f.dimension + "/" + f.check + "] " + f.missing);
  } else lines.push("", "Findings: none - the loop verifies before claiming, repairs failures instead of repeating them, plans through open loops, and ends honestly.");
  lines.push("", "Live loop state: verification " + audit.live.verification + ", open loops " + String(audit.live.openLoops) + " (" + String(audit.live.dueLoops) + " due); budgets heartbeat " + String(audit.budgets.heartbeat.maxCalls) + " calls / chat " + String(audit.budgets.chat.maxCalls) + " / background " + String(audit.budgets.background.maxCalls) + ".");
  return lines.join("\n");
}

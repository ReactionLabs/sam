import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore, preferenceStatementBlocker } from "./preferences.js";
import { addHeartbeatJob, addScheduledJob, heartbeatCreationBlocker } from "./heartbeat.js";
import { compileSchedule, ownerTimezone, scriptArgv, validateTimezone } from "./schedule.js";
import { channels } from "./channels.js";
import { channelForChat, errorReason } from "./telegram.js";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { installSkill, scanSkillRef, SkillScanHold, skillScanHitIds } from "./skill-registry.js";
import { validateSkillAuthorDetail, writeAuthoredSkill } from "./skill-author.js";
import { createDraft } from "./drafts.js";
import { approvalAutoVia, classifyProposal, loadApprovalPolicy, neverListSummary, scanNeverList, type ProposalRisk } from "./approval-policy.js";
import { pushBranch, validateGitPushDetail } from "./git-work.js";
import { queueEngineTask, validateEngineDetail } from "./engine.js";
import { spawnMini, validateSpawnDetail } from "./minis.js";
import { createLink } from "./links.js";
import { runApprovedDelegation, validateDelegateDetail } from "./coding-operatives.js";
import { pairConnector, validatePairDetail } from "./connector-pairing.js";

// Hands, with a gate. SAM (any profile) can PROPOSE an action; nothing executes
// until the owner approves it in the dashboard or by CLI. The executor allowlist
// is deliberately internal-only: save a memory note, set a standing law, create
// a heartbeat job, post a message into one of SAM's own chats, write a
// skill SAM authored itself (Phase B item 3), or (P12, on the
// owner's own program order) save an outbound DRAFT the owner then sends
// themselves - drafting writes only to SAM's own store, there is no send path.
// One further kind rides on the owner's own coder-program order (C4,
// Phase D item 5): "git-push" pushes ONE sam/<task> branch from the
// designated code root to that repository's own origin - the landing
// act for coding-loop work, validated at proposal time so a card that
// cannot execute is never shown, consequential so smart mode can
// never auto-approve it, and with no force flag and no PR creation.
// One more kind rides on the coder program's end state (C6, Phase D
// item 6): "engine" queues a managed engine run (the provider
// selected in config - Claude Code or Codex) inside the C4
// branch sandbox; SAM records, verifies, reviews, and commits the
// engine's work itself, and the run executes nothing until the owner
// approves - approval queues it, the drain runs it.
// No external sends, no service control, no money, no trading - widening this
// list is an owner decision, never a model decision. The owner approved one
// more kind, "delegate": hand a repo job to Codex CLI or Claude Code. It
// always cards the owner with adapter, repo, branch, and prompt, and the
// process does not start until that card is approved. Every step lands in the
// activity ledger, so a proposal's whole life is auditable.
export type ActionKind = "note" | "law" | "heartbeat" | "say" | "skill" | "draft" | "skill-author" | "git-push" | "engine" | "spawn" | "delegate" | "pair";
export type ActionStatus = "pending" | "done" | "rejected" | "failed";
export interface ActionProposal {
  id: string; actor: string; kind: ActionKind; title: string; detail: string;
  status: ActionStatus; createdAt: string; decidedAt: string | null; result: string | null;
  chatId: string | null;
  // Note PATCH (Phase B item 2): a kind "note" proposal may name the
  // memory record it supersedes. On approval the new note saves AND
  // that record is archived, so recall stops surfacing the stale text.
  supersedes: string | null;
  // Approvals engine (Phase D item 1): the deterministic risk class
  // stamped at proposal time, and who decided - "owner", or the
  // auto via ("auto:smart" / "auto:off") when the install's approval
  // mode executed it without a card decision. Legacy records read
  // as null for both.
  risk: ProposalRisk | null;
  decidedBy: string | null;
}
const KINDS: ActionKind[] = ["note", "law", "heartbeat", "say", "skill", "draft", "skill-author", "git-push", "engine", "spawn", "delegate", "pair"];
export const ACTION_KINDS: readonly string[] = KINDS;
function actionsFile(root: string): string { return join(resolve(root), ".sam", "actions.json"); }
function actionsDbFile(root: string): string { return join(resolve(root), ".sam", "actions.db"); }
// State convergence (UNIFICATION item 4): the gate's store is SQLite
// (.sam/actions.db, the MemoryStore/ChatStore pattern), one row per
// proposal. The old actions.json was rewritten whole on every propose,
// decide, and settle, and three processes write this store (dashboard,
// Telegram bridge, heartbeat tick) - two writers holding the same
// snapshot silently lost the second one's record. Here each mutation
// is a single-row INSERT or UPDATE, so interleaved writers cannot lose
// each other, and a crash mid-write cannot tear the store. First open
// imports a legacy actions.json in file order (the legacy field
// defaults listActions always applied) and renames it
// actions.json.migrated - imported, never deleted; a malformed file
// imports nothing and is left in place. A pure read on an install with
// neither file creates nothing, so read-only audits stay read-only.
const ACTION_COLUMNS = "id, actor, kind, title, detail, status, created_at, decided_at, result, chat_id, supersedes, risk, decided_by";
interface ActionRow { id: string; actor: string; kind: string; title: string; detail: string; status: string; created_at: string; decided_at: string | null; result: string | null; chat_id: string | null; supersedes: string | null; risk: string | null; decided_by: string | null }
function rowToProposal(row: ActionRow): ActionProposal {
  return { id: row.id, actor: row.actor, kind: row.kind as ActionKind, title: row.title, detail: row.detail, status: row.status as ActionStatus, createdAt: row.created_at, decidedAt: row.decided_at ?? null, result: row.result ?? null, chatId: row.chat_id ?? null, supersedes: row.supersedes ?? null, risk: (row.risk ?? null) as ProposalRisk | null, decidedBy: row.decided_by ?? null };
}
function proposalParams(a: ActionProposal): Record<string, string | null> {
  return { id: a.id, actor: a.actor, kind: a.kind, title: a.title, detail: a.detail, status: a.status, created_at: a.createdAt, decided_at: a.decidedAt ?? null, result: a.result ?? null, chat_id: a.chatId ?? null, supersedes: a.supersedes ?? null, risk: a.risk ?? null, decided_by: a.decidedBy ?? null };
}
function openActionStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(actionsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, result TEXT, chat_id TEXT, supersedes TEXT, risk TEXT, decided_by TEXT)");
  migrateLegacyActions(db, root);
  return db;
}
function migrateLegacyActions(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number };
  if (n > 0) return;
  const file = actionsFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO actions (" + ACTION_COLUMNS + ") VALUES (@id, @actor, @kind, @title, @detail, @status, @created_at, @decided_at, @result, @chat_id, @supersedes, @risk, @decided_by)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Partial<ActionProposal>;
      if (typeof a.id !== "string" || !a.id) continue;
      insert.run(proposalParams({ id: a.id, actor: String(a.actor ?? ""), kind: (a.kind ?? "note") as ActionKind, title: String(a.title ?? ""), detail: String(a.detail ?? ""), status: (a.status ?? "pending") as ActionStatus, createdAt: String(a.createdAt ?? ""), decidedAt: a.decidedAt ?? null, result: a.result ?? null, chatId: a.chatId ?? null, supersedes: a.supersedes ?? null, risk: a.risk ?? null, decidedBy: a.decidedBy ?? null }));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
// Failure visibility (gap found 2026-11-14, hourly run
// 17:04 EST): the action store is the ONE approval gate's own
// store - every proposal, decision, and auto-settle rides it -
// and every touch opened it raw. listActions is the one read
// door (dashboard status + Approvals block, the CLI actions
// views, decideAction, settleAutoApprovals, the re-proposal
// path); insertAction is proposeAction's write; updateAction
// is every decision's write. A dead actions.db threw into
// whichever catch happened to wrap the call with the seam
// unnamed, and no action-store failure kind existed (the
// self-work "action-failed" class is gated EXECUTION failures,
// kind "failed" - a different seam), so the gate itself could
// be blind and uncountable. Now the store's touches own their
// failure (the contacts / drafts precedent): a failed touch
// ledgers ONE action-store-failed line (phase read for
// listActions, write for insertAction / updateAction; actor
// sam; the verbatim reason collapsed and capped; never any
// proposal record - titles and details are the owner's gated
// words, not failure data), tags the error, and rethrows
// exactly, so every caller's handling is unchanged and reads
// still fail closed (never folded as no proposals, which
// would hide pending cards the owner still must decide).
// Validation errors in proposeAction and the never-list
// refusal are not store failures and ledger nothing at this
// seam - they throw before any store touch - and an executor
// failure inside a decision keeps its existing kind "failed"
// line, gaining an action-store line only when the decision's
// own update touch is what dies. An absent store still reads
// as no proposals with no line and creates nothing.
export type ActionStorePhase = "read" | "write";

export function actionStoreFailureSummary(phase: ActionStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Action store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a action-store-failed line carries (census sprint
 * 2026-11-17): recordActionStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function actionStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordActionStoreFailure(root: string, phase: ActionStorePhase, error: unknown): void {
  const reason = actionStoreFailureReason(error);
  recordActivity(root, "sam", "action-store-failed", actionStoreFailureSummary(phase, reason));
}

function tagActionStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { actionStoreLedgered?: boolean }).actionStoreLedgered = true;
  }
}

export function isActionStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { actionStoreLedgered?: boolean }).actionStoreLedgered === true;
}

function failActionStore(root: string, phase: ActionStorePhase, error: unknown): never {
  if (!isActionStoreLedgered(error)) recordActionStoreFailure(root, phase, error);
  tagActionStoreLedgered(error);
  throw error;
}
// The approval-gate queue as a plain-text scorecard - the
// trending surface a daily script job P3-diffs (2026-11-18,
// the measured-proof series): the worthiness scorecard
// trends the delivery gate's verdicts and the outbox
// scorecard trends the queue downstream of it, but the ONE
// gate's own queue - proposals waiting on the owner - had no
// trending surface; the only folds counting pending
// proposals were the overview (never P3-silent) and the
// brief's needs-you section (the brief job is not installed
// everywhere). Counts only: totals per status and the
// pending count per kind (kinds are a fixed in-code enum,
// never free text) - never a stamp, a title, a detail, an
// actor, or a result, so a day nothing is proposed or
// decided is byte-identical and P3-silent, and the first
// new pending proposal - or the day the backlog clears -
// is the news. A pure read over the same fold listActions
// performs: it creates nothing (listActions on an install
// with no store returns [] without opening one), approves
// nothing, rejects nothing, and executes nothing.
export function actionScorecardText(root: string): string {
  const all = listActions(root);
  const count = (status: ActionStatus) => all.filter(a => a.status === status).length;
  const pending = count("pending");
  const pendingKinds = [...new Set(all.filter(a => a.status === "pending").map(a => a.kind))].sort();
  const lines: string[] = [];
  lines.push("Approval gate: " + (pending > 0 ? "attention" : "clear"));
  lines.push("Pending: " + String(pending));
  lines.push("Done: " + String(count("done")));
  lines.push("Rejected: " + String(count("rejected")));
  lines.push("Failed: " + String(count("failed")));
  lines.push("Pending by kind: " + (pendingKinds.length ? pendingKinds.map(k => k + " " + String(all.filter(a => a.status === "pending" && a.kind === k).length)).join(", ") : "none"));
  lines.push("Note: counts only - the scorecard never approves, rejects, or executes a proposal; deciding stays the owner's act");
  return lines.join("\n");
}

// The action-failure scorecard (2026-11-18, the measured-proof
// series): when an approved action's execution throws, the
// decision seam ledgers one "failed" line ("<kind>: <title> -
// <reason>") and the proposal lands failed. The gate scorecard
// above counts failed proposals as a status, but no daily
// surface ever folded the ledger lines themselves, so an
// install source failing for every skill was invisible until
// the owner watched an install die. This text folds the whole
// ledger's failed lines to counts only: the total, counts per
// action kind (the summary's prefix, validated against the
// fixed ACTION_KINDS enum - an unknown prefix is "other",
// never printed as free text), and counts per fixed reason
// bucket folded from the reason half (the text after the
// first " - "). No stamp, no title, no detail, no actor, no
// URL, and no verbatim reason enters the text, so a day no
// action fails is byte-identical and P3-silent, and the first
// new failed action is the news. A pure read: it creates
// nothing, spends no model call, and retries nothing - the
// ledger and the gate are untouched, and re-executing a
// failed action stays the owner's act.
export type ActionFailureBucket = "http" | "not-found" | "other";
export function actionFailureKind(summary: string): string {
  const i = summary.indexOf(": ");
  if (i <= 0) return "other";
  const kind = summary.slice(0, i);
  return (KINDS as string[]).includes(kind) ? kind : "other";
}
export function actionFailureReasonPart(summary: string): string {
  const i = summary.indexOf(" - ");
  return i < 0 ? "" : summary.slice(i + 3);
}
export function actionFailureBucket(reason: string): ActionFailureBucket {
  if (/fetch failed|http \d{3}/i.test(reason)) return "http";
  if (/no skill\.md found|not found/i.test(reason)) return "not-found";
  return "other";
}
export function actionFailureScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "failed" });
  const kinds = new Map<string, number>();
  const buckets = new Map<ActionFailureBucket, number>();
  for (const line of lines) {
    const kind = actionFailureKind(line.summary);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const bucket = actionFailureBucket(actionFailureReasonPart(line.summary));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const byKind = [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const byBucket = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  out.push("Action failures: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Failed actions: " + String(lines.length));
  out.push("By kind: " + (byKind.length ? byKind.map(([kind, n]) => kind + " " + String(n)).join(", ") : "none"));
  out.push("By reason: " + (byBucket.length ? byBucket.map(([bucket, n]) => bucket + " " + String(n)).join(", ") : "none"));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries or re-executes an action or prints a title, detail, or reason; a new failed action is the news");
  return out.join("\n");
}
// The ONE writer for the proposal activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. Its shape is byte-identical to what proposeAction
// wrote inline before this writer existed.
export function proposalLedgerSummary(kind: string, title: string): string {
  return "Proposed " + kind + ": " + title;
}
// The proposal scorecard (2026-11-20, the measured-proof
// series): every proposal through the ONE gate has ledgered
// as a "proposal" line since the gate landed, but the class
// was never folded: the gate scorecard above reads the
// action STORE (the queue's current state) and the failure
// scorecard folds the ledger's "failed" lines, yet the
// proposal lines themselves - the inflow record of
// everything SAM has ever asked the owner to approve - had
// no trending surface, so the proposal mix over time (which
// kinds SAM reaches for, and how often) was invisible in
// aggregate. Proposing is the gate working as designed, so
// the verdict is attention only when a line is unparseable
// (the ONE writer's shape broken or the ledger tampered),
// else clear; the gate scorecard already carries the
// pending backlog's attention. The parser validates the
// kind against the fixed ACTION_KINDS enum - an unknown
// kind folds to "other", never printed as free text (the
// action-failure precedent). This text folds the class to
// counts only, on ONE line: the total and the counts per
// kind. No stamp, no actor, no title, and no verbatim
// summary enters the text - the summary carries the
// proposal's title, which a fold must never print. A pure
// read: it creates nothing, spends no model call, and
// proposes, approves, and executes nothing - the gate seam
// itself is untouched.
export function parseProposalSummary(summary: string): { kind: string } | null {
  const m = /^Proposed ([a-z][a-z0-9-]*): (.+)$/.exec(summary);
  if (!m) return null;
  return { kind: (KINDS as string[]).includes(m[1]) ? m[1] : "other" };
}
export function proposalScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "proposal" });
  const byKind = new Map<string, number>();
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseProposalSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    byKind.set(parsed.kind, (byKind.get(parsed.kind) ?? 0) + 1);
  }
  const kinds = [...KINDS, "other"].filter(k => (byKind.get(k) ?? 0) > 0).map(k => k + " " + String(byKind.get(k)));
  const parts: string[] = [];
  parts.push("Proposals: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(lines.length) + " total");
  parts.push("kinds " + (kinds.length ? kinds.join(" / ") : "none"));
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
// The ONE writers for the gate decision activity lines, so
// the scorecard's parser below can never drift from the
// seams it counts. Their shapes are byte-identical to what
// applyDecision wrote inline before these writers existed:
// a rejection is "<kind>: <title>", an approval is
// "<kind>: <title> - <result>", and an auto approval (by is
// the auto via stamp, never "owner") appends " [<by>]".
export function approvedLedgerSummary(kind: string, title: string, result: string, by: string): string {
  return kind + ": " + title + " - " + result + (by === "owner" ? "" : " [" + by + "]");
}
export function rejectedLedgerSummary(kind: string, title: string): string {
  return kind + ": " + title;
}
// The gate decision scorecard (2026-11-20, the
// measured-proof series): every decision through the ONE
// gate has ledgered as an "approved", "auto-approved", or
// "rejected" line since the gate landed, but the classes
// were never folded: the proposal scorecard folds the
// gate's inflow, the gate scorecard reads the action STORE
// (the queue's current state), and the failure scorecard
// folds the ledger's "failed" lines, yet the decision
// lines themselves - the outflow record of everything the
// owner and the approvals engine have ever decided - had
// no trending surface, so the decision mix over time (how
// much the owner decides by hand versus how much the
// engine settles, and which kinds get rejected) was
// invisible in aggregate. Deciding is the gate working as
// designed, so the verdict is attention only when a line
// is unparseable (a writer's shape broken or the ledger
// tampered), else clear; the gate scorecard already
// carries the pending backlog's attention. The parser
// validates the kind against the fixed ACTION_KINDS enum -
// an unknown kind folds to "other", never printed as free
// text (the action-failure precedent) - and folds an auto
// approval's trailing via stamp to the fixed smart / off /
// other buckets. This text folds the classes to counts
// only, on ONE line: the total, the counts per decision,
// the counts per kind, and the counts per auto via. No
// stamp, no actor, no title, no result, and no verbatim
// summary enters the text - the summary carries the
// proposal's title and its execution result, which a fold
// must never print. A pure read: it creates nothing, spends
// no model call, and decides, approves, rejects, and
// executes nothing - the decision seams themselves are
// untouched.
export function parseDecisionSummary(summary: string, ledgerKind: string): { kind: string; via: string | null } | null {
  const m = /^([a-z][a-z0-9-]*): (.+)$/.exec(summary);
  if (!m) return null;
  const kind = (KINDS as string[]).includes(m[1]) ? m[1] : "other";
  if (ledgerKind !== "auto-approved") return { kind, via: null };
  const viaMatch = /\[(auto:[a-z]+)\]$/.exec(m[2]);
  const via = viaMatch && (viaMatch[1] === "auto:smart" || viaMatch[1] === "auto:off") ? viaMatch[1].slice(5) : "other";
  return { kind, via };
}
export function decisionScorecardText(root: string): string {
  const approved = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "approved" });
  const autoApproved = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "auto-approved" });
  const rejected = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "rejected" });
  const byKind = new Map<string, number>();
  const byVia = new Map<string, number>();
  let unparseable = 0;
  for (const [lines, ledgerKind] of [[approved, "approved"], [autoApproved, "auto-approved"], [rejected, "rejected"]] as const) {
    for (const line of lines) {
      const parsed = parseDecisionSummary(line.summary, ledgerKind);
      if (!parsed) { unparseable += 1; continue; }
      byKind.set(parsed.kind, (byKind.get(parsed.kind) ?? 0) + 1);
      if (parsed.via) byVia.set(parsed.via, (byVia.get(parsed.via) ?? 0) + 1);
    }
  }
  const total = approved.length + autoApproved.length + rejected.length;
  const kinds = [...KINDS, "other"].filter(k => (byKind.get(k) ?? 0) > 0).map(k => k + " " + String(byKind.get(k)));
  const vias = ["smart", "off", "other"].filter(v => (byVia.get(v) ?? 0) > 0).map(v => v + " " + String(byVia.get(v)));
  const parts: string[] = [];
  parts.push("Gate decisions: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(total) + " total");
  parts.push("owner-approved " + String(approved.length) + " / auto-approved " + String(autoApproved.length) + " / rejected " + String(rejected.length));
  parts.push("kinds " + (kinds.length ? kinds.join(" / ") : "none"));
  parts.push("auto via " + (vias.length ? vias.join(" / ") : "none"));
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
// The ONE writers for the never-list activity lines, so the
// scorecard's parser below can never drift from the seams it
// counts. Their shapes are byte-identical to what the two
// seams wrote inline before these writers existed: a proposal
// refusal is "Refused a <kind> proposal (<hit>): <title>" and
// a decision-time block is "Blocked execution of <kind> <id>
// (<hit>): <title>", the title sliced to 120 chars at both.
export function neverListRefusedLedgerSummary(kind: string, hitId: string, title: string): string {
  return "Refused a " + kind + " proposal (" + hitId + "): " + title.slice(0, 120);
}
export function neverListBlockedLedgerSummary(kind: string, id: string, hitId: string, title: string): string {
  return "Blocked execution of " + kind + " " + id + " (" + hitId + "): " + title.slice(0, 120);
}
// The never-list history scorecard (2026-11-21, the
// measured-proof series): the hardline never-list ledgers one
// "never-list" line per hit - at proposal time, when a
// command-form payload is refused outright and never becomes
// a card, and at decision time, when a legacy or tampered
// record is blocked from executing - but the class was never
// folded, so how many hardline payloads were ever refused or
// blocked, and which of the five hardline classes they hit,
// was invisible in aggregate. The proposal-time half has no
// other witness at all: a refused proposal is never stored,
// so this ledger line is the only record the refusal ever
// happened; a decision-time block lands on its record as an
// ordinary failure, indistinguishable in the gate folds. A
// recorded hit is itself the signal, so the verdict is
// attention when any hit was ever recorded or any line is
// unparseable, else clear (the delivery-failure precedent).
// The parser validates the fixed shapes exactly: the hit id
// against the approval-policy module's own five-class
// neverListSummary vocabulary (a hit id outside it is drift,
// never a new class), the kind against the fixed
// ACTION_KINDS enum with an unknown kind folding to "other",
// never printed as free text (the proposal precedent), and
// the blocked shape's proposal id as a non-space token,
// consumed and never printed. This text folds the class to
// counts only, on ONE line: the refused and blocked counts,
// the counts per fixed hit class, the counts per kind, and
// the total. No stamp, no actor, no proposal id, no title,
// and no verbatim summary enters the text - the summary
// carries the proposal's title, which a fold must never
// print. A pure read: it creates nothing, spends no model
// call, and proposes, decides, and executes nothing - the
// never-list seams themselves are untouched.
export function parseNeverListSummary(summary: string): { stage: "refused" | "blocked"; kind: string; hit: string } | null {
  const hits = new Set(neverListSummary().map(h => h.id));
  const refused = /^Refused a ([a-z][a-z0-9-]*) proposal \(([a-z0-9-]+)\): (.+)$/.exec(summary);
  if (refused) {
    if (!hits.has(refused[2] as string)) return null;
    return { stage: "refused", kind: (KINDS as string[]).includes(refused[1] as string) ? (refused[1] as string) : "other", hit: refused[2] as string };
  }
  const blocked = /^Blocked execution of ([a-z][a-z0-9-]*) (\S+) \(([a-z0-9-]+)\): (.+)$/.exec(summary);
  if (blocked) {
    if (!hits.has(blocked[3] as string)) return null;
    return { stage: "blocked", kind: (KINDS as string[]).includes(blocked[1] as string) ? (blocked[1] as string) : "other", hit: blocked[3] as string };
  }
  return null;
}
export function neverListHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "never-list" });
  let refused = 0;
  let blocked = 0;
  let unparseable = 0;
  const byHit = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseNeverListSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.stage === "refused") refused += 1; else blocked += 1;
    byHit.set(parsed.hit, (byHit.get(parsed.hit) ?? 0) + 1);
    byKind.set(parsed.kind, (byKind.get(parsed.kind) ?? 0) + 1);
  }
  const hitOrder = neverListSummary().map(h => h.id);
  const hits = hitOrder.filter(h => (byHit.get(h) ?? 0) > 0).map(h => h + " " + String(byHit.get(h)));
  const kinds = [...KINDS, "other"].filter(k => (byKind.get(k) ?? 0) > 0).map(k => k + " " + String(byKind.get(k)));
  const parts: string[] = [];
  parts.push("Never-list history: " + (refused + blocked > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(refused) + " refused");
  parts.push(String(blocked) + " blocked");
  parts.push("hits " + (hits.length ? hits.join(" / ") : "none"));
  parts.push("kinds " + (kinds.length ? kinds.join(" / ") : "none"));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
// The ONE writer for the skill-scan-hold activity line, so
// the scorecard's parser below can never drift from the seam
// it counts. Its shape is byte-identical to what the
// decideAction seam wrote inline before this writer existed:
// "<kind>: <title> - <scan message>", where the scan message
// is the SkillScanHold error's own fixed shape ("flagged skill
// content: <name> [<hit id>, ...]; ...").
export function skillScanHoldLedgerSummary(kind: string, title: string, scanMessage: string): string {
  return kind + ": " + title + " - " + scanMessage;
}
// The skill scan hold history scorecard (2026-11-24, the
// measured-proof series): when an auto-approved skill
// install's content scan flags the skill, the ONE gate holds
// it - the decision reverts to a pending card for the owner -
// and ledgers one "skill-scan-hold" line, but the class was
// never folded, so how often the scan caught a flagged skill
// an approval mode would otherwise have installed silently,
// and which of the scan's classes it caught, was invisible in
// aggregate. The held card itself reads as an ordinary
// pending card in the gate folds, indistinguishable from a
// never-decided one; this ledger line is the only witness
// that the scan ever fired. A recorded hold is itself the
// signal, so the verdict is attention when any hold was ever
// recorded or any line is unparseable, else clear (the
// never-list precedent). The parser validates the fixed shape
// exactly: the kind against the fixed ACTION_KINDS enum with
// an unknown kind folding to "other", never printed as free
// text; the flagged entries as skill names (consumed, counted
// as a distinct number only, never printed) each carrying at
// least one hit id validated against the scan's own five-class
// vocabulary (an id outside it is drift, never a new class);
// the free title is consumed and never printed. This text
// folds the class to counts only, on ONE line: the held
// count, the distinct-skill count as a number only, the
// counts per fixed hit class, the counts per kind, and the
// total. No stamp, no actor, no title, no skill name, and no
// verbatim summary enters the text. A pure read: it creates
// nothing, spends no model call, and proposes, decides, and
// executes nothing - the hold seam itself is untouched.
export function parseSkillScanHoldSummary(summary: string): { kind: string; skills: string[]; hits: string[] } | null {
  const m = /^([a-z][a-z0-9-]*): (.+) - flagged skill content: (.+)$/.exec(summary);
  if (!m) return null;
  const vocab = new Set(skillScanHitIds());
  const skills: string[] = [];
  const hits: string[] = [];
  for (const entry of (m[3] as string).split("; ")) {
    const e = /^([a-z0-9][a-z0-9._-]*) \[([a-z0-9-]+(?:, [a-z0-9-]+)*)\]$/.exec(entry);
    if (!e) return null;
    skills.push(e[1] as string);
    for (const id of (e[2] as string).split(", ")) {
      if (!vocab.has(id)) return null;
      hits.push(id);
    }
  }
  if (!skills.length || !hits.length) return null;
  return { kind: (KINDS as string[]).includes(m[1] as string) ? (m[1] as string) : "other", skills, hits };
}
export function skillScanHoldHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "skill-scan-hold" });
  let held = 0;
  let unparseable = 0;
  const skillSet = new Set<string>();
  const byHit = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseSkillScanHoldSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    held += 1;
    for (const s of parsed.skills) skillSet.add(s);
    for (const h of parsed.hits) byHit.set(h, (byHit.get(h) ?? 0) + 1);
    byKind.set(parsed.kind, (byKind.get(parsed.kind) ?? 0) + 1);
  }
  const hits = skillScanHitIds().filter(h => (byHit.get(h) ?? 0) > 0).map(h => h + " " + String(byHit.get(h)));
  const kinds = [...KINDS, "other"].filter(k => (byKind.get(k) ?? 0) > 0).map(k => k + " " + String(byKind.get(k)));
  const parts: string[] = [];
  parts.push("Skill scan hold history: " + (held > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(held) + " held");
  parts.push(String(skillSet.size) + " distinct skills");
  parts.push("hits " + (hits.length ? hits.join(" / ") : "none"));
  parts.push("kinds " + (kinds.length ? kinds.join(" / ") : "none"));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
// The ONE writer for the reproposal activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. Its shape is byte-identical to what the
// decideAction seam wrote inline before this writer existed:
// "Corrected re-proposal for failed <kind>: <title> ->
// profile <fix>", where the fix is the one unambiguous
// corrected profile name (correctedProfileName - a known
// profile or nothing is ever written).
export function reproposalLedgerSummary(kind: string, title: string, fix: string): string {
  return "Corrected re-proposal for failed " + kind + ": " + title + " -> profile " + fix;
}
// The reproposal history scorecard (2026-11-24, the
// measured-proof series): when a heartbeat proposal dies at
// execution on an unknown profile and the correction is
// unambiguous, the ONE gate creates a corrected re-proposal
// aimed at the fixed profile and ledgers one "reproposal"
// line - but the class was never folded, so how often the
// gate has re-aimed a dead card at a different profile was
// invisible in aggregate. The new card's own proposal line
// names only kind and title, never that it is a correction
// or which profile it now targets, and the failed line is
// written before the corrected profile joins the failed
// record's result; this ledger line is the only witness of
// the correction itself. A recorded correction is itself
// the signal (a card SAM proposed was unexecutable as
// written), so the verdict is attention when any correction
// was ever recorded or any line is unparseable, else clear.
// The parser validates the fixed shape exactly: the kind
// against the fixed ACTION_KINDS enum with an unknown kind
// folding to "other", never printed as free text; the free
// title consumed and never printed; the fix as a profile
// name in the registry's own alphabet (consumed, counted as
// a distinct number only, never printed). This text folds
// the class to counts only, on ONE line: the corrected
// count, the distinct-profile count as a number only, the
// counts per kind, and the total. No stamp, no actor, no
// title, no profile name, and no verbatim summary enters
// the text. A pure read: it creates nothing, spends no
// model call, and proposes, decides, and executes nothing -
// the reproposal seam itself is untouched beyond naming
// its writer.
export function parseReproposalSummary(summary: string): { kind: string; profile: string } | null {
  const m = /^Corrected re-proposal for failed ([a-z][a-z0-9-]*): (.+) -> profile ([a-z][a-z0-9._-]*)$/.exec(summary);
  if (!m) return null;
  return { kind: (KINDS as string[]).includes(m[1] as string) ? (m[1] as string) : "other", profile: m[3] as string };
}
export function reproposalHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "reproposal" });
  let corrected = 0;
  let unparseable = 0;
  const profileSet = new Set<string>();
  const byKind = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseReproposalSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    corrected += 1;
    profileSet.add(parsed.profile);
    byKind.set(parsed.kind, (byKind.get(parsed.kind) ?? 0) + 1);
  }
  const kinds = [...KINDS, "other"].filter(k => (byKind.get(k) ?? 0) > 0).map(k => k + " " + String(byKind.get(k)));
  const parts: string[] = [];
  parts.push("Reproposal history: " + (corrected > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(corrected) + " corrected");
  parts.push(String(profileSet.size) + " distinct profiles");
  parts.push("kinds " + (kinds.length ? kinds.join(" / ") : "none"));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
export function listActions(root: string): ActionProposal[] {
  if (!existsSync(actionsDbFile(root)) && !existsSync(actionsFile(root))) return [];
  let db: Database.Database;
  try { db = openActionStore(root); } catch (error) { failActionStore(root, "read", error); }
  try { return (db!.prepare("SELECT " + ACTION_COLUMNS + " FROM actions ORDER BY rowid").all() as ActionRow[]).map(rowToProposal); }
  catch (error) { failActionStore(root, "read", error); }
  finally { db!.close(); }
}
function insertAction(root: string, item: ActionProposal): void {
  let db: Database.Database;
  try { db = openActionStore(root); } catch (error) { failActionStore(root, "write", error); }
  try { db!.prepare("INSERT INTO actions (" + ACTION_COLUMNS + ") VALUES (@id, @actor, @kind, @title, @detail, @status, @created_at, @decided_at, @result, @chat_id, @supersedes, @risk, @decided_by)").run(proposalParams(item)); }
  catch (error) { failActionStore(root, "write", error); }
  finally { db!.close(); }
}
function updateAction(root: string, item: ActionProposal): void {
  let db: Database.Database;
  try { db = openActionStore(root); } catch (error) { failActionStore(root, "write", error); }
  try { db!.prepare("UPDATE actions SET actor=@actor, kind=@kind, title=@title, detail=@detail, status=@status, created_at=@created_at, decided_at=@decided_at, result=@result, chat_id=@chat_id, supersedes=@supersedes, risk=@risk, decided_by=@decided_by WHERE id=@id").run(proposalParams(item)); }
  catch (error) { failActionStore(root, "write", error); }
  finally { db!.close(); }
}
// Profile-reference validation (found live 2026-11-09 on Dip's PC): a
// heartbeat proposal named profile "Second Shift" - the connector's DISPLAY
// name, not a profile - was shown as an approval card, and only on approval
// did execution die with "Invalid profile", leaving a dead card and no job.
// A proposal must never be shown in a form that cannot execute, so the
// profile a heartbeat detail names is checked against the registry at
// PROPOSAL time. "sam" is the implicit core profile (same rule as links.ts
// validMember and the dashboard's default-agent check); every other name
// must be a registered agent profile.
export function knownProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; }
  finally { db.close(); }
}
function normalizeProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// The one unambiguous correction for a bad profile name: exactly one known
// profile matches it once case and separators are folded ("Second Shift"
// -> "second-shift"). Anything else is a guess and is never applied.
export function correctedProfileName(root: string, bad: string): string | null {
  const target = normalizeProfileName(bad ?? "");
  if (!target) return null;
  const matches = knownProfileNames(root).filter(n => normalizeProfileName(n) === target);
  return matches.length === 1 ? matches[0] : null;
}
function validateHeartbeatDetail(root: string, detail: string): void {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}");
  const s = spec as { name?: unknown; minutes?: unknown; profile?: unknown; prompt?: unknown; schedule?: unknown; timezone?: unknown; script?: unknown; channelId?: unknown };
  const profile = typeof s.profile === "string" ? s.profile : "";
  const names = knownProfileNames(root);
  if (!names.includes(profile)) {
    const fix = correctedProfileName(root, profile);
    throw new Error("Unknown profile \"" + profile + "\" in heartbeat detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : ""));
  }
  if (typeof s.name !== "string" || !/^[a-zA-Z0-9 _-]{1,80}$/.test(s.name)) throw new Error("Invalid heartbeat name in detail");
  // The creation precondition, at proposal time: the store's job
  // limit and the name's freshness are deterministic the moment
  // the card would be shown (the live store sits at the limit),
  // so a heartbeat that can only fail on approval is refused
  // here, in the ONE source's own words - the same text
  // createJob throws if the store fills between proposal and
  // approval, where execution re-checks through addHeartbeatJob /
  // addScheduledJob.
  const creationBlocker = heartbeatCreationBlocker(root, s.name);
  if (creationBlocker) throw new Error(creationBlocker);
  // A named delivery channel must be a real channel on this
  // install: a job created for a channel that does not exist
  // would deliver nowhere and read as done. Refused here, at
  // proposal time, naming the registry - the same dead-card rule
  // as the profile check above.
  if (s.channelId !== undefined && s.channelId !== null && s.channelId !== "") {
    if (typeof s.channelId !== "string") throw new Error("Invalid channelId in heartbeat detail");
    const known = channels(root);
    if (!known.some(c => c.id === s.channelId)) throw new Error("Unknown channel \"" + s.channelId + "\" in heartbeat detail. Valid channels: " + (known.length ? known.map(c => c.name + " (" + c.id + ")").join(", ") : "none registered"));
  }
  // Real cron (Phase C item 1): a detail may carry a schedule
  // phrase (interval, wall-clock, 5-field cron, natural language,
  // or a one-shot "once at ...") instead of raw minutes - it is
  // compiled at proposal time so an unreadable schedule never
  // reaches a card. Compilation rides the job's own timezone (the
  // detail's, or the owner's default), because a one-shot's date
  // only means anything in that zone. A script detail names one
  // allowlisted no-agent command and needs no prompt; anything
  // else keeps the original minutes + prompt contract exactly.
  const tz = s.timezone !== undefined ? validateTimezone(String(s.timezone)) : ownerTimezone();
  if (typeof s.script === "string" && s.script) {
    scriptArgv(root, s.script); // throws naming the allowlist
    if (typeof s.schedule !== "string" || !s.schedule) throw new Error("A script heartbeat detail needs a schedule");
    compileSchedule(s.schedule, tz);
    return;
  }
  if (typeof s.schedule === "string" && s.schedule) {
    compileSchedule(s.schedule, tz);
  } else if (!Number.isSafeInteger(Number(s.minutes)) || Number(s.minutes) < 5 || Number(s.minutes) > 10080) throw new Error("Invalid heartbeat minutes in detail (5 to 10080)");
  if (typeof s.prompt !== "string" || !s.prompt.trim() || s.prompt.length > 2000) throw new Error("Invalid heartbeat prompt in detail");
}
// The law kind's execution precondition, at proposal time: the
// approved execution writes the detail through
// PreferenceStore.note, which refuses a statement that is empty
// or over the cap once normalized - while the gate's own detail
// bound is far looser, so an over-long law (the tool contract
// itself says max 200 chars) was a card that could only fail on
// approval. The gate now throws preferenceStatementBlocker, the
// ONE source note() also throws, before any card or proposal
// ledger line exists; execution re-checks through note() as
// before, so a statement is measured the same way at both seams.
function validateLawDetail(detail: string): void {
  const blocker = preferenceStatementBlocker(detail);
  if (blocker) throw new Error(blocker);
}
export function proposeAction(root: string, input: { actor: string; kind: string; title: string; detail: string; chatId?: string | null; supersedes?: string | null }): ActionProposal {
  if (!KINDS.includes(input.kind as ActionKind)) throw new Error("Invalid action kind");
  const title = (input.title ?? "").trim();
  let detail = (input.detail ?? "").trim();
  if (!title || title.length > 200) throw new Error("Invalid action title");
  if (!detail || detail.length > 4000) throw new Error("Invalid action detail");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  if (input.kind === "heartbeat") validateHeartbeatDetail(root, detail);
  if (input.kind === "law") validateLawDetail(detail);
  // Channel inheritance (Telegram reminder gaps, 2026-11-10): a
  // heartbeat proposed from inside a channel-bound chat (the
  // owner asked on Telegram) inherits that channel as the job's
  // delivery target, so the reminder pings the owner back on the
  // surface they asked from instead of landing silently in a
  // dashboard heartbeat chat. An explicit channelId in the detail
  // always wins; a chat that lives on no channel inherits
  // nothing. The inherited id is written into the stored detail,
  // so the card the owner approves already shows where the job
  // will deliver.
  if (input.kind === "heartbeat" && input.chatId) {
    try {
      const spec = JSON.parse(detail) as { channelId?: unknown };
      if (spec.channelId === undefined || spec.channelId === null || spec.channelId === "") {
        const inherited = channelForChat(root, input.chatId);
        if (inherited) detail = JSON.stringify({ ...spec, channelId: inherited });
      }
    } catch { /* validateHeartbeatDetail already proved the detail parses */ }
  }
  // Skill authoring (Phase B item 3): the draft is validated at
  // proposal time - shape, secret scan, and the ownership rule (a
  // patch may only target a sam-authored skill) - so the owner is
  // never shown a card that cannot execute.
  if (input.kind === "skill-author") validateSkillAuthorDetail(root, detail);
  // Git discipline (Phase D item 5, C4): a push proposal is validated
  // at proposal time - the detail must name a sam/<task> branch that
  // exists in the designated code root's repository, with an origin
  // remote - so the owner is never shown a card that cannot execute,
  // and no other branch (main included) can ever be proposed.
  if (input.kind === "git-push") validateGitPushDetail(root, detail);
  // Managed engine runtime (Phase D item 6, C6): an engine run is
  // validated at proposal time - task shape, a designated GIT code
  // root (the branch sandbox), and the engine binary actually
  // installed - and it needs a chat to report back into (the
  // proposal's own chat, or one named in the detail).
  // Team spawn (Dip, 2026-11-10): creating a new agent is validated at
  // proposal time - fresh name, real person and instructions, a real
  // connector pin - so the card the owner sees can always execute.
  if (input.kind === "spawn") validateSpawnDetail(root, detail);
  // Self-pairing (Dip, 2026-11-12): a pair proposal is validated at
  // proposal time - fresh connector name, a vault credential that
  // exists by name, a known profile, a plain https or loopback URL -
  // so the card the owner sees can always execute.
  if (input.kind === "pair") validatePairDetail(root, detail);
  if (input.kind === "delegate") validateDelegateDetail(detail);
  if (input.kind === "engine") {
    const parsed = validateEngineDetail(root, detail);
    if (!input.chatId && !parsed.chatId) throw new Error("An engine proposal needs a chat to report back into - propose it from inside a chat, or name chatId in the detail");
  }
  // The hardline never-list (Phase D item 1) binds at PROPOSAL time,
  // in every approval mode: a command-form payload (rm -rf /, a fork
  // bomb, mkfs, dd onto a device, a URL piped to a root shell) is
  // refused outright and never becomes an approval card an owner
  // could rubber-stamp. The refusal is ledgered once; the payload
  // itself is not stored.
  const neverHit = scanNeverList(title + "\n" + detail);
  if (neverHit) {
    recordActivity(root, input.actor, "never-list", neverListRefusedLedgerSummary(input.kind, neverHit.id, title));
    throw new Error("Refused by the never-list: this proposal contains " + neverHit.label + ". That can never be proposed or executed in any approval mode; reword it as prose if you only meant to discuss it.");
  }
  const item: ActionProposal = {
    id: randomUUID(), actor: input.actor, kind: input.kind as ActionKind, title, detail,
    status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null,
    chatId: input.chatId ?? null,
    supersedes: input.kind === "note" ? (input.supersedes ?? null) : null,
    risk: classifyProposal(input.kind, input.kind === "note" ? (input.supersedes ?? null) : null).risk,
    decidedBy: null,
  };
  insertAction(root, item);
  recordActivity(root, input.actor, "proposal", proposalLedgerSummary(item.kind, title));
  return item;
}
async function execute(root: string, a: ActionProposal): Promise<string> {
  if (a.kind === "note") {
    const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
    try {
      const scope = a.actor === "sam" ? "core" : "profile:" + a.actor;
      // PATCH execution: the superseded record must still be a live
      // record at the new note's scope, or the patch lands failed
      // rather than silently saving beside a record it cannot retire.
      let old: ReturnType<MemoryStore["get"]> = null;
      if (a.supersedes) {
        old = store.get(a.supersedes);
        if (!old) throw new Error("Cannot patch: record " + a.supersedes + " no longer exists");
        if (old.archived_at) throw new Error("Cannot patch: record " + a.supersedes + " is already archived");
        if (old.scope !== scope) throw new Error("Cannot patch: record " + a.supersedes + " is not in this profile's scope");
      }
      const rec = store.add({ kind: "observation", content: a.detail, source: "owner-approved action " + a.id, scope });
      if (a.supersedes && old) {
        if (!store.archive(old.id)) throw new Error("Cannot patch: record " + old.id + " could not be archived");
        return "Memory note saved (" + rec.id + "), superseding record archived (" + old.id + ")";
      }
      return "Memory note saved (" + rec.id + ")";
    } finally { store.close(); }
  }
  if (a.kind === "law") {
    const store = new PreferenceStore(root);
    try { store.note(a.actor, a.detail, "rule", "owner-approved action " + a.id); return "Standing law set for " + a.actor; }
    finally { store.close(); }
  }
  if (a.kind === "heartbeat") {
    const spec = JSON.parse(a.detail) as { name: string; minutes: number; profile: string; prompt: string; channelId?: string | null; schedule?: string; timezone?: string; script?: string };
    if (spec.schedule) {
      const job = addScheduledJob(root, { name: spec.name, profile: spec.profile, schedule: spec.schedule, timezone: spec.timezone, prompt: spec.prompt, script: spec.script ?? null, channelId: spec.channelId ?? null });
      return "Heartbeat job created (" + job.id + ")";
    }
    const job = addHeartbeatJob(root, spec.name, Number(spec.minutes), spec.profile, spec.prompt, spec.channelId ?? null);
    return "Heartbeat job created (" + job.id + ")";
  }
  if (a.kind === "say") {
    const spec = JSON.parse(a.detail) as { chatId: string; text: string };
    const db = new ChatStore(root);
    try { db.add(spec.chatId, "assistant", spec.text); return "Message posted to chat " + spec.chatId; }
    finally { db.close(); }
  }
  if (a.kind === "draft") {
    // P12 outbound drafting: the approved execution writes a draft record
    // into SAM's own store and stops there. There is no send path; the
    // owner copies the draft and sends it themselves. A contact marked
    // no-drafts refuses here, so the proposal lands as failed, not sent.
    const spec = JSON.parse(a.detail) as { to: string; channel?: string; subject?: string | null; body: string };
    const draft = createDraft(root, { actor: a.actor, to: spec.to, channel: spec.channel, subject: spec.subject ?? null, body: spec.body, via: "proposal" });
    return "Draft saved for " + draft.to + " (" + draft.id + ") - the owner sends it";
  }
  if (a.kind === "skill-author") {
    // Self-authored skills (Phase B item 3): the approved execution
    // writes SAM's own SKILL.md into the discovery root and stamps
    // sam-authored provenance. Internal only - the skill is read as
    // untrusted reference afterwards, never executed by being written.
    const { draft, patch } = validateSkillAuthorDetail(root, a.detail);
    const record = writeAuthoredSkill(root, draft, { actor: a.actor });
    return (patch ? "Patched" : "Authored") + " skill " + record.name + " (v" + record.version + ") - it is now in the installed catalog";
  }
  // Registry skill install. On the AUTO path (the approvals engine
  // executing under the owner's standing policy, never the owner's
  // own tap) the skill's text is content-scanned first: a flagged
  // skill does not execute - SkillScanHold reverts the decision to a
  // pending card in applyDecision, so automation stays cautious and
  // the owner stays sovereign.
  if ((a.decidedBy ?? "").startsWith("auto:")) {
    const flagged = await scanSkillRef(a.detail);
    if (flagged.length) throw new SkillScanHold(flagged);
  }
  if (a.kind === "git-push") {
    // C4 landing: push the one named sam/<task> branch to the code
    // root repository's origin. Validation runs again inside
    // pushBranch, so a record written around the proposal-time
    // checks still cannot push anything else. No force, no PR -
    // the PR stays the owner's click.
    const { branch } = validateGitPushDetail(root, a.detail);
    const pushed = await pushBranch(root, branch);
    return "Pushed branch " + pushed.branch + " to origin (" + pushed.sha.slice(0, 12) + ")" + (pushed.vaultCredential ? " using vault credential " + pushed.vaultCredential : "") + " - no pull request was opened; that stays the owner's act";
  }
  if (a.kind === "spawn") {
    // Team spawn execution: the agent is created (profile + welcome
    // chat + optional starter digest) and LINKED to its creator in the
    // same act, because a teammate the creator cannot talk to is just
    // another isolated profile. Validation runs again here, so a name
    // taken since the proposal fails the card instead of colliding.
    // A link failure after a successful spawn is reported in the
    // result, not hidden: the agent exists either way.
    const spec = validateSpawnDetail(root, a.detail);
    const mini = spawnMini(root, spec);
    let linkNote = "";
    try {
      const group = createLink(root, a.actor + " + " + spec.name, [a.actor, spec.name]);
      linkNote = "; linked to " + a.actor + " ('" + group.name + "') so they can work together through the link";
    } catch (e) { linkNote = "; the agent exists but linking it to " + a.actor + " failed: " + (e instanceof Error ? errorReason(e) : "unknown error"); }
    return "Agent " + mini.name + " created for " + mini.person + " (profile + welcome chat 'Meet " + mini.person + "'" + (spec.starterHeartbeat ? " + a starter daily digest" : "") + ")" + linkNote;
  }
  if (a.kind === "pair") {
    // Self-pairing execution: register the connector bound to the
    // named vault credential, allowlist its loopback host when it
    // has one, test the endpoint with the harmless list call, and
    // pin it to the profile. Validation runs again inside
    // pairConnector, and a failed test or pin rolls the
    // registration back - approval never leaves a broken connector
    // enabled. The credential VALUE is resolved by the connector
    // executor at call time; it never passes through here.
    const spec = validatePairDetail(root, a.detail);
    const paired = await pairConnector(root, a.actor, spec);
    return "Paired connector " + paired.connector.name + " for profile " + paired.profile +
      (paired.pinned ? " (pinned to it)" : " (the core profile routes to enabled connectors directly)") +
      " using vault credential " + spec.vaultKey + " - " + paired.approvedTools.length +
      " approved read-only tool(s): " + (paired.approvedTools.join(", ") || "none");
  }
  if (a.kind === "delegate") {
    // Owner-approved coding operative. The card already named the
    // adapter, repo, branch, and prompt. Approval is what starts the
    // local process; this path never pushes or opens a pull request.
    const job = await runApprovedDelegation(root, { id: a.id, actor: a.actor, chatId: a.chatId, detail: a.detail });
    if (job.status !== "done") throw new Error(job.summary ?? "Delegation " + job.status);
    return job.summary ?? "Delegation finished";
  }
  if (a.kind === "engine") {
    // C6 managed engine runtime: approval QUEUES the run - it does
    // not execute inline. The heartbeat tick (or `engine drain`)
    // runs the engine inside the task's branch sandbox, and SAM
    // records, verifies, reviews, and commits its work before
    // anything counts as done. Validation runs again inside
    // queueEngineTask, so a record written around the proposal-time
    // checks still cannot queue an unrunnable task.
    const { task, chatId } = validateEngineDetail(root, a.detail);
    const queued = queueEngineTask(root, { actor: a.actor, chatId: a.chatId ?? chatId ?? "", spec: task });
    return "Engine run queued (" + queued.id + ") - the managed engine (" + (queued.provider === "codex" ? "Codex" : "Claude Code") + ", the provider selected at queue time) will run it inside a sam/<task> branch sandbox on the next drain; SAM verifies, reviews, and commits its work, and the summary posts into the chat";
  }
  const summary = await installSkill(root, a.detail, { actor: a.actor });
  if (!summary.installed.length) throw new Error("Nothing installed: " + (summary.skipped.join("; ") || "no skills found"));
  return "Installed skill(s): " + summary.installed.map(i => i.name).join(", ") + (summary.skipped.length ? " (skipped: " + summary.skipped.join("; ") + ")" : "");
}
// Action execution failures carry their cause (gap found
// 2026-11-16, hourly run 15:04 EST): applyDecision's catch took
// e.message alone over execute(), and that one bare message fed
// two records - the failed card's stored result (the text the
// owner reads on the card and in approval history) and the
// "failed" activity line. Execution includes the skill install,
// which rides fetch to skills.sh and the GitHub API, so an
// install dying on transport read the bare undici wrapper
// "fetch failed" in both records and named nothing (DNS vs
// connect vs socket vs TLS indistinguishable, the real reason
// rides error.cause). The reason now composes through
// errorReason (the 04:04 bridge seam): the cause chain is
// walked bounded and deduped, errno-style codes are appended,
// and bot-token segments are redacted, so a failure dying on a
// DNS lookup names the lookup in both records in the same
// shape. Causeless errors read byte-identically, a non-Error
// throw keeps the existing "Execution failed" fallback, and
// the proposal's detail never enters any failure record.
export function actionFailureReason(error: unknown): string {
  return error instanceof Error ? errorReason(error) : "Execution failed";
}

// One decision path for every decider: the owner (dashboard / CLI)
// and the approvals engine's auto modes. `by` is "owner" or the auto
// via stamp ("auto:smart" / "auto:off"); it lands on the record as
// decidedBy and shapes the ledger lines, so an auto-execution is
// never mistaken for an owner's tap after the fact.
async function applyDecision(root: string, a: ActionProposal, approve: boolean, by: string): Promise<ActionProposal> {
  const decider = by === "owner" ? "owner" : a.actor;
  a.decidedAt = new Date().toISOString();
  a.decidedBy = by;
  if (!approve) {
    a.status = "rejected"; a.result = by === "owner" ? "Rejected by owner" : "Rejected by " + by;
    updateAction(root, a);
    recordActivity(root, decider, "rejected", rejectedLedgerSummary(a.kind, a.title));
    return a;
  }
  // The never-list binds again at DECISION time: a record written
  // before the list existed (or written around the gate) can never
  // execute a hardline payload, whoever or whatever approves it.
  const neverHit = scanNeverList(a.title + "\n" + a.detail);
  if (neverHit) {
    a.status = "failed";
    a.result = "Refused by the never-list at decision time (" + neverHit.id + "): " + neverHit.label + " can never execute in any approval mode";
    updateAction(root, a);
    recordActivity(root, decider, "never-list", neverListBlockedLedgerSummary(a.kind, a.id, neverHit.id, a.title));
    return a;
  }
  try { a.result = await execute(root, a); a.status = "done"; }
  catch (e) {
    if (e instanceof SkillScanHold && by !== "owner") {
      // An auto-approved skill install the content scan flagged is
      // HELD, not failed: the decision reverts to a pending card and
      // the owner decides with the scan findings on the record. The
      // owner's own approval of the same proposal executes as-is.
      a.status = "pending"; a.decidedAt = null; a.decidedBy = null;
      a.result = "Auto-install held by the skill content scan (" + e.message + ") - waiting for the owner, who can approve it as-is or install it from the CLI";
      updateAction(root, a);
      recordActivity(root, a.actor, "skill-scan-hold", skillScanHoldLedgerSummary(a.kind, a.title, e.message));
      return a;
    }
    a.status = "failed"; a.result = actionFailureReason(e);
    // A failed card must not be a dead end. A heartbeat that died on an
    // unknown profile (a legacy proposal written before proposal-time
    // validation, or a profile removed after proposing) gets a corrected
    // re-proposal when the correction is unambiguous; otherwise the result
    // names the valid profiles so the owner can re-propose with full
    // information instead of guessing from "Invalid profile".
    let reproposal: { detail: string; fix: string } | null = null;
    if (a.kind === "heartbeat") {
      try {
        const spec = JSON.parse(a.detail) as { profile?: unknown };
        const bad = typeof spec?.profile === "string" ? spec.profile : "";
        const names = knownProfileNames(root);
        if (bad && !names.includes(bad)) {
          const fix = correctedProfileName(root, bad);
          if (fix) reproposal = { detail: JSON.stringify({ ...(spec as object), profile: fix }), fix };
          else a.result += ". Valid profiles: " + names.join(", ");
        }
      } catch { /* detail was not JSON; the failure result stands as-is */ }
    }
    updateAction(root, a);
    recordActivity(root, decider, "failed", a.kind + ": " + a.title + " - " + (a.result ?? ""));
    if (reproposal) {
      try {
        const existing = listActions(root).find(x => x.status === "pending" && x.kind === "heartbeat" && x.actor === a.actor && x.detail === reproposal!.detail);
        const np = existing ?? proposeAction(root, { actor: a.actor, kind: a.kind, title: a.title, detail: reproposal.detail, chatId: a.chatId });
        const self = listActions(root).find(x => x.id === a.id);
        if (self) {
          self.result = (self.result ?? "") + " Corrected re-proposal pending approval: " + np.id + " (profile " + reproposal.fix + ")";
          updateAction(root, self); a.result = self.result;
        }
        if (!existing) recordActivity(root, decider, "reproposal", reproposalLedgerSummary(a.kind, a.title, reproposal.fix));
      } catch { /* a re-proposal that itself refuses (e.g. the never-list) leaves the failure result standing */ }
    }
    return a;
  }
  updateAction(root, a);
  recordActivity(root, decider, by === "owner" ? "approved" : "auto-approved", approvedLedgerSummary(a.kind, a.title, a.result ?? "", by));
  return a;
}

export async function decideAction(root: string, id: string, approve: boolean): Promise<ActionProposal> {
  const a = listActions(root).find(x => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "pending") throw new Error("Action already decided");
  return applyDecision(root, a, approve, "owner");
}

// Approvals engine settle (Phase D item 1): execute every pending
// proposal the install's approval mode auto-approves, through the
// same decision path the owner uses. In the default manual mode
// this is a no-op by construction. Settle points are the surfaces
// that create proposals inside a live interaction (the chat tool
// layer, the CLI propose verb) plus the operator's `actions settle`
// verb; a proposal the mode does not cover stays pending for the
// owner, exactly as before.
export async function settleAutoApprovals(root: string, onlyId?: string): Promise<ActionProposal[]> {
  const policy = loadApprovalPolicy(root);
  if (policy.mode === "manual") return [];
  const settled: ActionProposal[] = [];
  const candidates = listActions(root).filter(x => x.status === "pending" && (!onlyId || x.id === onlyId));
  for (const candidate of candidates) {
    const auto = approvalAutoVia(policy, candidate.kind, candidate.supersedes);
    if (!auto) continue;
    const fresh = listActions(root).find(x => x.id === candidate.id);
    if (!fresh || fresh.status !== "pending") continue;
    settled.push(await applyDecision(root, fresh, true, auto.via));
  }
  return settled;
}

// Program G: the orchestration layer. Sam as coordinator of its own lanes:
// a job is decomposed into named lanes, each with a hired worker, a
// three-part done-shape (goal / done looks like / not done), scoped context,
// scoped permissions, and a place its result lands. Workers are invisible by
// default: the owner receives ONE consolidated result per job (landings,
// decisions that are his, blockers only he can clear), in the fleet reporting
// contract's shape. Lane internals live in this store and in the activity
// ledger, retrievable on ask through the CLI, never pushed at the owner.
//
// Design calls (lane's judgment, Dip 2026-11-14 "the most mature way"):
// - Boring where it should be boring: depth is capped at 2 in the store API
//   (Sam hires lanes at depth 1; only a depth-1 "coordinate" lane may open
//   worker lanes at depth 2; a depth-2 lane can never open a lane), results
//   are claims until the coordinator's deterministic checks verify them, and
//   the one approval gate is untouched: orchestration proposes nothing and
//   approves nothing, workers inherit Sam's law and fences.
// - Ambitious where it pays: fan-out is sized to the job, lanes run two at a
//   time (the spawn layer's concurrency cap), a stuck or rejected worker is
//   retired and replaced once inside the same job, and a failed lane is
//   named as a blocker in the consolidated result, never silently dropped.
// - Budgets ride the spawn layer's parent pool honestly: per-kind lane
//   budgets live in ORCH_LANE_BUDGETS (Lane F's owner-budget doctrine
//   landed as owner-turn budgets and left the spawn pool as it was, so
//   this seam stands). The coordinator reads the live
//   remaining pool before hiring and refuses a plan that cannot fit, with
//   the numbers named, instead of dying mid-run. A replaced worker is
//   retired (status cancelled through the registry's update door) so its
//   budget carve returns to the pool for its replacement.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import {
  ROLE_TOOLS, currentSpawnPool, listSubagents, ownerFold, profileToolNames,
  smallSpawnPool, spawnPoolRemaining, startBackgroundSubagent, updateSubagent,
  whenSubagentSettled, withSpawnPool, type Subagent,
} from "./subagents.js";
import { parseReview } from "./team-runtime.js";
import { ChatStore } from "./chats.js";
import { codeRoot } from "./code.js";
import { errorReason } from "./error-reason.js";

export const ORCH_MAX_DEPTH = 2;
export const ORCH_MAX_LANE_ATTEMPTS = 2;
const ORCH_CONCURRENCY = 2;

export type LaneKind = "research" | "build" | "verify" | "coordinate" | "general";
export type LaneStatus = "planned" | "assigned" | "working" | "verifying" | "done" | "failed" | "replaced";
export type LaneVerdict = "verified" | "unverified" | "rejected";
export type JobStatus = "planned" | "running" | "done" | "partial" | "blocked";

export interface LaneVerifySpec { artifact?: string; mustMention?: string[] }
export interface LaneSpec {
  name: string;
  kind: LaneKind;
  goal: string;
  doneLooksLike: string;
  notDoneLooksLike: string;
  landsAt: string;
  tools?: string[];
  facts?: string[];
  lawLines?: string[];
  dependsOn?: string[];
  verify?: LaneVerifySpec;
  workers?: LaneSpec[];
  /** Per-lane budget override (issue #96): a plan may price a lane
   *  explicitly; the price is honored exactly as given (validated
   *  against the per-worker caps) instead of the kind default being
   *  silently substituted - the recorded failure repriced every plan
   *  to the same totals no matter what the planner asked for. */
  budget?: { rounds: number; maxCalls: number };
}
export interface Lane {
  id: string; jobId: string; name: string; kind: LaneKind;
  goal: string; doneLooksLike: string; notDoneLooksLike: string; landsAt: string;
  tools: string[]; facts: string[]; lawLines: string[];
  dependsOn: string[]; verify: LaneVerifySpec | null;
  depth: number; parentLaneId: string | null;
  status: LaneStatus; workerId: string | null; attempts: number;
  result: string | null; verdict: LaneVerdict | null; verdictReasons: string | null;
  blocker: string | null;
  budget: { rounds: number; maxCalls: number };
  createdAt: string; updatedAt: string;
}
export interface OrchestrationJob {
  id: string; profile: string; ask: string; status: JobStatus;
  consolidated: string | null; createdAt: string; finishedAt: string | null;
  // Run-inspector fields (2026-11-14): the chat the dispatch came from when
  // the door passes one, and the worker pool as it stood at dispatch time.
  // Optional because jobs recorded before this change carry neither.
  chatId?: string | null;
  poolAtDispatch?: { rounds: number; maxCalls: number } | null;
}

// Lane budgets: the ONE seam where worker sizing lives. Lane F's
// owner-budget doctrine landed 2026-11-14 as owner-TURN budgets in
// budgets.ts (chatTurnBudget) and at first did not change the spawn
// layer's pool, so lane budgets were sized to the background pool
// {6, 16}. Defect 3 (2026-11-14, same day) scoped the pool to the
// hiring context (subagents.ts): an owner turn hires from a pool the
// size of its own tranche budget, so these per-lane budgets now read
// as the price of one lane inside whatever pool the hiring context
// carries, and remainingPool reads that live context. If the pool
// shape ever moves, it moves in subagents.ts and here, nowhere else.
export const ORCH_LANE_BUDGETS: Record<LaneKind, { rounds: number; maxCalls: number }> = {
  research: { rounds: 2, maxCalls: 5 },
  build: { rounds: 2, maxCalls: 6 },
  verify: { rounds: 2, maxCalls: 3 },
  coordinate: { rounds: 2, maxCalls: 4 },
  general: { rounds: 2, maxCalls: 4 },
};

/**
 * The budget one attempt of a lane is carved. Attempt 1 prices at the
 * kind's base budget; a replacement attempt (attempt 2) is carved
 * larger - one more round and twice the calls - because the failure
 * that earns a replacement is so often exhaustion (the worker spent
 * its turn orienting and ran out of steps before doing the work), and
 * retrying exhaustion on the identical budget is a designed repeat of
 * the same death. The carve is still clamped by the live pool in the
 * runner, and the plan-time pool check keeps pricing attempt 1 only:
 * a replacement is paid for by the retired worker's returned carve
 * plus whatever pool remains, and a pool that cannot fund it fails
 * the lane honestly at hire time.
 */
export function laneAttemptBudget(lane: Lane): { rounds: number; maxCalls: number } {
  if (lane.attempts <= 1) return { rounds: lane.budget.rounds, maxCalls: lane.budget.maxCalls };
  return { rounds: lane.budget.rounds + 1, maxCalls: lane.budget.maxCalls * 2 };
}

const ROLE_FOR_KIND: Record<LaneKind, Subagent["role"]> = {
  research: "research", build: "build", verify: "review", coordinate: "task", general: "task",
};
// Computed on first use, never at module init: profileToolNames() reads
// own-tools' catalog, and module load order inside that cycle is not
// guaranteed (a dashboard-side import chain reached this module while
// own-tools was still initializing and the init-time call crashed on the
// TDZ, 2026-11-14). Same values, evaluated when a lane actually needs them.
let roleToolsForKindCache: Record<LaneKind, string[]> | null = null;
function roleToolsForKind(): Record<LaneKind, string[]> {
  if (!roleToolsForKindCache) {
    roleToolsForKindCache = {
      research: ROLE_TOOLS.research,
      build: ROLE_TOOLS.build,
      verify: ROLE_TOOLS.review,
      coordinate: profileToolNames(),
      general: profileToolNames(),
    };
  }
  return roleToolsForKindCache;
}

function dbFile(root: string): string { return join(resolve(root), ".sam", "orchestration.db"); }
export function orchestrationStoreExists(root: string): boolean { return existsSync(dbFile(root)); }

export function orchestrationFailureSummary(phase: "read" | "write", reason: string): string {
  return "Orchestration store " + phase + " failed: " + reason.slice(0, 160);
}
/**
 * The reason a orchestration-failed line carries (census sprint
 * 2026-11-17): recordStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
/** The reason a failed lane attempt carries on its record
 * (census sprint 2026-11-17): runLane took error.message
 * alone, discarding error.cause, so a lane that died behind
 * a wrapper named nothing diagnosable on the job record.
 * Now it composes through errorReason (the 04:04 bridge
 * seam): causeless errors keep their plain message, a
 * non-Error reads through String, bot-token segments are
 * redacted, and no lane content ever enters the reason. */
export function laneFailureReason(error: unknown): string {
  return errorReason(error);
}

export function orchestrationStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

function recordStoreFailure(root: string, phase: "read" | "write", error: unknown): void {
  const reason = orchestrationStoreFailureReason(error);
  try { recordActivity(root, "sam", "orchestration-failed", orchestrationFailureSummary(phase, reason)); } catch { /* the ledger must never mask the store error */ }
}
function openStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(dbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS orch_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS orch_lanes (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, data TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS orch_refusals (id TEXT PRIMARY KEY, data TEXT NOT NULL);");
  return db;
}
function readJobs(root: string): OrchestrationJob[] {
  if (!orchestrationStoreExists(root)) return [];
  const db = openStore(root);
  try {
    return (db.prepare("SELECT data FROM orch_jobs ORDER BY rowid").all() as Array<{ data: string }>)
      .map(row => { try { return JSON.parse(row.data) as OrchestrationJob; } catch { return null; } })
      .filter((j): j is OrchestrationJob => j !== null);
  } catch (error) { recordStoreFailure(root, "read", error); throw error; } finally { db.close(); }
}
function readLanes(root: string, jobId?: string): Lane[] {
  if (!orchestrationStoreExists(root)) return [];
  const db = openStore(root);
  try {
    const rows = (jobId
      ? db.prepare("SELECT data FROM orch_lanes WHERE job_id = ? ORDER BY rowid").all(jobId)
      : db.prepare("SELECT data FROM orch_lanes ORDER BY rowid").all()) as Array<{ data: string }>;
    return rows.map(row => { try { return JSON.parse(row.data) as Lane; } catch { return null; } })
      .filter((l): l is Lane => l !== null);
  } catch (error) { recordStoreFailure(root, "read", error); throw error; } finally { db.close(); }
}
function putJob(root: string, job: OrchestrationJob): void {
  const db = openStore(root);
  try { db.prepare("INSERT OR REPLACE INTO orch_jobs (id, data) VALUES (?, ?)").run(job.id, JSON.stringify(job)); }
  catch (error) { recordStoreFailure(root, "write", error); throw error; } finally { db.close(); }
}
function putLane(root: string, lane: Lane): void {
  const db = openStore(root);
  try { db.prepare("INSERT OR REPLACE INTO orch_lanes (id, job_id, data) VALUES (?, ?, ?)").run(lane.id, lane.jobId, JSON.stringify(lane)); }
  catch (error) { recordStoreFailure(root, "write", error); throw error; } finally { db.close(); }
}
// A dispatch the pool refused, recorded at refusal time (2026-11-14, run
// inspector): before this, a refused plan threw and left no record at all,
// so the owner could never see what was asked versus what was available.
export interface DispatchRefusal {
  id: string; profile: string; chatId: string | null; ask: string;
  requested: { rounds: number; maxCalls: number };
  available: { rounds: number; maxCalls: number };
  reason: string; at: string;
}
function putRefusal(root: string, refusal: DispatchRefusal): void {
  const db = openStore(root);
  try { db.prepare("INSERT OR REPLACE INTO orch_refusals (id, data) VALUES (?, ?)").run(refusal.id, JSON.stringify(refusal)); }
  catch (error) { recordStoreFailure(root, "write", error); throw error; } finally { db.close(); }
}
/** Retract provisional refusal records by id. The hire door's
 *  tranche continuation (Defect 3) retries a refused plan in the
 *  turn's next tranche; when the retry hires, the first attempt's
 *  record described an event that did not finally happen, so the
 *  door retracts exactly the records its own attempts created.
 *  A refusal that stays refused keeps its record. */
export function deleteDispatchRefusals(root: string, ids: string[]): void {
  if (!ids.length || !orchestrationStoreExists(root)) return;
  const db = openStore(root);
  try { const del = db.prepare("DELETE FROM orch_refusals WHERE id = ?"); for (const id of ids) del.run(id); }
  catch (error) { recordStoreFailure(root, "write", error); throw error; } finally { db.close(); }
}

export function listDispatchRefusals(root: string, profile?: string): DispatchRefusal[] {
  if (!orchestrationStoreExists(root)) return [];
  const db = openStore(root);
  try {
    const rows = db.prepare("SELECT data FROM orch_refusals ORDER BY rowid").all() as Array<{ data: string }>;
    const all = rows.map(row => { try { return JSON.parse(row.data) as DispatchRefusal; } catch { return null; } })
      .filter((r): r is DispatchRefusal => r !== null);
    return profile ? all.filter(r => r.profile === profile) : all;
  } catch (error) { recordStoreFailure(root, "read", error); throw error; } finally { db.close(); }
}

// Thread furniture for blocked and refused runs: a team event whose content
// carries the callout marker; the dashboard renders those as compact
// callout cards with expandable evidence instead of prose bubbles.
export const CALLOUT_PREFIX = "[[callout]] ";
export function calloutEventContent(title: string, evidence: string): string {
  return CALLOUT_PREFIX + title + (evidence ? "\n" + evidence : "");
}
function writeChatCallout(root: string, chatId: string | null | undefined, title: string, evidence: string): void {
  if (!chatId) return;
  try {
    const store = new ChatStore(root);
    try { store.addEvent(chatId, "sam", "result", calloutEventContent(title, evidence)); }
    finally { store.close(); }
  } catch { /* furniture never breaks the run it describes */ }
}

export function updateLane(root: string, id: string, patch: Partial<Lane>): Lane | null {
  const lane = readLanes(root).find(l => l.id === id) ?? null;
  if (!lane) return null;
  const next = { ...lane, ...patch, updatedAt: new Date().toISOString() };
  putLane(root, next);
  return next;
}
export function getJob(root: string, id: string): OrchestrationJob | null {
  return readJobs(root).find(j => j.id === id) ?? null;
}
export function listJobs(root: string, profile?: string): OrchestrationJob[] {
  const jobs = readJobs(root);
  return profile ? jobs.filter(j => j.profile === profile) : jobs;
}
export function listLanes(root: string, jobId: string): Lane[] { return readLanes(root, jobId); }

/** A team that does not fit the hiring context's pool: the numbers
 *  ride as data so the hire door can continue the turn into its next
 *  tranche and retry, or answer with a value result, instead of the
 *  refusal dying as an opaque error (Defect 3). */
export class OrchestrationFitError extends Error {
  readonly poolRefusal = true;
  constructor(message: string, readonly remaining: { rounds: number; maxCalls: number }, readonly asks: { rounds: number; maxCalls: number }) {
    super(message);
    this.name = "OrchestrationFitError";
  }
}

/** The spawn pool a profile has left, read live from the sub-agent
 *  registry IN THE CURRENT HIRING CONTEXT (subagents.ts): an owner
 *  turn sees its tranche pool, anything else the small pool, counted
 *  per scope - never as a lifetime ledger (Defect 3). */
export function remainingPool(root: string, profile: string): { rounds: number; maxCalls: number } {
  const left = spawnPoolRemaining(listSubagents(root, profile), profile);
  return { rounds: left.rounds, maxCalls: left.maxCalls };
}

function laneTools(kind: LaneKind, requested: string[] | undefined, profileTools: string[]): string[] {
  const roleTools = roleToolsForKind()[kind].filter(name => profileTools.includes(name));
  if (!requested) return roleTools;
  const unknown = requested.filter(name => !profileTools.includes(name));
  if (unknown.length) throw new Error("Lane tools must be tools the profile actually has (default-deny): " + unknown.join(", "));
  // A lane may narrow its kind's hand, never widen past it.
  const widened = requested.filter(name => kind !== "coordinate" && kind !== "general" && !roleTools.includes(name));
  if (widened.length) throw new Error("Lane tools widen past the " + kind + " hand: " + widened.join(", "));
  return [...new Set(requested)];
}

/** The price of one lane: its explicit budget when the plan carries
 *  one, else the kind default. An explicit budget outside the
 *  per-worker caps is refused BY NAME - never silently repriced
 *  (issue #96). */
export function laneBudget(spec: LaneSpec): { rounds: number; maxCalls: number } {
  if (spec.budget === undefined) return { ...ORCH_LANE_BUDGETS[spec.kind] };
  const b = spec.budget;
  if (!b || !Number.isInteger(b.rounds) || !Number.isInteger(b.maxCalls) || b.rounds < 1 || b.rounds > 6 || b.maxCalls < 1 || b.maxCalls > 16)
    throw new Error("Lane " + (spec.name ?? "?") + " has an unsupported budget (" + JSON.stringify(b) + "): a lane budget is {rounds: 1 to 6, maxCalls: 1 to 16}. Give a budget inside those caps or omit it for the kind default.");
  return { rounds: b.rounds, maxCalls: b.maxCalls };
}

function validateSpec(spec: LaneSpec, profileTools: string[]): void {
  if (!spec.name?.trim() || !/^[a-z][a-z0-9-]{0,40}$/.test(spec.name.trim())) throw new Error("Lane needs a simple name (lowercase, dashes): " + (spec.name ?? ""));
  laneBudget(spec);
  for (const field of ["goal", "doneLooksLike", "notDoneLooksLike", "landsAt"] as const) {
    if (!spec[field]?.trim()) throw new Error("Lane " + spec.name + " is missing its done-shape: " + field + " is required (end goal / what done looks like / what done does not look like / where it lands)");
  }
  if (!["research", "build", "verify", "coordinate", "general"].includes(spec.kind)) throw new Error("Lane " + spec.name + " has an unknown kind: " + spec.kind);
  laneTools(spec.kind, spec.tools, profileTools);
}

export interface PlanInput { profile?: string; ask: string; lanes: LaneSpec[]; chatId?: string }

/**
 * Plan a job: validate every lane's done-shape, scope, and depth, check the
 * team fits the live remaining pool, and persist the plan. Nothing runs yet.
 */
export function planJob(root: string, input: PlanInput): { job: OrchestrationJob; lanes: Lane[] } {
  const profile = input.profile?.trim() || "sam";
  if (!input.ask?.trim()) throw new Error("An orchestrated job needs the ask it answers");
  if (!Array.isArray(input.lanes) || input.lanes.length === 0) throw new Error("An orchestrated job needs at least one lane");
  const profileTools = profileToolNames();
  const flat: Array<{ spec: LaneSpec; depth: number; parentName: string | null }> = [];
  const seen = new Set<string>();
  const walk = (spec: LaneSpec, depth: number, parentName: string | null): void => {
    validateSpec(spec, profileTools);
    const name = spec.name.trim();
    if (seen.has(name)) throw new Error("Lane names must be unique in a job: " + name);
    seen.add(name);
    if (depth > ORCH_MAX_DEPTH) throw new Error("Orchestration depth cap is " + ORCH_MAX_DEPTH + ": lane " + name + " would sit at depth " + depth);
    flat.push({ spec, depth, parentName });
    if (spec.workers?.length) {
      if (spec.kind !== "coordinate") throw new Error("Only a coordinate lane may open worker lanes: " + name + " is a " + spec.kind + " lane");
      for (const worker of spec.workers) walk(worker, depth + 1, name);
    }
  };
  for (const spec of input.lanes) walk(spec, 1, null);
  for (const { spec } of flat) {
    for (const dep of spec.dependsOn ?? []) {
      if (!seen.has(dep)) throw new Error("Lane " + spec.name + " depends on an unknown lane: " + dep);
      if (dep === spec.name) throw new Error("Lane " + spec.name + " cannot depend on itself");
    }
  }
  const total = flat.reduce((sum, { spec }) => {
    const b = laneBudget(spec);
    return { rounds: sum.rounds + b.rounds, maxCalls: sum.maxCalls + b.maxCalls };
  }, { rounds: 0, maxCalls: 0 });
  const left = remainingPool(root, profile);
  if (total.rounds > left.rounds || total.maxCalls > left.maxCalls) {
    const reason = "This team does not fit the remaining worker pool (" + left.rounds + " rounds, " + left.maxCalls + " calls left; the plan asks " + total.rounds + " rounds, " + total.maxCalls + " calls). Plan a smaller team or fewer lanes.";
    const refusal: DispatchRefusal = { id: randomUUID(), profile, chatId: input.chatId ?? null, ask: input.ask.trim(), requested: { ...total }, available: { ...left }, reason, at: new Date().toISOString() };
    try { putRefusal(root, refusal); } catch { /* the refusal record never masks the refusal itself */ }
    writeChatCallout(root, refusal.chatId, "Dispatch blocked · 0 of " + flat.length + " workers started",
      "Requested " + total.rounds + " rounds / " + total.maxCalls + " calls; available " + left.rounds + " rounds / " + left.maxCalls + " calls.\n" + reason);
    // The refusal is recorded and called out above; the throw stays
    // the TYPED fit error (Defect 3): the hire doors catch it to
    // continue the turn into its next tranche before any refusal
    // reaches the owner as a value.
    throw new OrchestrationFitError(reason, left, total);
  }
  const now = new Date().toISOString();
  const job: OrchestrationJob = { id: randomUUID(), profile, ask: input.ask.trim(), status: "planned", consolidated: null, createdAt: now, finishedAt: null, chatId: input.chatId ?? null, poolAtDispatch: { ...left } };
  putJob(root, job);
  const idByName = new Map<string, string>();
  const lanes: Lane[] = flat.map(({ spec, depth, parentName }) => {
    const lane: Lane = {
      id: randomUUID(), jobId: job.id, name: spec.name.trim(), kind: spec.kind,
      goal: spec.goal.trim(), doneLooksLike: spec.doneLooksLike.trim(), notDoneLooksLike: spec.notDoneLooksLike.trim(), landsAt: spec.landsAt.trim(),
      tools: laneTools(spec.kind, spec.tools, profileTools),
      facts: [...(spec.facts ?? [])], lawLines: [...(spec.lawLines ?? [])],
      dependsOn: [...(spec.dependsOn ?? [])], verify: spec.verify ?? null,
      depth, parentLaneId: null,
      status: "planned", workerId: null, attempts: 0, result: null, verdict: null, verdictReasons: null, blocker: null,
      budget: laneBudget(spec),
      createdAt: now, updatedAt: now,
    };
    idByName.set(lane.name, lane.id);
    return lane;
  });
  for (const lane of lanes) {
    const parent = flat.find(f => f.spec.name === lane.name)?.parentName;
    if (parent) lane.parentLaneId = idByName.get(parent) ?? null;
    putLane(root, lane);
  }
  recordActivity(root, profile, "orchestration-planned", orchestrationPlannedLedgerSummary(job.id, lanes.map(l => l.name)));
  return { job, lanes };
}

/**
 * The runtime door a coordinator lane uses to hire one more worker lane
 * mid-job. Depth is enforced here, in code: the parent must be a depth-1
 * coordinate lane; a worker lane (depth 2) can never open a lane.
 */
export function openWorkerLane(root: string, coordinatorLaneId: string, spec: LaneSpec): Lane {
  const parent = readLanes(root).find(l => l.id === coordinatorLaneId) ?? null;
  if (!parent) throw new Error("Unknown coordinator lane: " + coordinatorLaneId);
  if (parent.depth >= ORCH_MAX_DEPTH) throw new Error("Workers never spawn: lane " + parent.name + " is at depth " + parent.depth + ", the cap is " + ORCH_MAX_DEPTH);
  if (parent.kind !== "coordinate") throw new Error("Only a coordinate lane may open worker lanes: " + parent.name + " is a " + parent.kind + " lane");
  if (spec.workers?.length) throw new Error("A worker lane cannot carry its own workers: depth cap is " + ORCH_MAX_DEPTH);
  validateSpec(spec, profileToolNames());
  const job = getJob(root, parent.jobId);
  if (!job) throw new Error("Coordinator lane has no job: " + parent.jobId);
  if (readLanes(root, job.id).some(l => l.name === spec.name.trim())) throw new Error("Lane names must be unique in a job: " + spec.name);
  const now = new Date().toISOString();
  const lane: Lane = {
    id: randomUUID(), jobId: job.id, name: spec.name.trim(), kind: spec.kind,
    goal: spec.goal.trim(), doneLooksLike: spec.doneLooksLike.trim(), notDoneLooksLike: spec.notDoneLooksLike.trim(), landsAt: spec.landsAt.trim(),
    tools: laneTools(spec.kind, spec.tools, profileToolNames()),
    facts: [...(spec.facts ?? [])], lawLines: [...(spec.lawLines ?? [])],
    dependsOn: [...(spec.dependsOn ?? [])], verify: spec.verify ?? null,
    depth: parent.depth + 1, parentLaneId: parent.id,
    status: "planned", workerId: null, attempts: 0, result: null, verdict: null, verdictReasons: null, blocker: null,
    budget: laneBudget(spec), createdAt: now, updatedAt: now,
  };
  putLane(root, lane);
  recordActivity(root, job.profile, "orchestration-hired", orchestrationHiredLedgerSummary(lane.name, parent.name, lane.depth));
  return lane;
}

/** The scoped brief a worker sees: its lane's law and facts, never the whole profile. */
export function laneWorkerPrompt(lane: Lane, depResults: Array<{ name: string; result: string }>): string {
  const parts: string[] = [
    "You are " + lane.name + ", a worker S.A.M. hired for one lane of a larger job. You see only this lane; the coordinator verifies your result before anything reaches the owner.",
    "GOAL: " + lane.goal,
    "DONE LOOKS LIKE: " + lane.doneLooksLike,
    "NOT DONE: " + lane.notDoneLooksLike,
    "YOUR RESULT LANDS AT: " + lane.landsAt,
  ];
  if (lane.lawLines.length) parts.push("Standing rules for this lane:\n" + lane.lawLines.map(l => "- " + l).join("\n"));
  if (lane.facts.length) parts.push("Facts for this lane:\n" + lane.facts.map(f => "- " + f).join("\n"));
  for (const dep of depResults) parts.push("Result from the " + dep.name + " lane you depend on:\n" + dep.result.slice(0, 1200));
  parts.push("Return your result for the coordinator. Ground every fact in something you actually read or ran in this lane, and name the source (file, page, or command) next to the claim.");
  if (lane.kind === "verify") parts.push("VERDICT FORMAT (required): begin your reply with exactly one line, either 'VERDICT: approve' if the work matches its source exactly, or 'VERDICT: request-changes' if anything is off, then give the reasons. The coordinator cannot use a verdict it cannot parse.");
  if (lane.kind === "research" || lane.kind === "general") parts.push("End your result with a 'Sources:' line naming the exact files or pages you read in this lane. A result that names no source is returned unverified and does not land.");
  if (lane.kind === "build") parts.push("Your lane is done only when the artifact actually exists where it lands. Do the write, then end your result by confirming the exact artifact path you wrote; a narrative about what you intend to write does not land.");
  let prompt = parts.join("\n\n");
  if (prompt.length > 2000) prompt = prompt.slice(0, 1990) + "\n[brief trimmed]";
  return prompt;
}

export interface LaneVerdictResult { verdict: LaneVerdict; reasons: string }
/**
 * An artifact may live in the workspace or in the designated code root:
 * those are the two trees SAM's hands may write (Program E's slice
 * worktrees live in the code root's world). Absolute spellings and
 * spellings relative to either root resolve; anything else is an escape.
 */
export function confinedArtifact(root: string, artifact: string): string | null {
  const bases = [resolve(root)];
  const code = codeRoot(root);
  if (code) bases.push(resolve(code));
  for (const base of bases) {
    const path = resolve(base, artifact);
    if (path !== base && path.startsWith(base + sep) && existsSync(path)) return path;
  }
  for (const base of bases) {
    const path = resolve(base, artifact);
    if (path !== base && path.startsWith(base + sep)) return path;
  }
  return null;
}
/**
 * The incompletion shapes a worker's reply can take when it never
 * finished the lane's work: SAM's own budget fallbacks (the chat
 * loops' steps and calls forms, budgets.ts), the sub-agent loop's
 * round-budget stop (subagents.ts), and the empty-handed "(no
 * result)". These are SAM's own fixed strings, matched by prefix, so
 * a worker's genuine prose is never mistaken for one. An
 * incompletion is NOT a result: grading it as a claim misdiagnoses
 * the lane (live proof, job 16781c45, 2026-11-14: both research
 * workers returned the steps fallback verbatim after spending their
 * turns orienting, and the coordinator failed them for "names no
 * source" - the lanes did not produce sourceless research, they
 * produced nothing). The runner routes an incompletion through the
 * failure path with this reason, so the replacement machinery fires
 * and the consolidated result names what actually happened.
 */
export function workerIncompleteReason(resultText: string): string | null {
  const text = (resultText ?? "").trim();
  if (!text) return "the worker returned nothing";
  if (text === "(no result)") return "the worker returned no result";
  if (text.startsWith("I ran out of steps for this turn (")) return "the worker ran out of steps before finishing, so its reply is the budget fallback, not a result";
  if (text.startsWith("I reached the tool budget for this turn (")) return "the worker hit its tool budget before finishing, so its reply is the budget fallback, not a result";
  if (text.startsWith("Sub-agent stopped at its round budget (")) return "the worker stopped at its round budget before finishing";
  return null;
}

/** The coordinator's deterministic checks. A worker's output is a claim until these pass. */
export function verifyLaneOutput(root: string, lane: Lane, resultText: string): LaneVerdictResult {
  const text = (resultText ?? "").trim();
  if (!text) return { verdict: "rejected", reasons: "The worker returned nothing." };
  if (lane.kind === "verify") {
    const review = parseReview(text);
    return review.verdict === "approve"
      ? { verdict: "verified", reasons: "Verify lane returned an approve verdict." }
      : { verdict: "rejected", reasons: "Verify lane did not approve: " + review.reasons.slice(0, 300) };
  }
  // The artifact is the explicit verify spec, or the first file named in
  // landsAt (planners phrase landsAt as sentences: "one-pager.md in the
  // code root" must still yield its artifact). A build lane with no
  // checkable artifact is a claim the coordinator cannot verify, so it
  // comes back unverified, never verified on narrative alone (proof run
  // 2026-11-14: a build worker's mid-work narrative verified while no
  // file existed).
  const artifact = lane.verify?.artifact ?? lane.landsAt.match(/[\w./-]+\.(md|txt|html|json|csv)\b/i)?.[0];
  if (lane.kind === "build" && !artifact) {
    return { verdict: "unverified", reasons: "Build lane names no checkable artifact (no verify.artifact and no file in landsAt), so the coordinator cannot verify the build landed." };
  }
  if (artifact) {
    const path = confinedArtifact(root, artifact);
    if (!path) return { verdict: "rejected", reasons: "Artifact path escapes the workspace: " + artifact };
    if (!existsSync(path)) return { verdict: "rejected", reasons: "The claimed artifact does not exist: " + artifact };
    const content = readFileSync(path, "utf8");
    const missing = (lane.verify?.mustMention ?? []).filter(m => !content.toLowerCase().includes(m.toLowerCase()));
    if (missing.length) return { verdict: "rejected", reasons: "Artifact " + artifact + " is missing required content: " + missing.join(", ") };
    return { verdict: "verified", reasons: "Artifact " + artifact + " exists" + (lane.verify?.mustMention?.length ? " and carries every required mention" : "") + "." };
  }
  const missing = (lane.verify?.mustMention ?? []).filter(m => !text.toLowerCase().includes(m.toLowerCase()));
  if (missing.length) return { verdict: "rejected", reasons: "Result is missing required content: " + missing.join(", ") };
  if (lane.kind === "research" || lane.kind === "general") {
    const hasSource = /\[\d+\]/.test(text) || /https?:\/\/\S+/.test(text) || /[\w./-]+\.(md|ts|js|json|txt|html)\b/.test(text);
    if (!hasSource) return { verdict: "unverified", reasons: "Result names no source (no citation, file, or page), so the coordinator cannot verify its claims." };
  }
  return { verdict: "verified", reasons: "Result is non-empty and carries the required evidence." };
}

/** The fleet reporting contract, applied to a finished job: landings, owner decisions, blockers. No lane internals. */
export function buildConsolidatedResult(job: OrchestrationJob, lanes: Lane[]): string {
  const landed = lanes.filter(l => l.status === "done" && l.verdict === "verified");
  const blocked = lanes.filter(l => l.status === "failed" || (l.status === "done" && l.verdict !== "verified"));
  const lines: string[] = [];
  lines.push((blocked.length === 0 ? "Done: " : "Partly done: ") + job.ask);
  if (landed.length) {
    lines.push("Landed:");
    for (const lane of landed) lines.push("- " + lane.name + " (" + lane.landsAt + "): " + ownerFold(lane.result ?? "").slice(0, 400));
  }
  if (blocked.length) {
    lines.push("Blocked:");
    for (const lane of blocked) lines.push("- " + lane.name + ": " + (lane.blocker ?? lane.verdictReasons ?? "did not land"));
  }
  lines.push("Ask for the lane detail any time; the workers and their retries stay out of your way otherwise.");
  return lines.join("\n");
}

export type LaneRunner = (root: string, lane: Lane, depResults: Array<{ name: string; result: string }>) => Promise<string>;
let testRunner: LaneRunner | null = null;
export function setOrchestrationRunnerForTests(runner: LaneRunner | null): void { testRunner = runner; }

async function defaultLaneRunner(root: string, job: OrchestrationJob, lane: Lane, depResults: Array<{ name: string; result: string }>): Promise<string> {
  const left = remainingPool(root, job.profile);
  const attemptBudget = laneAttemptBudget(lane);
  const budget = {
    rounds: Math.max(1, Math.min(attemptBudget.rounds, left.rounds)),
    maxCalls: Math.max(2, Math.min(attemptBudget.maxCalls, left.maxCalls)),
  };
  if (left.rounds < 1 || left.maxCalls < 2) throw new Error("The worker pool is exhausted (" + left.rounds + " rounds, " + left.maxCalls + " calls left)");
  // The worker id is recorded BEFORE the run settles: spawnSubagent throws
  // on a failed worker, so recording afterwards leaked the failed worker's
  // budget carve (the coordinator could not retire what it could not name,
  // and the replacement plus every later lane starved). Live proof run 3,
  // 2026-11-14: build attempt 1 failed uncancelled at {2,6}, the verify
  // lane then found 0 rounds and 0 calls left. The background door hands
  // back the id up front and settles with the finished record.
  const started = startBackgroundSubagent(root, {
    profile: job.profile,
    prompt: laneWorkerPrompt(lane, depResults),
    role: ROLE_FOR_KIND[lane.kind],
    tools: lane.tools,
    rounds: budget.rounds,
    maxCalls: budget.maxCalls,
    quiet: true,
  });
  const after = updateLane(root, lane.id, { workerId: started.id });
  if (after) lane.workerId = after.workerId;
  const child = await whenSubagentSettled(started.id);
  if (child.status !== "done") throw new Error("Worker " + child.id.slice(0, 8) + " ended " + child.status + ": " + (child.result ?? "no result").slice(0, 200));
  return child.result ?? "";
}

function retireWorker(root: string, lane: Lane): void {
  if (!lane.workerId) return;
  try {
    const items = listSubagents(root);
    const item = items.find(s => s.id === lane.workerId);
    if (item && item.status !== "cancelled") updateSubagent(root, item.id, { status: "cancelled", result: "Retired by the coordinator: the lane was replaced." });
  } catch { /* retiring is bookkeeping; the replacement proceeds regardless */ }
}

async function runLane(root: string, job: OrchestrationJob, lane: Lane, lanes: Lane[]): Promise<void> {
  const depResults = lane.dependsOn.map(name => {
    const dep = lanes.find(l => l.name === name);
    return { name, result: dep?.result ?? "" };
  });
  updateLane(root, lane.id, { status: "assigned" });
  while (true) {
    const current = updateLane(root, lane.id, { status: "working", attempts: lane.attempts + 1 });
    if (current) { lane.attempts = current.attempts; lane.status = current.status; }
    let outcome: string | null = null;
    let failure: string | null = null;
    try {
      outcome = testRunner ? await testRunner(root, lane, depResults) : await defaultLaneRunner(root, job, lane, depResults);
    } catch (error) { failure = laneFailureReason(error); }
    if (outcome !== null) {
      const incomplete = workerIncompleteReason(outcome);
      if (incomplete !== null) {
        // An incompletion is not a result: nothing was produced, so
        // there is nothing to verify and nothing to store as the
        // lane's answer. It takes the failure path below with its
        // true reason, and the replacement is carved the larger
        // attempt budget (laneAttemptBudget).
        failure = "Worker did not finish: " + incomplete + ".";
      } else {
        const verdict = verifyLaneOutput(root, lane, outcome);
        if (verdict.verdict === "verified") {
          const done = updateLane(root, lane.id, { status: "done", result: outcome, verdict: verdict.verdict, verdictReasons: verdict.reasons, blocker: null });
          if (done) Object.assign(lane, done);
          recordActivity(root, job.profile, "orchestration-lane-done", orchestrationLaneDoneLedgerSummary(lane.name, job.id, lane.attempts));
          return;
        }
        failure = "Coordinator verification " + verdict.verdict + ": " + verdict.reasons;
        updateLane(root, lane.id, { result: outcome, verdict: verdict.verdict, verdictReasons: verdict.reasons });
        lane.result = outcome; lane.verdict = verdict.verdict; lane.verdictReasons = verdict.reasons;
        if (verdict.verdict === "unverified") {
          // Not a worker failure: the claim simply is not verified, so it does
          // not land and is named in the consolidated result as-is.
          const done = updateLane(root, lane.id, { status: "done", blocker: "Unverified: " + verdict.reasons });
          if (done) Object.assign(lane, done);
          return;
        }
      }
    }
    // Failure or rejection: retire the worker and replace it once.
    if (lane.attempts < ORCH_MAX_LANE_ATTEMPTS) {
      retireWorker(root, lane);
      updateLane(root, lane.id, { status: "replaced", workerId: null });
      lane.workerId = null;
      recordActivity(root, job.profile, "orchestration-lane-replaced", orchestrationLaneReplacedLedgerSummary(lane.name, job.id, failure));
      continue;
    }
    const failed = updateLane(root, lane.id, { status: "failed", blocker: (failure ?? "Worker failed").slice(0, 400) });
    if (failed) Object.assign(lane, failed);
    recordActivity(root, job.profile, "orchestration-lane-failed", orchestrationLaneFailedLedgerSummary(lane.name, job.id, failure));
    return;
  }
}

/**
 * Run a planned job end to end: lanes whose dependencies verified run two at
 * a time; a lane whose dependency did not land is failed by name with the
 * reason. The job closes with exactly one consolidated result.
 */
export async function runJob(root: string, jobId: string): Promise<{ job: OrchestrationJob; lanes: Lane[] }> {
  const job = getJob(root, jobId);
  if (!job) throw new Error("Unknown orchestration job: " + jobId);
  job.status = "running"; putJob(root, job);
  const lanes = readLanes(root, jobId);
  const byName = new Map(lanes.map(l => [l.name, l]));
  const terminal = (l: Lane): boolean => l.status === "done" || l.status === "failed";
  let progressed = true;
  while (progressed) {
    progressed = false;
    // Coordinate lanes are structural: one closes when every worker lane it
    // opened is terminal, verified only if all of them verified.
    for (const lane of lanes) {
      if (lane.kind !== "coordinate" || lane.status !== "planned") continue;
      const workers = lanes.filter(l => l.parentLaneId === lane.id);
      if (!workers.every(l => terminal(l))) continue;
      const failedWorker = workers.find(l => l.status !== "done" || l.verdict !== "verified");
      const closed = failedWorker
        ? updateLane(root, lane.id, { status: "failed", blocker: "Worker lane " + failedWorker.name + " did not land: " + (failedWorker.blocker ?? failedWorker.verdictReasons ?? "not verified") })
        : updateLane(root, lane.id, { status: "done", verdict: "verified", verdictReasons: "Every worker lane under this coordinator verified.", result: "Coordinated " + workers.length + " worker lane(s): " + workers.map(w => w.name).join(", ") });
      if (closed) { Object.assign(lane, closed); progressed = true; }
    }
    const runnable = lanes.filter(l => l.status === "planned" && l.kind !== "coordinate" && l.dependsOn.every(name => { const d = byName.get(name); return d && d.status === "done" && d.verdict === "verified"; }));
    for (let i = 0; i < runnable.length; i += ORCH_CONCURRENCY) {
      const wave = runnable.slice(i, i + ORCH_CONCURRENCY);
      await Promise.all(wave.map(l => runLane(root, job, l, lanes)));
      progressed = true;
    }
    // Lanes whose dependencies failed or came back unverified are blocked by name.
    for (const lane of lanes) {
      if (lane.status !== "planned") continue;
      const badDep = lane.dependsOn.map(name => byName.get(name)).find(d => d && (d.status === "failed" || (d.status === "done" && d.verdict !== "verified")));
      if (badDep) {
        const failed = updateLane(root, lane.id, { status: "failed", blocker: "Dependency " + badDep.name + " did not land: " + (badDep.blocker ?? badDep.verdictReasons ?? "not verified") });
        if (failed) Object.assign(lane, failed);
        progressed = true;
      }
    }
  }
  const stuck = lanes.filter(l => l.status === "planned" || l.status === "assigned" || l.status === "working");
  for (const lane of stuck) {
    const failed = updateLane(root, lane.id, { status: "failed", blocker: "Lane never became runnable (dependency cycle or unmet dependency)" });
    if (failed) Object.assign(lane, failed);
  }
  const fresh = readLanes(root, jobId);
  const anyFailed = fresh.some(l => l.status === "failed");
  const anyUnverified = fresh.some(l => l.status === "done" && l.verdict !== "verified");
  job.status = anyFailed || anyUnverified ? (fresh.some(l => l.status === "done" && l.verdict === "verified") ? "partial" : "blocked") : "done";
  job.consolidated = buildConsolidatedResult(job, fresh);
  job.finishedAt = new Date().toISOString();
  putJob(root, job);
  recordActivity(root, job.profile, "orchestration-job-done", orchestrationJobDoneLedgerSummary(job.id, job.status, fresh.filter(l => l.verdict === "verified").length, fresh.length));
  if (job.chatId && job.status !== "done") {
    const verified = fresh.filter(l => l.status === "done" && l.verdict === "verified").length;
    const evidence = fresh.filter(l => !(l.status === "done" && l.verdict === "verified"))
      .map(l => l.name + ": " + (l.blocker ?? l.verdictReasons ?? l.status)).join("\n");
    writeChatCallout(root, job.chatId, "Run " + job.status + " · " + verified + " of " + fresh.length + " lanes landed", evidence);
  }
  return { job, lanes: fresh };
}

// The ONE writers for the orchestration lifecycle lines, so
// the scorecard's parsers below can never drift from the
// seams they count. Each shape is byte-identical to what
// its seam wrote inline before these writers existed: the
// planned (job prefix, lane count, lane names), the hired
// (lane name, coordinator name, depth), the lane-done (lane
// name, job prefix, attempts), the lane-replaced and
// lane-failed (lane name, job prefix, the failure capped at
// 160), and the job-done (job prefix, the closed status,
// verified of total lanes).
export function orchestrationPlannedLedgerSummary(jobId: string, laneNames: string[]): string {
  return "Job " + jobId.slice(0, 8) + ": " + laneNames.length + " lane(s) planned (" + laneNames.join(", ") + ")";
}
export function orchestrationHiredLedgerSummary(laneName: string, coordinatorName: string, depth: number): string {
  return "Lane " + laneName + " opened under coordinator " + coordinatorName + " at depth " + depth;
}
export function orchestrationLaneDoneLedgerSummary(laneName: string, jobId: string, attempts: number): string {
  return "Lane " + laneName + " verified for job " + jobId.slice(0, 8) + " (attempt " + attempts + ")";
}
export function orchestrationLaneReplacedLedgerSummary(laneName: string, jobId: string, failure: string | null): string {
  return "Lane " + laneName + " worker retired and replaced in job " + jobId.slice(0, 8) + ": " + (failure ?? "failed").slice(0, 160);
}
export function orchestrationLaneFailedLedgerSummary(laneName: string, jobId: string, failure: string | null): string {
  return "Lane " + laneName + " failed in job " + jobId.slice(0, 8) + ": " + (failure ?? "").slice(0, 160);
}
export function orchestrationJobDoneLedgerSummary(jobId: string, status: string, verified: number, total: number): string {
  return "Job " + jobId.slice(0, 8) + " closed " + status + ": " + verified + "/" + total + " lane(s) verified";
}

// The orchestration scorecard (2026-11-19, the
// measured-proof series): every job SAM runs as a team
// ledgers its lifecycle across six activity kinds - planned,
// hired, lane-done, lane-replaced, lane-failed, job-done -
// carrying job prefixes, lane names, and, on the replaced
// and failed lines, the failure's head. No daily surface
// ever counted them, so orchestration going silent, lanes
// dying and being replaced, or jobs closing with nothing
// verified was invisible in aggregate. The text folds
// counts only: per-stage counts, the summed planned lanes,
// the job-done lines' summed verified-of-total lanes, the
// closed counts per fixed status bucket (done, partial,
// blocked, other), and the distinct-job count as a NUMBER
// only, parsed from the fixed summaries. A summary matching
// no fixed shape for its kind counts under that kind as
// unparseable and contributes nothing else, and no stamp,
// actor, job id, lane name, coordinator name, failure text,
// or verbatim summary is ever printed - a lane's failure is
// its job's detail, and it does not belong in a trending
// surface. The verdict is attention when any lane failed or
// was replaced, any job closed partial or blocked, or any
// line is unparseable, else clear. No stamp and no actor
// enters the text, so a quiet day is byte-identical and
// P3-silent, and a dead lane, a blocked job, a malformed
// line, or a mix shift is the news. A pure read: it creates
// nothing, spends no model call, plans nothing, and runs
// nothing - the ledger and the lifecycle seams are
// untouched, and running a job stays the door's job.
export function parseOrchestrationSummary(kind: string, summary: string): { job?: string; lanes?: number; status?: string; verified?: number; total?: number } | null {
  if (kind === "orchestration-planned") {
    const m = /^Job (\S+): (\d+) lane\(s\) planned \(.*\)$/.exec(summary);
    return m ? { job: m[1], lanes: Number(m[2]) } : null;
  }
  if (kind === "orchestration-hired") {
    const m = /^Lane .+ opened under coordinator .+ at depth \d+$/.exec(summary);
    return m ? {} : null;
  }
  if (kind === "orchestration-lane-done") {
    const m = /^Lane .+ verified for job (\S+) \(attempt \d+\)$/.exec(summary);
    return m ? { job: m[1] } : null;
  }
  if (kind === "orchestration-lane-replaced") {
    const m = /^Lane .+ worker retired and replaced in job (\S+): /.exec(summary);
    return m ? { job: m[1] } : null;
  }
  if (kind === "orchestration-lane-failed") {
    const m = /^Lane .+ failed in job (\S+): /.exec(summary);
    return m ? { job: m[1] } : null;
  }
  if (kind === "orchestration-job-done") {
    const m = /^Job (\S+) closed (\S+): (\d+)\/(\d+) lane\(s\) verified$/.exec(summary);
    return m ? { job: m[1], status: m[2], verified: Number(m[3]), total: Number(m[4]) } : null;
  }
  return null;
}
export function orchestrationScorecardText(root: string): string {
  const stages: [string, string][] = [
    ["orchestration-planned", "Jobs planned"],
    ["orchestration-hired", "Lanes hired"],
    ["orchestration-lane-done", "Lanes verified"],
    ["orchestration-lane-replaced", "Lanes replaced"],
    ["orchestration-lane-failed", "Lanes failed"],
    ["orchestration-job-done", "Jobs closed"],
  ];
  const jobs = new Set<string>();
  let lanesPlanned = 0;
  let lanesFailed = 0;
  let lanesReplaced = 0;
  let verifiedAtClose = 0;
  let totalAtClose = 0;
  const outcomes: Record<string, number> = { done: 0, partial: 0, blocked: 0, other: 0 };
  let unparseable = 0;
  const counts: string[] = [];
  for (const [kind, label] of stages) {
    const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind });
    for (const line of lines) {
      const parsed = parseOrchestrationSummary(kind, line.summary);
      if (!parsed) { unparseable += 1; continue; }
      if (parsed.job) jobs.add(parsed.job);
      if (kind === "orchestration-planned") lanesPlanned += parsed.lanes ?? 0;
      if (kind === "orchestration-job-done") {
        verifiedAtClose += parsed.verified ?? 0;
        totalAtClose += parsed.total ?? 0;
        const bucket = parsed.status === "done" || parsed.status === "partial" || parsed.status === "blocked" ? parsed.status : "other";
        outcomes[bucket] += 1;
      }
    }
    if (kind === "orchestration-lane-failed") lanesFailed = lines.length;
    if (kind === "orchestration-lane-replaced") lanesReplaced = lines.length;
    counts.push(label + ": " + String(lines.length));
  }
  const badClose = outcomes.partial + outcomes.blocked + outcomes.other;
  const out: string[] = [];
  out.push("Orchestration: " + (lanesFailed > 0 || lanesReplaced > 0 || badClose > 0 || unparseable > 0 ? "attention" : "clear"));
  out.push(...counts);
  out.push("Lanes planned: " + String(lanesPlanned));
  out.push("Verified at close: " + String(verifiedAtClose) + " of " + String(totalAtClose));
  out.push("Closed outcomes: done " + String(outcomes.done) + ", partial " + String(outcomes.partial) + ", blocked " + String(outcomes.blocked) + ", other " + String(outcomes.other));
  out.push("Distinct jobs: " + String(jobs.size));
  if (unparseable > 0) out.push("Unparseable: " + String(unparseable));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never plans or runs a job, never prints a job id, a lane name, or a failure; a dead or replaced lane, a job that closed short of done, a malformed line, or a mix shift is the news");
  return out.join("\n");
}

/**
 * Plan and run in one call: the door the chat tool and the CLI share.
 * Submission is idempotent by ask inside a 15-minute window: a repeat
 * call for the same ask returns the existing job instead of planning a
 * second team (proof run 2026-11-14: a coordinator that re-called the
 * tool after a job closed spiralled into pool refusals and died on the
 * loader-loop guard; the job had already run).
 */
export async function orchestrate(root: string, input: PlanInput): Promise<{ job: OrchestrationJob; lanes: Lane[] }> {
  // A job submitted with no hiring context (the CLI, a test) carries
  // its own small-pool scope, so its workers' carves are the job's
  // books and never leak into the next job's pool (Defect 3). Inside
  // a turn, the turn's context rules and nothing is re-scoped.
  if (!currentSpawnPool()) {
    return withSpawnPool(smallSpawnPool("job:" + randomUUID()), () => orchestrateInContext(root, input));
  }
  return orchestrateInContext(root, input);
}

async function orchestrateInContext(root: string, input: PlanInput): Promise<{ job: OrchestrationJob; lanes: Lane[] }> {
  const profile = input.profile?.trim() || "sam";
  const ask = input.ask?.trim() ?? "";
  if (ask) {
    const cutoff = Date.now() - 15 * 60 * 1000;
    const existing = listJobs(root, profile).find(j => j.ask === ask && new Date(j.createdAt).getTime() >= cutoff);
    if (existing) return { job: existing, lanes: readLanes(root, existing.id) };
  }
  const { job } = planJob(root, input);
  return runJob(root, job.id);
}

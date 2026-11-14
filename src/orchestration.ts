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
import { recordActivity } from "./activity.js";
import {
  PARENT_POOL, ROLE_TOOLS, listSubagents, ownerFold, profileToolNames,
  spawnSubagent, updateSubagent, type Subagent,
} from "./subagents.js";
import { parseReview } from "./team-runtime.js";
import { codeRoot } from "./code.js";

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
}

// Lane budgets: the ONE seam where worker sizing lives. Lane F's
// owner-budget doctrine landed 2026-11-14 as owner-TURN budgets in
// budgets.ts (chatTurnBudget) and deliberately did not change the spawn
// layer's parent pool {6, 16}, so lane budgets stay sized to that pool:
// a three-lane job fits with headroom for one replacement after its
// retired worker's carve returns. If the pool shape ever moves, it
// moves here and in remainingPool, nowhere else.
export const ORCH_LANE_BUDGETS: Record<LaneKind, { rounds: number; maxCalls: number }> = {
  research: { rounds: 2, maxCalls: 5 },
  build: { rounds: 2, maxCalls: 6 },
  verify: { rounds: 1, maxCalls: 3 },
  coordinate: { rounds: 2, maxCalls: 4 },
  general: { rounds: 2, maxCalls: 4 },
};

const ROLE_FOR_KIND: Record<LaneKind, Subagent["role"]> = {
  research: "research", build: "build", verify: "review", coordinate: "task", general: "task",
};
const ROLE_TOOLS_FOR_KIND: Record<LaneKind, string[]> = {
  research: ROLE_TOOLS.research,
  build: ROLE_TOOLS.build,
  verify: ROLE_TOOLS.review,
  coordinate: profileToolNames(),
  general: profileToolNames(),
};

function dbFile(root: string): string { return join(resolve(root), ".sam", "orchestration.db"); }
export function orchestrationStoreExists(root: string): boolean { return existsSync(dbFile(root)); }

export function orchestrationFailureSummary(phase: "read" | "write", reason: string): string {
  return "Orchestration store " + phase + " failed: " + reason.slice(0, 160);
}
function recordStoreFailure(root: string, phase: "read" | "write", error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  try { recordActivity(root, "sam", "orchestration-failed", orchestrationFailureSummary(phase, reason)); } catch { /* the ledger must never mask the store error */ }
}
function openStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(dbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS orch_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS orch_lanes (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, data TEXT NOT NULL);");
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

/** The spawn pool a profile has left, read live from the sub-agent registry. */
export function remainingPool(root: string, profile: string): { rounds: number; maxCalls: number } {
  const used = listSubagents(root, profile)
    .filter(s => s.status !== "cancelled")
    .reduce((sum, s) => ({ rounds: sum.rounds + s.budget.rounds, maxCalls: sum.maxCalls + s.budget.maxCalls }), { rounds: 0, maxCalls: 0 });
  return { rounds: Math.max(0, PARENT_POOL.rounds - used.rounds), maxCalls: Math.max(0, PARENT_POOL.maxCalls - used.maxCalls) };
}

function laneTools(kind: LaneKind, requested: string[] | undefined, profileTools: string[]): string[] {
  const roleTools = ROLE_TOOLS_FOR_KIND[kind].filter(name => profileTools.includes(name));
  if (!requested) return roleTools;
  const unknown = requested.filter(name => !profileTools.includes(name));
  if (unknown.length) throw new Error("Lane tools must be tools the profile actually has (default-deny): " + unknown.join(", "));
  // A lane may narrow its kind's hand, never widen past it.
  const widened = requested.filter(name => kind !== "coordinate" && kind !== "general" && !roleTools.includes(name));
  if (widened.length) throw new Error("Lane tools widen past the " + kind + " hand: " + widened.join(", "));
  return [...new Set(requested)];
}

function validateSpec(spec: LaneSpec, profileTools: string[]): void {
  if (!spec.name?.trim() || !/^[a-z][a-z0-9-]{0,40}$/.test(spec.name.trim())) throw new Error("Lane needs a simple name (lowercase, dashes): " + (spec.name ?? ""));
  for (const field of ["goal", "doneLooksLike", "notDoneLooksLike", "landsAt"] as const) {
    if (!spec[field]?.trim()) throw new Error("Lane " + spec.name + " is missing its done-shape: " + field + " is required (end goal / what done looks like / what done does not look like / where it lands)");
  }
  if (!["research", "build", "verify", "coordinate", "general"].includes(spec.kind)) throw new Error("Lane " + spec.name + " has an unknown kind: " + spec.kind);
  laneTools(spec.kind, spec.tools, profileTools);
}

export interface PlanInput { profile?: string; ask: string; lanes: LaneSpec[] }

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
    const b = ORCH_LANE_BUDGETS[spec.kind];
    return { rounds: sum.rounds + b.rounds, maxCalls: sum.maxCalls + b.maxCalls };
  }, { rounds: 0, maxCalls: 0 });
  const left = remainingPool(root, profile);
  if (total.rounds > left.rounds || total.maxCalls > left.maxCalls) {
    throw new Error("This team does not fit the remaining worker pool (" + left.rounds + " rounds, " + left.maxCalls + " calls left; the plan asks " + total.rounds + " rounds, " + total.maxCalls + " calls). Plan a smaller team or fewer lanes.");
  }
  const now = new Date().toISOString();
  const job: OrchestrationJob = { id: randomUUID(), profile, ask: input.ask.trim(), status: "planned", consolidated: null, createdAt: now, finishedAt: null };
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
      budget: { ...ORCH_LANE_BUDGETS[spec.kind] },
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
  recordActivity(root, profile, "orchestration-planned", "Job " + job.id.slice(0, 8) + ": " + lanes.length + " lane(s) planned (" + lanes.map(l => l.name).join(", ") + ")");
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
    budget: { ...ORCH_LANE_BUDGETS[spec.kind] }, createdAt: now, updatedAt: now,
  };
  putLane(root, lane);
  recordActivity(root, job.profile, "orchestration-hired", "Lane " + lane.name + " opened under coordinator " + parent.name + " at depth " + lane.depth);
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
  const artifact = lane.verify?.artifact ?? (/\.(md|txt|html|json|csv)$/i.test(lane.landsAt.trim()) ? lane.landsAt.trim() : undefined);
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
  const budget = {
    rounds: Math.max(1, Math.min(lane.budget.rounds, left.rounds)),
    maxCalls: Math.max(2, Math.min(lane.budget.maxCalls, left.maxCalls)),
  };
  if (left.rounds < 1 || left.maxCalls < 2) throw new Error("The worker pool is exhausted (" + left.rounds + " rounds, " + left.maxCalls + " calls left)");
  const child = await spawnSubagent(root, {
    profile: job.profile,
    prompt: laneWorkerPrompt(lane, depResults),
    role: ROLE_FOR_KIND[lane.kind],
    tools: lane.tools,
    rounds: budget.rounds,
    maxCalls: budget.maxCalls,
    quiet: true,
  });
  const after = updateLane(root, lane.id, { workerId: child.id });
  if (after) lane.workerId = after.workerId;
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
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (outcome !== null) {
      const verdict = verifyLaneOutput(root, lane, outcome);
      if (verdict.verdict === "verified") {
        const done = updateLane(root, lane.id, { status: "done", result: outcome, verdict: verdict.verdict, verdictReasons: verdict.reasons, blocker: null });
        if (done) Object.assign(lane, done);
        recordActivity(root, job.profile, "orchestration-lane-done", "Lane " + lane.name + " verified for job " + job.id.slice(0, 8) + " (attempt " + lane.attempts + ")");
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
    // Failure or rejection: retire the worker and replace it once.
    if (lane.attempts < ORCH_MAX_LANE_ATTEMPTS) {
      retireWorker(root, lane);
      updateLane(root, lane.id, { status: "replaced", workerId: null });
      lane.workerId = null;
      recordActivity(root, job.profile, "orchestration-lane-replaced", "Lane " + lane.name + " worker retired and replaced in job " + job.id.slice(0, 8) + ": " + (failure ?? "failed").slice(0, 160));
      continue;
    }
    const failed = updateLane(root, lane.id, { status: "failed", blocker: (failure ?? "Worker failed").slice(0, 400) });
    if (failed) Object.assign(lane, failed);
    recordActivity(root, job.profile, "orchestration-lane-failed", "Lane " + lane.name + " failed in job " + job.id.slice(0, 8) + ": " + (failure ?? "").slice(0, 160));
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
  recordActivity(root, job.profile, "orchestration-job-done", "Job " + job.id.slice(0, 8) + " closed " + job.status + ": " + fresh.filter(l => l.verdict === "verified").length + "/" + fresh.length + " lane(s) verified");
  return { job, lanes: fresh };
}

/** Plan and run in one call: the door the chat tool and the CLI share. */
export async function orchestrate(root: string, input: PlanInput): Promise<{ job: OrchestrationJob; lanes: Lane[] }> {
  const { job } = planJob(root, input);
  return runJob(root, job.id);
}

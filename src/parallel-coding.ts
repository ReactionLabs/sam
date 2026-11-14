import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { codeRoot, defaultCodeRunner, type CodeRunner } from "./code.js";
import { gitRepoRoot, isTaskBranch } from "./git-work.js";
import { defaultEngineRunner, engineArgv, engineRunBinary, selectedEngineProvider, type EngineRunProvider, type EngineRunner, type EngineTask } from "./engine.js";
import type { GoldfishChangeInput, GoldfishRecord } from "./goldfish.js";

/**
 * Parallel coding (Program E, Dip's ruling 2026-11-14: "We need to
 * really get it better at coding and doing parallel work. Like
 * write 20 files at once if it needs to.").
 *
 * The C3 loop and the C6 engine are serial by construction: both
 * check out ONE task branch in the ONE designated code-root tree,
 * so two writers can never be in the tree at once. This module is
 * the fan-out shape that keeps every fence they established:
 *
 * - SURVEY BEFORE SLICES: a job begins with a structured survey of
 *   the repo (tree, file count, key files, package scripts) taken
 *   at the base the job will actually use and recorded on the job
 *   record - slices are cut against a read of the repo, never
 *   blind.
 * - ISOLATION: each slice works in its own git worktree on its own
 *   sam/par-<job>-<slice> branch, all cut from the job's base SHA.
 *   Writers never share a tree, and the code root's own checkout
 *   is never touched - a dirty owner tree does not block a
 *   parallel job, and a parallel job never sweeps the owner's
 *   uncommitted work, because worktrees only ever carry committed
 *   base content.
 * - EXECUTION: a slice is one managed-engine pass (the selected
 *   provider, the same fixed argv as a C6 run) inside its
 *   worktree, with a per-slice timeout and ONE retry that carries
 *   the failure's own output back to the engine. A slice that
 *   still fails is reported BY NAME in the job's result - never
 *   silently dropped, never averaged away.
 * - VERIFY, TWO LEVELS: each slice runs the repo's build/test in
 *   its own tree when the repo defines them (recorded on the
 *   slice; an isolated failure is named, since a slice whose work
 *   needs a sibling slice's files cannot go green alone), and the
 *   COORDINATOR battery on the merged tree is the binding gate.
 * - COORDINATOR: slice branches merge in declaration order into
 *   the job branch (sam/par-<job>) inside a coordinator worktree.
 *   A conflicting slice aborts its merge and is reported by name
 *   with its conflicted files. A red merged battery feeds bounded
 *   fix iterations (engine passes in the coordinator tree, each
 *   ledgered) - a job may not report done on a red battery.
 * - REVIEW: the merged diff is reviewed fresh-context through
 *   the goldfish diff door (goldfish.ts runGoldfishDiffReview)
 *   when a reviewer is wired; the production doors wire it (or a
 *   refusing stub), so unreviewed or blocked work closes blocked,
 *   exactly the C5 contract. Parallel changes deliberately never
 *   enter the workspace change/write ledgers the serial paths
 *   count from - the job record plus the git branches are the
 *   record, and the serial loops' accounting is never disturbed.
 * - GATES INTACT: everything lands as LOCAL commits on sam/*
 *   branches. The job branch name passes the same isTaskBranch
 *   shape as a coding task's, so pushing it rides the ONE gate's
 *   git-push proposal, owner-approved, exactly as before. This
 *   module never pushes and never opens a PR.
 *
 * Deletions are outside the parallel shape: a slice that deletes
 * a file fails by name (the C6 unreviewable posture - SAM cannot
 * diff-review a deletion through this door yet).
 */

export type ParallelStatus = "queued" | "running" | "done" | "blocked" | "failed";
export type SliceStatus = "queued" | "running" | "done" | "failed" | "conflicted";

export interface RepoSurvey {
  baseSha: string;
  branch: string | null;
  fileCount: number;
  files: string[];
  filesTruncated: boolean;
  byExtension: Record<string, number>;
  keyFiles: string[];
  scripts: Record<string, string>;
}

export interface ParallelSlice {
  name: string;
  task: string;
  files: string[];
  branch: string;
  worktree: string | null;
  status: SliceStatus;
  attempts: number;
  changes: string[];
  verification: string | null;
  durationMs: number | null;
  error: string | null;
  output: string | null;
}

export interface ParallelJob {
  id: string; actor: string; chatId: string; spec: string; title: string;
  provider: EngineRunProvider | null;
  status: ParallelStatus;
  concurrency: number; maxVerifyIterations: number; sliceTimeoutMs: number;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null;
  baseSha: string | null; branch: string | null;
  survey: RepoSurvey | null;
  slices: ParallelSlice[];
  merges: Array<{ slice: string; ok: boolean; conflicts: string[] }>;
  verifyIterations: Array<{ n: number; buildOk: boolean | null; testOk: boolean | null; output: string }>;
  verification: string | null;
  review: string | null;
  result: string | null;
  filesTouched: string[];
}

const MAX_OPEN_JOBS = 3;
const MAX_SLICES = 24;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_VERIFY_ITERATIONS = 2;
const MAX_VERIFY_ITERATIONS = 3;
const DEFAULT_SLICE_TIMEOUT_MS = 600_000;
const STALE_RUNNING_MS = 60 * 60000;
const OUTPUT_TAIL_CHARS = 2_000;
const SLICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function parallelJobBranch(job: { id: string }): string {
  return "sam/par-" + job.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}
export function parallelSliceBranch(job: { id: string }, sliceName: string): string {
  return parallelJobBranch(job) + "-" + sliceName;
}

// ---- the store -------------------------------------------------------
// SQLite, the house pattern (.sam/parallel.db, one row per job
// holding the job's full JSON, rowid order = queue order). New
// store with no predecessor file, so there is no legacy migration;
// connections carry the F1 busy_timeout so the dashboard process
// queuing and a CLI drain writing never lose each other's rows. A
// pure read on an install with no store creates nothing.

function parallelDbFile(root: string): string { return join(resolve(root), ".sam", "parallel.db"); }
function openParallelStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(parallelDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS parallel_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return db;
}
function rowToJob(data: string): ParallelJob | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as ParallelJob : null; }
  catch { return null; }
}
export function listParallelJobs(root: string): ParallelJob[] {
  if (!existsSync(parallelDbFile(root))) return [];
  const db = openParallelStore(root);
  try {
    const rows = db.prepare("SELECT data FROM parallel_jobs ORDER BY rowid").all() as Array<{ data: string }>;
    const items: ParallelJob[] = [];
    for (const row of rows) { const job = rowToJob(row.data); if (job) items.push(job); }
    return items;
  } finally { db.close(); }
}
export function getParallelJob(root: string, id: string): ParallelJob | null {
  if (!existsSync(parallelDbFile(root))) return null;
  const db = openParallelStore(root);
  try {
    const row = db.prepare("SELECT data FROM parallel_jobs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToJob(row.data) : null;
  } finally { db.close(); }
}
function insertParallelJob(root: string, item: ParallelJob): void {
  const db = openParallelStore(root);
  try { db.prepare("INSERT INTO parallel_jobs (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  finally { db.close(); }
}
function saveParallelJob(root: string, item: ParallelJob): void {
  const db = openParallelStore(root);
  try { db.prepare("UPDATE parallel_jobs SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  finally { db.close(); }
}
export function updateParallelJob(root: string, id: string, patch: Partial<ParallelJob>): ParallelJob | null {
  if (!existsSync(parallelDbFile(root))) return null;
  const current = getParallelJob(root, id);
  if (!current) return null;
  const next: ParallelJob = { ...current, ...patch, id: current.id };
  saveParallelJob(root, next);
  return next;
}

export function parallelSummary(root: string): { root: string | null; queued: number; running: number; done: number; blocked: number; failed: number; recent: ParallelJob[] } {
  const items = listParallelJobs(root);
  const count = (s: ParallelStatus) => items.filter(j => j.status === s).length;
  return { root: codeRoot(root), queued: count("queued"), running: count("running"), done: count("done"), blocked: count("blocked"), failed: count("failed"), recent: items.slice(-10) };
}

// ---- git plumbing (fixed argv only, worktree-scoped) -----------------

function gitIn(dir: string, args: string[], timeoutMs = 60_000): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const text = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { ok: false, out: (text || err.message || "git failed").trim() };
  }
}

/** Every path a worktree disagrees with its HEAD about, deletions
 *  flagged - the git-work.ts worktreeChanges shape, scoped to any
 *  tree (a slice or coordinator worktree) instead of the code root. */
function changesIn(dir: string): Array<{ path: string; deleted: boolean }> {
  const probe = gitIn(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!probe.ok) throw new Error("Could not read git status in " + dir + ": " + probe.out.slice(0, 200));
  const fields = probe.out.split("\0");
  const out: Array<{ path: string; deleted: boolean }> = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (xy.includes("R") || xy.includes("C")) i++;
    out.push({ path, deleted: xy.includes("D") });
  }
  return out;
}

/** Commit exactly `paths` in `dir` under a fixed SAM identity -
 *  staged by name, never add-all (the C4 posture, worktree-scoped).
 *  Returns the commit SHA, or null when nothing was staged. */
function commitPathsIn(dir: string, paths: string[], message: string): string | null {
  const wanted = [...new Set(paths)].filter(p => typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes(".."));
  if (!wanted.length) return null;
  const add = gitIn(dir, ["add", "--", ...wanted]);
  if (!add.ok) throw new Error("git add failed: " + add.out.slice(0, 240));
  const staged = gitIn(dir, ["diff", "--cached", "--name-only", "--", ...wanted]);
  const stagedPaths = staged.ok ? staged.out.split("\n").map(s => s.trim()).filter(Boolean) : [];
  if (!stagedPaths.length) return null;
  const commit = gitIn(dir, ["-c", "user.name=SAM", "-c", "user.email=sam@localhost", "commit", "-m", message, "--", ...stagedPaths]);
  if (!commit.ok) throw new Error("git commit failed: " + commit.out.slice(0, 240));
  const sha = gitIn(dir, ["rev-parse", "HEAD"]);
  return sha.ok ? sha.out.trim() : null;
}

function worktreeBase(root: string, jobId: string): string {
  return join(resolve(root), ".sam", "parallel", jobId);
}

function addWorktree(repo: string, path: string, branch: string, baseSha: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const made = gitIn(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (!made.ok) throw new Error("git worktree add failed for " + branch + ": " + made.out.slice(0, 240));
}

function removeWorktree(repo: string, path: string): void {
  gitIn(repo, ["worktree", "remove", "--force", path]);
  try { rmSync(path, { recursive: true, force: true }); } catch { /* the branch carries the work; the dir is scratch */ }
}

// ---- the survey --------------------------------------------------------

const KEY_FILES = ["package.json", "README.md", "tsconfig.json", "Cargo.toml", "pyproject.toml", "go.mod", "Makefile"];
const SURVEY_FILE_CAP = 500;

/** The structured read a job cuts its slices against: the tree at
 *  the base SHA, its size and shape, the key files present, and
 *  the package scripts that define build/test. Read from git, so
 *  it describes committed content exactly - the same content every
 *  slice worktree will hold. */
export function surveyRepo(root: string): RepoSurvey {
  const repo = gitRepoRoot(root);
  if (!repo) throw new Error("The designated code root is not a git repository rooted at itself - a parallel job surveys and branches a git tree.");
  const head = gitIn(repo, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new Error("The code root's git repository has no commits yet - make the first commit outside SAM, then queue the job.");
  const baseSha = head.out.trim();
  const branchProbe = gitIn(repo, ["branch", "--show-current"]);
  const tree = gitIn(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
  const all = tree.ok ? tree.out.split("\n").map(s => s.trim()).filter(Boolean) : [];
  const byExtension: Record<string, number> = {};
  for (const f of all) {
    const dot = f.lastIndexOf(".");
    const ext = dot > 0 ? f.slice(dot + 1).toLowerCase() : "(none)";
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) if (typeof v === "string") scripts[k] = v;
  } catch { /* no package.json: scripts stay empty and verify says so */ }
  return {
    baseSha,
    branch: branchProbe.ok ? (branchProbe.out.trim() || null) : null,
    fileCount: all.length,
    files: all.slice(0, SURVEY_FILE_CAP),
    filesTruncated: all.length > SURVEY_FILE_CAP,
    byExtension,
    keyFiles: KEY_FILES.filter(k => all.includes(k)),
    scripts,
  };
}

function surveyLine(survey: RepoSurvey): string {
  const exts = Object.entries(survey.byExtension).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + " x" + v).join(", ");
  return "Repo survey at " + survey.baseSha.slice(0, 12) + (survey.branch ? " (branch " + survey.branch + ")" : "") + ": " + survey.fileCount + " files (" + exts + "); key files: " + (survey.keyFiles.join(", ") || "none") + "; scripts: " + (Object.keys(survey.scripts).join(", ") || "none") + ".";
}

// ---- queue ---------------------------------------------------------------

export interface ParallelSliceSpec { name: string; task: string; files?: string[] }
export interface QueueParallelInput {
  actor: string; chatId: string; spec: string;
  slices: ParallelSliceSpec[];
  concurrency?: number; maxVerifyIterations?: number; sliceTimeoutMs?: number;
}

export function queueParallelJob(root: string, input: QueueParallelInput, env: NodeJS.ProcessEnv = process.env): ParallelJob {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const spec = (input.spec ?? "").trim();
  if (!spec || spec.length > 4000) throw new Error("Invalid parallel job spec");
  if (!input.chatId) throw new Error("A chat is required");
  if (!codeRoot(root)) throw new Error("No code root is designated on this install, so there is nowhere for a parallel job to work. The operator designates one with: sam code set-root <path>.");
  if (!gitRepoRoot(root)) throw new Error("The designated code root is not a git repository rooted at itself - parallel jobs branch and merge a git tree (the C4 sandbox story). Initialize or designate a git tree first.");
  if (!Array.isArray(input.slices) || input.slices.length < 1 || input.slices.length > MAX_SLICES) throw new Error("A parallel job needs 1 to " + MAX_SLICES + " slices");
  const seen = new Set<string>();
  for (const slice of input.slices) {
    if (!slice || typeof slice.name !== "string" || !SLICE_NAME.test(slice.name)) throw new Error("Invalid slice name (lowercase, digits, dashes; max 32): " + JSON.stringify(slice?.name ?? null));
    if (seen.has(slice.name)) throw new Error("Duplicate slice name: " + slice.name);
    seen.add(slice.name);
    const task = (slice.task ?? "").trim();
    if (!task || task.length > 2000) throw new Error("Invalid task for slice " + slice.name + " (1 to 2000 characters)");
    for (const f of slice.files ?? []) {
      if (typeof f !== "string" || !f || f.startsWith("/") || f.split("/").includes("..")) throw new Error("Invalid planned file for slice " + slice.name + ": " + JSON.stringify(f));
    }
  }
  // The same executability bar as the engine gate: the provider
  // that will run is resolved and proven installed NOW, and the
  // snapshot rides the job - the provider approved is the
  // provider that runs.
  const provider = selectedEngineProvider(root);
  if (!engineRunBinary(provider, env)) throw new Error("The managed coding engine (" + provider + ") is not installed on this machine - a parallel job's slices run through it. Installing it is the operator's act.");
  const db = new ChatStore(root);
  try { db.messages(input.chatId); } finally { db.close(); }
  const items = listParallelJobs(root);
  if (items.filter(j => j.status === "queued" || j.status === "running").length >= MAX_OPEN_JOBS) throw new Error("Parallel job queue is full");
  const id = randomUUID();
  const branch = parallelJobBranch({ id });
  const job: ParallelJob = {
    id, actor: input.actor, chatId: input.chatId, spec,
    title: spec.slice(0, 120), provider, status: "queued",
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(input.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY)),
    maxVerifyIterations: Math.max(0, Math.min(MAX_VERIFY_ITERATIONS, Math.floor(input.maxVerifyIterations ?? DEFAULT_VERIFY_ITERATIONS) || 0)),
    sliceTimeoutMs: Math.max(30_000, Math.min(900_000, Math.floor(input.sliceTimeoutMs ?? DEFAULT_SLICE_TIMEOUT_MS) || DEFAULT_SLICE_TIMEOUT_MS)),
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, durationMs: null,
    baseSha: null, branch, survey: null,
    slices: input.slices.map(s => ({
      name: s.name, task: s.task.trim(), files: [...(s.files ?? [])],
      branch: branch + "-" + s.name, worktree: null, status: "queued" as SliceStatus,
      attempts: 0, changes: [], verification: null, durationMs: null, error: null, output: null,
    })),
    merges: [], verifyIterations: [], verification: null, review: null, result: null, filesTouched: [],
  };
  insertParallelJob(root, job);
  recordActivity(root, input.actor, "parallel-queued", "Queued parallel job (" + job.slices.length + " slices, concurrency " + job.concurrency + ", engine " + provider + "): " + job.title);
  return job;
}

// ---- execution -----------------------------------------------------------

export interface ParallelDrainDeps {
  /** The engine process runner (tests inject a fake engine). */
  runEngine?: EngineRunner;
  /** Verify runner for build/test in worktrees (tests may inject). */
  codeRunner?: CodeRunner;
  /** Fresh-context review over the merged diff (the goldfish diff
   *  door). Production drains wire defaultDiffReviewer or a
   *  refusing stub; a drain without one closes on the battery
   *  alone and the job's review field stays null saying so - the
   *  coding loop's contract. */
  reviewDiff?: (spec: string, changes: GoldfishChangeInput[]) => Promise<GoldfishRecord>;
  env?: NodeJS.ProcessEnv;
}

const SLICE_FOOTER = "\n\nParallel-slice rules from SAM (the coordinator): you are ONE slice of a parallel job, working in your own git worktree on your own branch. Other slices are writing OTHER files in their own trees at the same time - write only the files your slice names, never another slice's files, and never files outside your slice's scope. Shared contracts (names, signatures, formats) are fixed by the job spec above: build exactly to it so the merged result agrees.";

function slicePrompt(job: ParallelJob, slice: ParallelSlice, survey: RepoSurvey, retryNote: string | null): string {
  const parts = [
    "Parallel coding job: " + job.spec,
    surveyLine(survey),
    "Your slice (" + slice.name + "): " + slice.task,
  ];
  if (slice.files.length) parts.push("Files your slice owns: " + slice.files.join(", ") + ".");
  if (retryNote) parts.push("This is a RETRY. The previous attempt failed: " + retryNote + "\nThe worktree still holds that attempt's partial work - fix the cause, do not start over blindly.");
  return parts.join("\n\n");
}

function worktreeScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}

async function runVerify(dir: string, runner: CodeRunner): Promise<{ buildOk: boolean | null; testOk: boolean | null; output: string }> {
  const scripts = worktreeScripts(dir);
  let buildOk: boolean | null = null; let testOk: boolean | null = null;
  const tails: string[] = [];
  if (scripts.build) {
    const r = await runner("npm", ["run", "build"], dir, 120_000);
    buildOk = r.exitCode === 0 && !r.timedOut;
    tails.push("build exit " + String(r.exitCode) + (r.timedOut ? " (timed out)" : "") + ": " + (r.output ?? "").slice(-600));
  }
  if (scripts.test) {
    const r = await runner("npm", ["run", "test"], dir, 120_000);
    testOk = r.exitCode === 0 && !r.timedOut;
    tails.push("test exit " + String(r.exitCode) + (r.timedOut ? " (timed out)" : "") + ": " + (r.output ?? "").slice(-600));
  }
  return { buildOk, testOk, output: tails.join("\n") };
}

async function runSlice(root: string, repo: string, job: ParallelJob, slice: ParallelSlice, deps: ParallelDrainDeps, survey: RepoSurvey): Promise<void> {
  const started = Date.now();
  slice.status = "running";
  const worktree = join(worktreeBase(root, job.id), slice.name);
  slice.worktree = worktree;
  try { addWorktree(repo, worktree, slice.branch, job.baseSha as string); }
  catch (e) {
    slice.status = "failed";
    slice.error = e instanceof Error ? e.message : "worktree creation failed";
    slice.durationMs = Date.now() - started;
    return;
  }
  // Persist at slice START, not only at completion: a real engine
  // run takes minutes, and a record that reads "queued" while the
  // engine is visibly working lies to every reader (caught live in
  // the 2026-11-14 proof run, where the correct response - kill a
  // healthy drain - was only avoided by checking the process list).
  saveParallelJob(root, job);
  const runner = deps.runEngine ?? defaultEngineRunner;
  const verifyRunner = deps.codeRunner ?? defaultCodeRunner;
  const provider = job.provider ?? "claude-code";
  let lastFailure: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    slice.attempts = attempt;
    saveParallelJob(root, job);
    const prompt = slicePrompt(job, slice, survey, lastFailure);
    const fakeTask = { spec: prompt, provider } as unknown as EngineTask;
    let outcome: { exitCode: number | null; output: string; timedOut?: boolean };
    try { outcome = await runner(depsBinary(deps, provider), engineArgv(fakeTask, provider), worktree, job.sliceTimeoutMs); }
    catch (e) { outcome = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
    slice.output = (outcome.output ?? "").slice(-OUTPUT_TAIL_CHARS);
    if (outcome.timedOut || outcome.exitCode !== 0) {
      lastFailure = outcome.timedOut
        ? "The engine run timed out after " + Math.round(job.sliceTimeoutMs / 1000) + "s and was killed. Output tail: " + slice.output.slice(-500)
        : "The engine exited with code " + String(outcome.exitCode) + ". Output tail: " + slice.output.slice(-500);
      continue;
    }
    let changes: Array<{ path: string; deleted: boolean }> = [];
    try { changes = changesIn(worktree); }
    catch (e) { lastFailure = "Could not enumerate the slice's changes: " + (e instanceof Error ? e.message : String(e)); continue; }
    const deleted = changes.filter(c => c.deleted).map(c => c.path);
    if (deleted.length) {
      lastFailure = "The slice deleted file(s) (" + deleted.join(", ") + ") - deletions are outside the parallel shape (SAM cannot diff-review a deletion through this door). Restore them and make the change another way.";
      continue;
    }
    if (!changes.length) { lastFailure = "The engine made no changes in its worktree."; continue; }
    const verify = await runVerify(worktree, verifyRunner);
    if (verify.buildOk === null && verify.testOk === null) slice.verification = "no build/test scripts in the slice tree - the coordinator battery is the only verify";
    else slice.verification = "build: " + (verify.buildOk === null ? "n/a" : verify.buildOk ? "pass" : "FAIL") + ", test: " + (verify.testOk === null ? "n/a" : verify.testOk ? "pass" : "FAIL");
    if (verify.buildOk === false || verify.testOk === false) {
      lastFailure = "The slice's own build/test failed in isolation: " + verify.output.slice(-700);
      // An isolated failure is data, not a verdict: the slice may
      // depend on a sibling's files. One retry lets the engine fix
      // a genuine defect; if it still fails, the slice's changes
      // are committed and named, and the merged battery decides.
      if (attempt < 2) continue;
      try {
        commitPathsIn(worktree, changes.map(c => c.path), "sam: " + job.title.slice(0, 60) + " (slice " + slice.name + ")");
        slice.changes = changes.map(c => c.path);
        slice.status = "done";
        slice.error = "Isolated verify failed (recorded); the slice's work is committed and the coordinator battery decides the job.";
      } catch (e) {
        slice.status = "failed";
        slice.error = e instanceof Error ? e.message : "slice commit failed";
      }
      slice.durationMs = Date.now() - started;
      return;
    }
    try {
      commitPathsIn(worktree, changes.map(c => c.path), "sam: " + job.title.slice(0, 60) + " (slice " + slice.name + ")");
      slice.changes = changes.map(c => c.path);
      slice.status = "done";
      slice.error = null;
    } catch (e) {
      lastFailure = "Committing the slice's work failed: " + (e instanceof Error ? e.message : String(e));
      continue;
    }
    slice.durationMs = Date.now() - started;
    return;
  }
  slice.status = "failed";
  slice.error = lastFailure;
  slice.durationMs = Date.now() - started;
}

function depsBinary(deps: ParallelDrainDeps, provider: EngineRunProvider): string {
  // The drain resolves the real binary before slices run (and
  // refuses the job when it is missing); a test's injected runner
  // never spawns it, so the name is a placeholder there.
  return engineRunBinary(provider, deps.env ?? process.env) ?? provider;
}

async function runPool(items: ParallelSlice[], cap: number, fn: (slice: ParallelSlice) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function postToChat(root: string, chatId: string, text: string): void {
  try { const db = new ChatStore(root); try { db.add(chatId, "assistant", text); } finally { db.close(); } } catch { /* chat gone; the job record stands */ }
}

export function parallelSummaryText(job: ParallelJob): string {
  const outcome = job.status === "done"
    ? "Parallel job done: " + job.title
    : job.status === "blocked"
      ? "Parallel job blocked (not done): " + job.title
      : job.status === "failed"
        ? "Parallel job failed: " + job.title
        : "Parallel job " + job.status + ": " + job.title;
  const lines = [outcome];
  if (job.durationMs !== null) lines.push("Wall-clock: " + Math.round(job.durationMs / 100) / 10 + "s, concurrency " + job.concurrency + ", engine " + (job.provider ?? "unknown") + ".");
  if (job.survey) lines.push(job.survey ? "Survey: " + surveyLine(job.survey) : "");
  if (job.branch) lines.push("Git: job branch " + job.branch + " at base " + (job.baseSha ?? "?").slice(0, 12) + " - local commits only; pushing the branch is an owner-approved git-push proposal.");
  lines.push("Slices (" + job.slices.filter(s => s.status === "done").length + "/" + job.slices.length + " done):");
  for (const s of job.slices) {
    const bits = ["- " + s.name + ": " + s.status];
    if (s.changes.length) bits.push(s.changes.length + " file(s): " + s.changes.join(", "));
    if (s.attempts > 1) bits.push("attempts " + s.attempts);
    if (s.durationMs !== null) bits.push(Math.round(s.durationMs / 100) / 10 + "s");
    if (s.verification) bits.push("verify [" + s.verification + "]");
    if (s.error) bits.push("note: " + s.error.slice(0, 240));
    lines.push(bits.join(" - "));
  }
  const conflicts = job.merges.filter(m => !m.ok);
  if (conflicts.length) lines.push("Merge conflicts: " + conflicts.map(m => m.slice + " (" + m.conflicts.join(", ") + ")").join("; ") + ".");
  if (job.verifyIterations.length) lines.push("Coordinator fix iterations: " + job.verifyIterations.length + " (" + job.verifyIterations.map(v => "#" + v.n + " build " + (v.buildOk === null ? "n/a" : v.buildOk ? "pass" : "FAIL") + "/test " + (v.testOk === null ? "n/a" : v.testOk ? "pass" : "FAIL")).join("; ") + ").");
  lines.push("Verification: " + (job.verification ?? "unknown") + ".");
  if (job.review) lines.push("Self-review: " + job.review + ".");
  if (job.filesTouched.length) lines.push("Files touched (" + job.filesTouched.length + "): " + job.filesTouched.join(", "));
  if (job.result) lines.push(job.result);
  return lines.join("\n").slice(0, 12_000);
}

const draining = new Set<string>();

export async function drainParallelJobs(root: string, deps: ParallelDrainDeps = {}): Promise<{ ran: string[]; blocked: string[]; failed: string[]; recovered: string[] }> {
  const key = resolve(root);
  if (draining.has(key)) return { ran: [], blocked: [], failed: [], recovered: [] };
  draining.add(key);
  const ran: string[] = []; const blocked: string[] = []; const failed: string[] = []; const recovered: string[] = [];
  try {
    const now = Date.now();
    for (const j of listParallelJobs(root)) {
      if (j.status === "running" && j.startedAt && now - Date.parse(j.startedAt) > STALE_RUNNING_MS) {
        updateParallelJob(root, j.id, { status: "failed", finishedAt: new Date().toISOString(), result: "Runner stopped mid-job; marked failed by the next drain. Slice branches, if any were created, stay for inspection." });
        recovered.push(j.id);
        recordActivity(root, j.actor, "parallel-failed", "Parallel job died mid-run: " + j.title);
      }
    }
    const queued = listParallelJobs(root).filter(j => j.status === "queued").slice(0, 1);
    for (const queuedJob of queued) {
      const found = getParallelJob(root, queuedJob.id);
      if (!found || found.status !== "queued") continue;
      const job = updateParallelJob(root, queuedJob.id, { status: "running", startedAt: new Date().toISOString() }) ?? found;
      const jobStart = Date.now();
      recordActivity(root, job.actor, "parallel-started", "Parallel job started: " + job.title + " (" + job.slices.length + " slices, concurrency " + job.concurrency + ")");
      const repo = codeRoot(root) ? gitRepoRoot(root) : null;
      const close = (status: ParallelStatus, result: string) => {
        job.status = status;
        job.result = result.slice(0, 600);
        job.finishedAt = new Date().toISOString();
        job.durationMs = Date.now() - jobStart;
        // Files touched = what the job branch actually carries
        // against the base (slices plus any coordinator fix
        // commits), read from git; the slice union is the fallback
        // when no job branch was ever created.
        job.filesTouched = [...new Set(job.slices.flatMap(s => s.changes))].sort();
        if (repo && job.branch && job.baseSha) {
          const diff = gitIn(repo, ["diff", "--name-only", job.baseSha + ".." + job.branch]);
          if (diff.ok) job.filesTouched = diff.out.split("\n").map(s => s.trim()).filter(Boolean).sort();
        }
        // Worktrees are scratch; the branches carry every slice's
        // commits and the merged result. Remove the trees, keep
        // the branches, prune the registrations.
        if (repo) {
          for (const s of job.slices) if (s.worktree) removeWorktree(repo, s.worktree);
          const mergedTree = join(worktreeBase(root, job.id), "_merged");
          removeWorktree(repo, mergedTree);
          gitIn(repo, ["worktree", "prune"]);
        }
        saveParallelJob(root, job);
        postToChat(root, job.chatId, parallelSummaryText(job));
        if (status === "done") { ran.push(job.id); recordActivity(root, job.actor, "parallel-done", "Parallel job done: " + job.title + " (" + job.filesTouched.length + " files, " + job.slices.length + " slices, " + Math.round((job.durationMs ?? 0) / 100) / 10 + "s)"); }
        else if (status === "blocked") { blocked.push(job.id); recordActivity(root, job.actor, "parallel-blocked", "Parallel job blocked: " + job.title + " - " + result.slice(0, 140)); }
        else { failed.push(job.id); recordActivity(root, job.actor, "parallel-failed", "Parallel job failed: " + job.title + " - " + result.slice(0, 140)); }
      };
      if (!repo) { close("blocked", "The designated code root is not a git repository rooted at itself - a parallel job has no tree to branch. Designate a git code root and re-queue."); continue; }
      const provider = job.provider ?? selectedEngineProvider(root);
      job.provider = provider;
      if (!deps.runEngine && !engineRunBinary(provider, deps.env ?? process.env)) {
        close("failed", "The managed coding engine (" + provider + ") is not installed on this machine - no engine binary is resolvable. Installing it is the operator's act.");
        continue;
      }
      // SURVEY: the read the slices are cut against.
      let survey: RepoSurvey;
      try { survey = surveyRepo(root); }
      catch (e) { close("blocked", "The repo survey refused the job: " + (e instanceof Error ? e.message : String(e))); continue; }
      job.survey = survey;
      job.baseSha = survey.baseSha;
      saveParallelJob(root, job);
      recordActivity(root, job.actor, "parallel-survey", surveyLine(survey));
      // FAN-OUT: slices run concurrently, bounded by the job's cap.
      await runPool(job.slices, job.concurrency, async slice => {
        await runSlice(root, repo, job, slice, deps, survey);
        saveParallelJob(root, job);
        recordActivity(root, job.actor, "parallel-slice", "Slice " + slice.name + " " + slice.status + " for parallel job: " + job.title + (slice.error ? " - " + slice.error.slice(0, 140) : ""));
      });
      saveParallelJob(root, job);
      const doneSlices = job.slices.filter(s => s.status === "done");
      const failedSlices = job.slices.filter(s => s.status === "failed");
      if (!doneSlices.length) {
        close("blocked", "Every slice failed, so there is nothing to merge: " + job.slices.map(s => s.name + " (" + (s.error ?? "failed").slice(0, 140) + ")").join("; ") + ". The slice branches stay for inspection.");
        continue;
      }
      // COORDINATOR: merge the done slices, in declaration order,
      // into the job branch inside its own worktree.
      const mergedTree = join(worktreeBase(root, job.id), "_merged");
      try { addWorktree(repo, mergedTree, job.branch as string, job.baseSha as string); }
      catch (e) { close("blocked", "The coordinator worktree could not be created: " + (e instanceof Error ? e.message : String(e))); continue; }
      for (const slice of job.slices) {
        if (slice.status !== "done") continue;
        const merge = gitIn(mergedTree, ["merge", "--no-ff", "--no-edit", "-m", "sam: merge slice " + slice.name + " (" + job.title.slice(0, 60) + ")", slice.branch]);
        if (merge.ok) { job.merges.push({ slice: slice.name, ok: true, conflicts: [] }); continue; }
        const conflictProbe = gitIn(mergedTree, ["diff", "--name-only", "--diff-filter=U"]);
        const conflicts = conflictProbe.ok ? conflictProbe.out.split("\n").map(s => s.trim()).filter(Boolean) : [];
        gitIn(mergedTree, ["merge", "--abort"]);
        slice.status = "conflicted";
        slice.error = "Merge conflict" + (conflicts.length ? " in: " + conflicts.join(", ") : "") + " - the slice's work stays on " + slice.branch + " for the owner to resolve.";
        job.merges.push({ slice: slice.name, ok: false, conflicts });
        recordActivity(root, job.actor, "parallel-merge", "Slice " + slice.name + " conflicted merging into " + job.branch + (conflicts.length ? " (" + conflicts.join(", ") + ")" : ""));
      }
      saveParallelJob(root, job);
      const conflictedSlices = job.slices.filter(s => s.status === "conflicted");
      // THE BINDING BATTERY on the merged tree, with bounded fix
      // iterations when every slice landed - a red battery with
      // slices already missing is recorded, not iterated on.
      const verifyRunner = deps.codeRunner ?? defaultCodeRunner;
      let battery = await runVerify(mergedTree, verifyRunner);
      job.verification = battery.buildOk === null && battery.testOk === null
        ? "unavailable: the repo defines no build/test scripts, so the merged result cannot be verified"
        : "build: " + (battery.buildOk === null ? "n/a" : battery.buildOk ? "pass" : "FAIL") + ", test: " + (battery.testOk === null ? "n/a" : battery.testOk ? "pass" : "FAIL");
      const batteryRed = battery.buildOk === false || battery.testOk === false;
      const batteryMissing = battery.buildOk === null && battery.testOk === null;
      if (batteryRed && !failedSlices.length && !conflictedSlices.length) {
        const runner = deps.runEngine ?? defaultEngineRunner;
        for (let n = 1; n <= job.maxVerifyIterations; n++) {
          const fixPrompt = "Parallel coding job: " + job.spec + "\n\nYou are fixing the MERGED result of a parallel job (fix iteration " + n + " of " + job.maxVerifyIterations + "). The slices have all landed and merged on this branch; the project's build/test now fails:\n" + battery.output.slice(-1500) + "\n\nFix the cause in this tree - integration mismatches between slices (names, signatures, imports) are the usual cause. Change only what the failure names.";
          const fakeTask = { spec: fixPrompt, provider } as unknown as EngineTask;
          let outcome: { exitCode: number | null; output: string; timedOut?: boolean };
          try { outcome = await runner(depsBinary(deps, provider), engineArgv(fakeTask, provider), mergedTree, job.sliceTimeoutMs); }
          catch (e) { outcome = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
          let fixChanges: string[] = [];
          if (!outcome.timedOut && outcome.exitCode === 0) {
            try {
              const changes = changesIn(mergedTree);
              fixChanges = changes.filter(c => !c.deleted).map(c => c.path);
              if (fixChanges.length) commitPathsIn(mergedTree, fixChanges, "sam: " + job.title.slice(0, 60) + " (parallel fix " + n + ")");
            } catch { /* the battery re-run below is the verdict either way */ }
          }
          battery = await runVerify(mergedTree, verifyRunner);
          job.verifyIterations.push({ n, buildOk: battery.buildOk, testOk: battery.testOk, output: battery.output.slice(-500) });
          recordActivity(root, job.actor, "parallel-verify", "Coordinator fix iteration " + n + " for parallel job: " + job.title + " - build " + (battery.buildOk === null ? "n/a" : battery.buildOk ? "pass" : "FAIL") + ", test " + (battery.testOk === null ? "n/a" : battery.testOk ? "pass" : "FAIL"));
          if (battery.buildOk !== false && battery.testOk !== false) break;
        }
        job.verification = "build: " + (battery.buildOk === null ? "n/a" : battery.buildOk ? "pass" : "FAIL") + ", test: " + (battery.testOk === null ? "n/a" : battery.testOk ? "pass" : "FAIL") + " (after " + job.verifyIterations.length + " fix iteration(s))";
      }
      saveParallelJob(root, job);
      const batteryGreen = !batteryMissing && battery.buildOk !== false && battery.testOk !== false;
      if (failedSlices.length) {
        close("blocked", "Slice(s) failed and are reported by name: " + failedSlices.map(s => s.name + " (" + (s.error ?? "failed").slice(0, 160) + ")").join("; ") + ". The finished slices were merged onto " + job.branch + " and the battery there reads: " + job.verification + ". A job with missing slices is not done; re-queue the failed slices as a new job against the job branch or fix them on their slice branches.");
        continue;
      }
      if (conflictedSlices.length) {
        close("blocked", "Slice(s) conflicted at merge and are reported by name: " + conflictedSlices.map(s => s.name + " (" + (s.error ?? "conflict").slice(0, 160) + ")").join("; ") + ". The clean slices were merged onto " + job.branch + "; the conflicted work stays on its slice branch for resolution.");
        continue;
      }
      if (batteryMissing) {
        close("blocked", "The merged result cannot be verified - the repo defines no build/test scripts, so there is no battery to pass. Unverified work is not done; the merged work stays on " + job.branch + ".");
        continue;
      }
      if (!batteryGreen) {
        close("blocked", "The merged battery is still red after " + job.verifyIterations.length + " fix iteration(s): " + battery.output.slice(-400) + " The merged work stays on " + job.branch + " for inspection.");
        continue;
      }
      // REVIEW: fresh-context goldfish over the merged diff, when
      // a reviewer is wired. The diff is computed against the job
      // base, per file, from git itself.
      if (deps.reviewDiff) {
        try {
          const diffProbe = gitIn(repo, ["diff", "--name-only", (job.baseSha as string) + ".." + (job.branch as string)]);
          const paths = diffProbe.ok ? diffProbe.out.split("\n").map(s => s.trim()).filter(Boolean) : [];
          const inputs: GoldfishChangeInput[] = [];
          for (const path of paths) {
            const diff = gitIn(repo, ["diff", (job.baseSha as string) + ".." + (job.branch as string), "--", path]);
            const afterFile = join(mergedTree, path);
            const after = existsSync(afterFile) ? readFileSync(afterFile, "utf8") : "";
            inputs.push({ path, replacementHash: sha256(after), diff: diff.ok ? diff.out : "" });
          }
          if (!inputs.length) throw new Error("No merged changes to review");
          const record = await deps.reviewDiff(job.spec, inputs);
          job.review = record.verdict + ": " + record.summary;
          const blockers = record.findings.filter(f => f.severity === "BLOCKER").map(f => (f.patternId ? "[" + f.patternId + "] " : "") + f.detail).join("; ");
          recordActivity(root, job.actor, "parallel-review", "Self-review " + record.verdict + " for parallel job: " + job.title + (blockers ? " - " + blockers.slice(0, 160) : ""));
          if (record.verdict !== "PASS") {
            close("blocked", "The fresh-context reviewer BLOCKED the merged diff: " + record.summary + (blockers ? " Blockers: " + blockers : "") + " The merged work stays on " + job.branch + "; a new job can take the findings as its spec.");
            continue;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : "Self-review failed";
          job.review = "unavailable: " + message.slice(0, 240);
          close("blocked", "The merged work verified, but the fresh-context self-review could not run (" + message.slice(0, 200) + ") - unreviewed work is not done. The merged work stays on " + job.branch + ".");
          continue;
        }
      }
      close("done", "All " + job.slices.length + " slices landed and merged onto " + job.branch + "; the merged battery is green" + (job.verifyIterations.length ? " after " + job.verifyIterations.length + " fix iteration(s)" : "") + (deps.reviewDiff ? " and the fresh-context review passed" : "") + ". The file count is on the record (filesTouched, read from the job branch diff at close).");
    }
    return { ran, blocked, failed, recovered };
  } finally { draining.delete(key); }
}

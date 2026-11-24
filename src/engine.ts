import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { commandCandidates, namedExecutable, probeDelimiter, probePlatform, type BinaryProbe } from "./bin-path.js";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { codeRoot, recordExternalChange, runCodeCommand, type CodeRunner } from "./code.js";
import { codeRootGitBlocker, commitTaskPaths, gitRepoRoot, headFileContent, prepareTaskBranch, worktreeChanges, type CodingGitState } from "./git-work.js";
import { verificationStatus } from "./verification.js";
import { isEngineConnectionStoreLedgered, recordEngineConnectionStoreFailure } from "./engine-connection-failure.js";
import type { GoldfishRecord } from "./goldfish.js";
import { errorReason } from "./error-reason.js";

/**
 * The managed coding-engine runtime (Phase D item 6, Dip's coder
 * program C6 - the end state of the coder program, ordered last,
 * after the approvals engine, the C1/C2 hands, the C3 loop, the C5
 * goldfish, and C4 git discipline it rides on).
 *
 * SAM is the orchestrator and the verifier, not the typist: it
 * hands a coding task to a real coding engine - the provider the
 * owner selected in config (Claude Code or Codex; the run layer
 * landed 2026-11-12 on top of the 16:04 config choice) - running
 * as a managed subprocess, then does every closing act itself.
 * The shape, seam by seam:
 *
 * - PROPOSE: an engine run is a kind "engine" proposal on the ONE
 *   gate (actions.ts), consequential in the approvals engine, so
 *   smart mode can never auto-approve it and off mode is the only
 *   loosening - the owner's ruling, as with every consequential
 *   kind. Proposal-time validation (validateEngineDetail) refuses
 *   a card that cannot execute: no task text, no designated code
 *   root, a code root that is not a git repository rooted at
 *   itself (the branch sandbox is the containment story), or no
 *   engine binary installed - each refusal names the fix.
 * - QUEUE: approval (or the operator's CLI) queues an EngineTask
 *   in .sam/engine.db (UNIFICATION item 4, seventh store).
 * - RUN: the heartbeat tick (or `engine drain`) runs ONE queued
 *   task per drain, single-shot - iteration across failures is
 *   the C3 loop's shape; the engine is one heavy pass. The task's
 *   sam/<task> branch is prepared first (C4: a dirty tree or a
 *   non-git root closes the task blocked; the engine never runs
 *   in an unbranched tree). The engine is the SELECTED provider's
 *   FIXED binary, snapshotted onto the task at queue time (the
 *   provider the owner approved is the provider that runs):
 *   Claude Code resolves SAM_ENGINE_BIN, else "claude" on PATH,
 *   and runs -p <task> --output-format text --permission-mode
 *   acceptEdits; Codex resolves SAM_CODEX_BIN, else "codex" on
 *   PATH, and runs exec --skip-git-repo-check --sandbox
 *   workspace-write -- <task> (the coding-operatives adapter
 *   shape). Cwd is pinned to the code root either way. The model
 *   supplies only the task text; there is no way to name a
 *   command, a flag, or a shell. A 10-minute timeout caps the
 *   run; its output is captured, capped, and carried on the task
 *   record.
 * - RECORD: the engine writes files directly, so afterwards SAM
 *   enumerates its changes from git porcelain against the task
 *   branch's base and records each one through the C1 ledger
 *   shape (code.ts recordExternalChange: writes ledger, goldfish
 *   artifact, verify-on-stop change). A changed path the C1
 *   fences would refuse - protected, secret-named, binary,
 *   oversize, or a deletion - is UNREVIEWABLE: the task closes
 *   blocked naming it. The engine's wider hands never widen the
 *   shape SAM can verify and review.
 * - VERIFY + REVIEW: SAM runs the code root's build and test
 *   through the C2 allowlist; the verify-on-stop ledger must read
 *   verified. Then the C5 goldfish reviews the recorded diff in
 *   fresh context (the production drains wire the real reviewer;
 *   a review that cannot run closes blocked, never done).
 * - COMMIT: exactly the recorded change paths are committed
 *   locally on the task branch (C4). Done requires verified +
 *   reviewed + committed, all three. The push stays the separate
 *   owner-approved git-push proposal; this module never pushes
 *   and never opens a PR.
 *
 * A non-zero engine exit closes the task FAILED with the output
 * tail on the record; its partial changes stay uncommitted on the
 * task branch for the owner to inspect. The close posts one
 * summary into the originating chat: outcome, branch, commits,
 * verification, review, changes, and the engine's output tail.
 */

export type EngineStatus = "queued" | "running" | "done" | "blocked" | "failed";
/** The providers a managed run can ride - the same two the
 *  engine config choice names (engine-connect.ts ENGINE_PROVIDERS).
 *  Kept as a local union so this module never imports
 *  engine-connect (which imports engineBinary from here). */
export type EngineRunProvider = "claude-code" | "codex";
export interface EngineTask {
  id: string; actor: string; chatId: string; spec: string; title: string;
  /** The provider selected when the run was queued - the provider
   *  the owner approved is the provider that runs. Absent/null on
   *  tasks queued before provider-selectable runs existed; those
   *  resolve the install's current selection at drain time. */
  provider?: EngineRunProvider | null;
  status: EngineStatus;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  result: string | null; output: string | null; exitCode: number | null;
  changes: string[]; unreviewable: string[];
  verification: string | null; review: string | null;
  git: CodingGitState | null;
}

const MAX_OPEN = 5;
const STALE_RUNNING_MS = 60 * 60000;
const ENGINE_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 4_000;
const ENGINE_FOOTER = "\n\nManaged-run rules from SAM (the orchestrator): work only inside the current directory, which is a git branch made for this task alone. Make the change with your file tools. Do not run git commands, do not commit, do not push, and do not install or remove packages. SAM will record your changes, run the project's build and test, review the diff, and commit it - your job is only the code change itself. When you are finished, end with a short summary of what you changed.";

function engineFile(root: string): string { return join(resolve(root), ".sam", "engine.json"); }
function engineDbFile(root: string): string { return join(resolve(root), ".sam", "engine.db"); }
// State convergence (UNIFICATION item 4, seventh store): the
// managed engine queue is SQLite (.sam/engine.db, the
// actions/jobs/background/coding pattern), one row per task
// holding the task's full JSON, rowid order = the old file
// order. The old engine.json was rewritten whole on every queue
// and on every drain transition (the stale-recovery pass, the
// running mark, the git-state save, a save per accumulated
// field, and the close - roughly ten whole-file rewrites for
// one run), and three processes write this store (the
// dashboard/chat process queues through the ONE gate's engine
// executor, the heartbeat tick drains, the CLI queues and
// drains on demand), so two writers holding the same snapshot
// silently lost the second one's record: a queued run could
// vanish under a tick's transition save, and a finished run's
// done mark could revert to queued and run the engine twice -
// with real code writes and git commits the second time. Here
// each mutation is a single-row INSERT or UPDATE, and
// connections carry a busy_timeout (the F1 cross-process lock
// seam) so a writer waits out a peer's transaction instead of
// dying on "database is locked". First open imports a legacy
// engine.json in file order and renames it
// engine.json.migrated - imported, never deleted; a malformed
// file imports nothing and is left in place. A pure read on an
// install with neither file creates nothing, so read-only
// audits stay read-only. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with
// no backup change.
// Failure visibility (gap found 2026-11-15, hourly run
// 19:04 EST): the engine store holds the managed
// coding-engine queue - each run's actor, chat, spec,
// status, engine output, recorded changes, verification,
// review, and C4 git state - and every touch opened it
// raw. listEngineTasks rides engineStatus (the dashboard
// status payload, the morning brief, the CLI overview,
// self-audit, and the eval battery); getEngineTask and
// the row writes ride the heartbeat drain's transitions,
// updateEngineTask, the ONE gate's engine executor, and
// the CLI engine verbs. A dead engine.db threw into
// whichever catch wrapped the call with the seam unnamed,
// and no engine-store-failed kind existed (engine-failed
// is the drain's run-outcome class, a different seam;
// engine-connection-store-failed is the separate
// route-marker store, already guarded), so the class was
// uncountable, and any reader folding a dead store as
// "no tasks" would silently empty the managed-run queue
// dressed as an idle engine - a queued run's record gone
// while its branch sandbox and the owner's approval
// assume it still waits. Now the store's touches own
// their failure (the coding precedent): a failed touch
// ledgers ONE engine-store-failed line (phase read for
// listEngineTasks / getEngineTask, write for
// insertEngineTask / updateEngineTaskRow and every
// mutation door riding them; actor sam; the verbatim
// reason collapsed and capped; never any task record -
// specs, outputs, and results are the owner's words, not
// failure data), tags the error, and rethrows exactly, so
// every caller's handling is unchanged and reads still
// fail closed. A touch already ledgered by an inner door
// keeps its one line and gains no second. Validation
// errors (actor / spec / chat / queue-full refusals) are
// not store failures and ledger nothing. An absent store
// still reads empty with no line and creates nothing, and
// torn row payloads still parse forgiving - only the
// store touch is guarded.
export type EngineStorePhase = "read" | "write";

export function engineStoreFailureSummary(phase: EngineStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Engine store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a engine-store-failed line carries (census sprint
 * 2026-11-17): recordEngineStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function engineStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordEngineStoreFailure(root: string, phase: EngineStorePhase, error: unknown): void {
  const reason = engineStoreFailureReason(error);
  recordActivity(root, "sam", "engine-store-failed", engineStoreFailureSummary(phase, reason));
}

function tagEngineStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { engineStoreLedgered?: boolean }).engineStoreLedgered = true;
  }
}

export function isEngineStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { engineStoreLedgered?: boolean }).engineStoreLedgered === true;
}

const ENGINE_STORE_VALIDATION = [/^Invalid actor$/, /^Invalid engine task spec$/, /^A chat is required$/, /^Engine queue is full$/];

function isEngineStoreValidation(error: unknown): boolean {
  return error instanceof Error && ENGINE_STORE_VALIDATION.some(re => re.test(error.message));
}

function failEngineStore(root: string, phase: EngineStorePhase, error: unknown): never {
  if (!isEngineStoreLedgered(error) && !isEngineStoreValidation(error)) recordEngineStoreFailure(root, phase, error);
  if (!isEngineStoreValidation(error)) tagEngineStoreLedgered(error);
  throw error;
}

function openEngineGuarded(root: string, phase: EngineStorePhase): Database.Database {
  try { return openEngineStore(root); }
  catch (error) { failEngineStore(root, phase, error); }
}
function openEngineStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(engineDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS engine_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyEngine(db, root);
  return db;
}
function migrateLegacyEngine(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM engine_tasks").get() as { n: number };
  if (n > 0) return;
  const file = engineFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO engine_tasks (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const task = raw as Partial<EngineTask>;
      if (typeof task.id !== "string" || !task.id) continue;
      insert.run(task.id, JSON.stringify(task));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToTask(data: string): EngineTask | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as EngineTask : null; }
  catch { return null; }
}
export function listEngineTasks(root: string): EngineTask[] {
  if (!existsSync(engineDbFile(root)) && !existsSync(engineFile(root))) return [];
  const db = openEngineGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM engine_tasks ORDER BY rowid").all() as Array<{ data: string }>;
    const items: EngineTask[] = [];
    for (const row of rows) { const task = rowToTask(row.data); if (task) items.push(task); }
    return items;
  } catch (error) { failEngineStore(root, "read", error); }
  finally { db.close(); }
}
export function getEngineTask(root: string, id: string): EngineTask | null {
  if (!existsSync(engineDbFile(root)) && !existsSync(engineFile(root))) return null;
  const db = openEngineGuarded(root, "read");
  try {
    const row = db.prepare("SELECT data FROM engine_tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToTask(row.data) : null;
  } catch (error) { failEngineStore(root, "read", error); }
  finally { db.close(); }
}
function insertEngineTask(root: string, item: EngineTask): void {
  const db = openEngineGuarded(root, "write");
  try { db.prepare("INSERT INTO engine_tasks (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  catch (error) { failEngineStore(root, "write", error); }
  finally { db.close(); }
}
function updateEngineTaskRow(root: string, item: EngineTask): void {
  const db = openEngineGuarded(root, "write");
  try { db.prepare("UPDATE engine_tasks SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  catch (error) { failEngineStore(root, "write", error); }
  finally { db.close(); }
}
// The store's update door (the updateBackgroundTask /
// updateCodingTask precedent): patch one task by id through the
// store's own shape. Returns the updated task, or null when no
// such task exists - and a miss on an install with no store at
// all creates nothing.
export function updateEngineTask(root: string, id: string, patch: Partial<EngineTask>): EngineTask | null {
  if (!existsSync(engineDbFile(root)) && !existsSync(engineFile(root))) return null;
  const current = getEngineTask(root, id);
  if (!current) return null;
  const next: EngineTask = { ...current, ...patch, id: current.id };
  updateEngineTaskRow(root, next);
  return next;
}

/** The engine binary this install would run: the operator's
 *  SAM_ENGINE_BIN when it names an executable file, else "claude"
 *  found on PATH. Null means not installed - the state the box is
 *  in today - and every surface names it cleanly instead of
 *  failing obscurely (the agent-reach C2 pattern).
 *
 *  PATH is split on path.delimiter (";" on win32). On win32 the
 *  names tried are claude.exe, claude.cmd, then claude, and a
 *  SAM_ENGINE_BIN without an extension may name the .exe or .cmd
 *  beside it. The two lstatSync lines are the reserved probe:
 *  they stay byte-identical, and a symlink is still not a file. */
export function engineBinary(env: NodeJS.ProcessEnv = process.env, probe?: BinaryProbe): string | null {
  return resolveCommandBinary("claude", env.SAM_ENGINE_BIN, env, probe);
}

/** The one binary resolver both engine providers ride: a named
 *  executable (the provider's env var) when it names a real file,
 *  else the command found on PATH. The two lstatSync lines below
 *  are the reserved probe (the win-path guard pins them
 *  byte-identical in this file): a symlink is still not a file. */
function resolveCommandBinary(command: string, rawNamed: string | undefined, env: NodeJS.ProcessEnv, probe?: BinaryProbe): string | null {
  const platform = probePlatform(probe);
  const delimiter = probeDelimiter(probe);
  const named = rawNamed ? namedExecutable(rawNamed, platform) : rawNamed;
  if (named) {
    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }
  }
  for (const candidate of commandCandidates(env.PATH, delimiter, command, platform)) {
    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export function engineRunProviderLabel(provider: EngineRunProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/** The provider this install's engine route is set to, read from
 *  the engine-connection store. engine-connect.ts is that store's
 *  only writer (setEngineProvider); this is its read-only mirror
 *  for the run layer, kept here so engine-connect's import of
 *  engineBinary stays cycle-free. A pure read: no store, no
 *  provider table, or an unreadable row all read as the default
 *  (claude-code), and nothing is ever created here. */
export function selectedEngineProvider(root: string): EngineRunProvider {
  const dbFile = join(resolve(root), ".sam", "engine-connection.db");
  if (!existsSync(dbFile)) return "claude-code";
  let db: Database.Database | null = null;
  try {
    db = openDatabase(dbFile, { readonly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_provider'").get();
    if (!table) return "claude-code";
    const row = db.prepare("SELECT data FROM engine_provider WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return "claude-code";
    // A torn row payload is data, not a store failure: it
    // parses forgiving to the default with no ledger line,
    // exactly as the store's own reader treats it.
    let value: { provider?: unknown };
    try { value = JSON.parse(row.data) as { provider?: unknown }; } catch { return "claude-code"; }
    return value?.provider === "codex" ? "codex" : "claude-code";
  } catch (error) {
    // The mirror still folds to the default exactly as before
    // (a run must never die on a provider read), but the fold
    // is now countable: one engine-connection-store-failed
    // line at phase resolve per failed touch (the
    // dashboard-config coreActor precedent), never a second
    // line for a touch the store already ledgered.
    if (!isEngineConnectionStoreLedgered(error)) {
      try { recordEngineConnectionStoreFailure(root, "resolve", error); } catch { /* the ledger never breaks the fold */ }
    }
    return "claude-code";
  }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

/** The binary ONE provider's run would spawn: Claude Code rides
 *  engineBinary (SAM_ENGINE_BIN, else claude on PATH); Codex
 *  resolves SAM_CODEX_BIN, else "codex" on PATH through the same
 *  bin-path helpers engine-connect's providerBinary uses. Null
 *  means that provider is not installed. */
export function engineRunBinary(provider: EngineRunProvider, env: NodeJS.ProcessEnv = process.env, probe?: BinaryProbe): string | null {
  if (provider === "claude-code") return engineBinary(env, probe);
  return resolveCommandBinary("codex", env.SAM_CODEX_BIN, env, probe);
}

/** The provider a task runs under: its queue-time snapshot when it
 *  carries one, else the install's current selection. */
export function engineTaskProvider(root: string, task: EngineTask): EngineRunProvider {
  return task.provider === "codex" || task.provider === "claude-code" ? task.provider : selectedEngineProvider(root);
}

function notInstalledMessage(provider: EngineRunProvider): string {
  return provider === "codex"
    ? "The managed coding engine (Codex, the selected provider) is not installed on this machine - no SAM_CODEX_BIN is set and no \"codex\" binary is on PATH. Installing it is the operator's act; until then an engine run cannot execute."
    : "The managed coding engine (Claude Code) is not installed on this machine - no SAM_ENGINE_BIN is set and no \"claude\" binary is on PATH. Installing it is the operator's act; until then an engine run cannot execute.";
}

export function engineStatus(root: string, env: NodeJS.ProcessEnv = process.env): { installed: boolean; binary: string | null; provider: EngineRunProvider; queued: number; running: number; done: number; blocked: number; failed: number; recent: EngineTask[] } {
  const items = listEngineTasks(root);
  const count = (s: EngineStatus) => items.filter(t => t.status === s).length;
  const provider = selectedEngineProvider(root);
  const binary = engineRunBinary(provider, env);
  return { installed: binary !== null, binary, provider, queued: count("queued"), running: count("running"), done: count("done"), blocked: count("blocked"), failed: count("failed"), recent: items.slice(-10) };
}

/** Proposal-time validation for the ONE gate's engine kind: the
 *  detail is JSON {task, chatId?}; the task must be runnable the
 *  moment the owner approves, so everything execution needs is
 *  checked NOW - a card that cannot execute is never shown. */
export function validateEngineDetail(root: string, detail: string, env: NodeJS.ProcessEnv = process.env): { task: string; chatId: string | null; provider: EngineRunProvider } {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid engine detail: expected JSON {task}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid engine detail: expected JSON {task}");
  const s = spec as { task?: unknown; chatId?: unknown };
  const task = typeof s.task === "string" ? s.task.trim() : "";
  if (!task || task.length > 4000) throw new Error("Invalid engine task in detail (1 to 4000 characters)");
  const chatId = typeof s.chatId === "string" && s.chatId ? s.chatId : null;
  if (!codeRoot(root)) throw new Error("No code root is designated on this install, so an engine run has nowhere to work. The operator designates one with: sam code set-root <path>.");
  if (!gitRepoRoot(root)) throw new Error("The designated code root is not a git repository rooted at itself - engine runs work inside the C4 branch sandbox (a sam/<task> branch in that repo), never in an unbranched tree. Initialize or designate a git tree first.");
  // The branch sandbox refuses a dirty tree (or an unborn HEAD)
  // before the engine ever runs, deterministically - so a card
  // shown for that tree can only queue a run whose only outcome
  // is blocked. This validation is the proposal-time bar ("a
  // card that cannot execute is never shown"), so the refusal
  // belongs here too, in the probe's own words (the ONE source
  // the drain's block reason also rides).
  const gitBlocker = codeRootGitBlocker(root);
  if (gitBlocker) throw new Error(gitBlocker);
  const provider = selectedEngineProvider(root);
  if (!engineRunBinary(provider, env)) throw new Error(notInstalledMessage(provider));
  return { task, chatId, provider };
}

export function queueEngineTask(root: string, input: { actor: string; chatId: string; spec: string }): EngineTask {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const spec = (input.spec ?? "").trim();
  if (!spec || spec.length > 4000) throw new Error("Invalid engine task spec");
  if (!input.chatId) throw new Error("A chat is required");
  // Same executability bar as the proposal gate, so a direct queue
  // can never create a run that can only fail. The validation also
  // resolves the selected provider, snapshotted onto the task:
  // the provider the owner approved is the provider that runs.
  const { provider } = validateEngineDetail(root, JSON.stringify({ task: spec }));
  const db = new ChatStore(root);
  try { db.messages(input.chatId); } finally { db.close(); }
  const items = listEngineTasks(root);
  if (items.filter(t => t.status === "queued" || t.status === "running").length >= MAX_OPEN) throw new Error("Engine queue is full");
  const item: EngineTask = {
    id: randomUUID(), actor: input.actor, chatId: input.chatId, spec,
    title: spec.slice(0, 120), provider, status: "queued",
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    result: null, output: null, exitCode: null,
    changes: [], unreviewable: [], verification: null, review: null, git: null,
  };
  insertEngineTask(root, item);
  recordActivity(root, input.actor, "engine-queued", engineQueuedLedgerSummary(engineRunProviderLabel(provider), item.title));
  return item;
}

// The ONE writers for the engine run lifecycle's activity
// lines, so the history scorecard's parsers below can never
// drift from the seams they count. The shapes are
// byte-identical to what queueEngineTask and
// drainEngineTasks wrote inline before these writers
// existed; the blocked and failed writers own the 120-char
// reason cap the close seam applied inline.
export function engineQueuedLedgerSummary(providerLabel: string, title: string): string {
  return "Queued engine run (" + providerLabel + "): " + title;
}
export function engineStartedLedgerSummary(title: string): string {
  return "Engine run started: " + title;
}
export function engineDoneLedgerSummary(title: string, files: number): string {
  return "Engine run done and verified: " + title + " (" + files + " file(s))";
}
export function engineBlockedLedgerSummary(title: string, reason: string): string {
  return "Engine run blocked: " + title + " - " + reason.slice(0, 120);
}
export function engineFailedLedgerSummary(title: string, reason: string): string {
  return "Engine run failed: " + title + " - " + reason.slice(0, 120);
}
export function engineDiedLedgerSummary(title: string): string {
  return "Engine run died mid-run: " + title;
}
export function engineReviewLedgerSummary(verdict: string, title: string): string {
  return "Self-review " + verdict + " for engine run: " + title;
}

// The engine history scorecard (2026-11-21, the
// measured-proof series): every managed engine run has
// ledgered as an engine-queued / engine-started /
// engine-done / engine-blocked / engine-failed /
// engine-review line since the C6 runtime landed - until
// now as inline concatenation at the seams, with no ONE
// writer and no fold, so how many runs were ever queued,
// started, verified done, blocked, failed, or reviewed was
// invisible in aggregate (engineStatus reads only the
// current store - a done, blocked, or failed row is
// overwritten in place as the next run closes, and a
// recovered stale task's died-mid-run failure leaves no
// current-state trace). A blocked or failed run is the
// signal of the six - a run that did not land verified,
// reviewed, and committed - so the verdict is attention
// only when any blocked or failed was ever recorded or a
// line is unparseable, else clear. This text folds the six
// classes to counts only, on ONE line: queued, started,
// done, blocked, failed, and review counts, the
// distinct-title count as a number only, and the total. No
// stamp, no actor, no title, no provider label, no reason,
// no review verdict, and no verbatim summary enters the
// text - the summaries carry task titles, provider labels,
// and closing reasons, which are the owner's words, and
// the fold consumes and never prints them. A pure read: it
// creates nothing, queues nothing, and drains nothing -
// the engine seams themselves are untouched beyond riding
// their ONE writers.
export function parseEngineQueuedSummary(summary: string): { provider: string; title: string } | null {
  const m = /^Queued engine run \((.+)\): (.+)$/.exec(summary);
  if (!m || !m[1].trim() || !m[2].trim()) return null;
  return { provider: m[1], title: m[2] };
}
export function parseEngineStartedSummary(summary: string): { title: string } | null {
  const m = /^Engine run started: (.+)$/.exec(summary);
  if (!m || !m[1].trim()) return null;
  return { title: m[1] };
}
export function parseEngineDoneSummary(summary: string): { title: string; files: number } | null {
  const m = /^Engine run done and verified: (.+) \((\d+) file\(s\)\)$/.exec(summary);
  if (!m || !m[1].trim()) return null;
  return { title: m[1], files: Number(m[2]) };
}
export function parseEngineBlockedSummary(summary: string): { title: string } | null {
  const m = /^Engine run blocked: (.+) - (.+)$/.exec(summary);
  if (!m || !m[1].trim() || !m[2].trim()) return null;
  return { title: m[1] };
}
export function parseEngineFailedSummary(summary: string): { title: string } | null {
  const died = /^Engine run died mid-run: (.+)$/.exec(summary);
  if (died) {
    if (!died[1].trim()) return null;
    return { title: died[1] };
  }
  const m = /^Engine run failed: (.+) - (.+)$/.exec(summary);
  if (!m || !m[1].trim() || !m[2].trim()) return null;
  return { title: m[1] };
}
export function parseEngineReviewSummary(summary: string): { verdict: string; title: string } | null {
  const m = /^Self-review (.+) for engine run: (.+)$/.exec(summary);
  if (!m || !m[1].trim() || !m[2].trim()) return null;
  return { verdict: m[1], title: m[2] };
}

export function engineHistoryScorecardText(root: string): string {
  const queuedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-queued" });
  const startedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-started" });
  const doneLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-done" });
  const blockedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-blocked" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-failed" });
  const reviewLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "engine-review" });
  let queued = 0;
  let started = 0;
  let done = 0;
  let blocked = 0;
  let failed = 0;
  let reviews = 0;
  let unparseable = 0;
  const titles = new Set<string>();
  for (const line of queuedLines) {
    const parsed = parseEngineQueuedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    queued += 1;
    titles.add(parsed.title);
  }
  for (const line of startedLines) {
    const parsed = parseEngineStartedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    started += 1;
    titles.add(parsed.title);
  }
  for (const line of doneLines) {
    const parsed = parseEngineDoneSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    done += 1;
    titles.add(parsed.title);
  }
  for (const line of blockedLines) {
    const parsed = parseEngineBlockedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    blocked += 1;
    titles.add(parsed.title);
  }
  for (const line of failedLines) {
    const parsed = parseEngineFailedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    failed += 1;
    titles.add(parsed.title);
  }
  for (const line of reviewLines) {
    const parsed = parseEngineReviewSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    reviews += 1;
    titles.add(parsed.title);
  }
  const total = queuedLines.length + startedLines.length + doneLines.length + blockedLines.length + failedLines.length + reviewLines.length;
  const parts: string[] = [];
  parts.push("Engine history: " + (blocked > 0 || failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(queued) + " queued");
  parts.push(String(started) + " started");
  parts.push(String(done) + " done");
  parts.push(String(blocked) + " blocked");
  parts.push(String(failed) + " failed");
  parts.push(String(reviews) + " reviews");
  parts.push(String(titles.size) + " distinct titles");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function postToChat(root: string, chatId: string, text: string): void {
  try { const db = new ChatStore(root); try { db.add(chatId, "assistant", text); } finally { db.close(); } } catch { /* chat gone; the task record and ledger stand */ }
}

/** The closing summary: outcome first, then the evidence - branch,
 *  commits, verification, review, the recorded changes, and the
 *  engine's own output tail. */
export function engineSummaryText(task: EngineTask): string {
  const outcome = task.status === "done"
    ? (task.changes.length ? "Engine run done: " + task.title : "Engine run closed with no changes: " + task.title)
    : task.status === "blocked"
      ? "Engine run blocked (not done): " + task.title
      : "Engine run failed: " + task.title;
  const lines = [outcome, "Verification: " + (task.verification ?? "unknown") + "."];
  if (task.provider === "codex" || task.provider === "claude-code") lines.splice(1, 0, "Engine: " + engineRunProviderLabel(task.provider) + " (the provider selected when this run was queued).");
  if (task.git?.mode === "branch") {
    lines.push("Git: branch " + task.git.branch + ", " + task.git.commits.length + " local commit(s)" + (task.git.commits.length ? " (" + task.git.commits.map(c => c.sha.slice(0, 8)).join(", ") + ")" : "") + " - not pushed; pushing the branch is an owner-approved git-push proposal." + (task.git.pending.length ? " Not committed: " + task.git.pending.join(", ") + "." : ""));
  }
  if (task.review) lines.push("Self-review: " + task.review + ".");
  if (task.result) lines.push(task.result);
  if (task.changes.length) lines.push("Changes (" + task.changes.length + "): " + task.changes.join(", "));
  if (task.unreviewable.length) lines.push("Unreviewable changes (outside the recorded shape): " + task.unreviewable.join(", "));
  if (task.output) lines.push("Engine output (tail):\n" + task.output.slice(-1_500));
  return lines.join("\n").slice(0, 12_000);
}

export type EngineRunner = (binary: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

export const defaultEngineRunner: EngineRunner = (binary, args, cwd, timeoutMs) => new Promise(done => {
  let settled = false;
  const child = execFile(binary, args, { cwd, timeout: timeoutMs, maxBuffer: 1_000_000, windowsHide: true }, (error, stdout, stderr) => {
    if (settled) return; settled = true;
    const timedOut = !!error && (error as unknown as { killed?: boolean }).killed === true;
    done({ exitCode: error ? (typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0, output: (stdout ?? "") + (stderr ?? ""), timedOut });
  });
  // Close the child's stdin immediately: execFile leaves the pipe
  // open, and `codex exec` (prompt passed as an argv item) ALSO
  // reads stdin to EOF before starting - with the pipe held open
  // the run hangs until the timeout kills it ("Reading additional
  // input from stdin..." was the only output). Caught live in the
  // 2026-11-14 Program E proof: every Codex slice timed out at
  // 600s while the same command with stdin at EOF finished in 13s.
  // No engine run ever receives stdin input by design (the prompt
  // is an argv item), so EOF at spawn is the correct contract.
  child.stdin?.end();
  child.on("error", err => {
    if (settled) return; settled = true;
    done({ exitCode: null, output: String(err) });
  });
});

/** The fixed argv an engine run is spawned with, per provider.
 *  The task text is the ONLY caller-supplied element, passed as
 *  one argv item - never a shell string, never a flag. Claude
 *  Code keeps its original argv exactly; Codex rides the
 *  coding-operatives adapter shape (exec in a workspace-write
 *  sandbox; --skip-git-repo-check is belt-and-braces - the drain
 *  has already proven the code root is a git repo rooted at
 *  itself). The provider defaults to the task's queue-time
 *  snapshot, then claude-code for a bare legacy task. Exported
 *  for tests. */
export function engineArgv(task: EngineTask, provider?: EngineRunProvider): string[] {
  const selected = provider ?? (task.provider === "codex" || task.provider === "claude-code" ? task.provider : "claude-code");
  const prompt = task.spec + ENGINE_FOOTER;
  if (selected === "codex") return ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--", prompt];
  return ["-p", prompt, "--output-format", "text", "--permission-mode", "acceptEdits"];
}

export interface EngineDrainDeps {
  /** The engine process runner (tests inject a fake engine). */
  runEngine?: EngineRunner;
  /** C2 verify runner passthrough (tests use the real one against
   *  a scratch package.json; production leaves the default). */
  codeRunner?: CodeRunner;
  /** C5 self-review: the goldfish pass over the recorded diff. The
   *  production drains always wire it (defaultCodingReviewer, or a
   *  refusing stub when no model is configured); a drain without
   *  it closes on verification alone and the task's review field
   *  stays null saying so - the coding loop's contract. */
  review?: (task: EngineTask) => Promise<GoldfishRecord>;
  env?: NodeJS.ProcessEnv;
}

const draining = new Set<string>();

export async function drainEngineTasks(root: string, deps: EngineDrainDeps = {}): Promise<{ ran: string[]; blocked: string[]; failed: string[]; recovered: string[] }> {
  const key = resolve(root);
  if (draining.has(key)) return { ran: [], blocked: [], failed: [], recovered: [] };
  draining.add(key);
  const ran: string[] = []; const blocked: string[] = []; const failed: string[] = []; const recovered: string[] = [];
  try {
    const items = listEngineTasks(root);
    const now = Date.now();
    for (const t of items) {
      if (t.status === "running" && t.startedAt && now - Date.parse(t.startedAt) > STALE_RUNNING_MS) {
        updateEngineTask(root, t.id, { status: "failed", finishedAt: new Date().toISOString(), result: "Runner stopped mid-run; marked failed by the next drain." });
        recovered.push(t.id);
        recordActivity(root, t.actor, "engine-failed", engineDiedLedgerSummary(t.title));
      }
    }
    // One engine run per drain: an engine pass is the heaviest work
    // SAM supervises, and serializing it keeps the branch sandbox
    // (one checked-out branch per tree) honest by construction.
    const queued = listEngineTasks(root).filter(t => t.status === "queued").slice(0, 1);
    for (const task of queued) {
      const found = getEngineTask(root, task.id);
      if (!found || found.status !== "queued") continue;
      const current = updateEngineTask(root, task.id, { status: "running", startedAt: new Date().toISOString() }) ?? found;
      recordActivity(root, current.actor, "engine-started", engineStartedLedgerSummary(current.title));
      const close = (status: EngineStatus, result: string) => {
        // Carry every field the run accumulated on `current` - the
        // record on disk only holds what the mid-run updates wrote.
        const done = updateEngineTask(root, task.id, {
          exitCode: current.exitCode, output: current.output, provider: current.provider ?? null,
          changes: current.changes, unreviewable: current.unreviewable,
          verification: current.verification, review: current.review, git: current.git,
          status, result: result.slice(0, 600), finishedAt: new Date().toISOString(),
        });
        if (!done) return;
        postToChat(root, current.chatId, engineSummaryText(done));
        if (status === "done") { ran.push(task.id); recordActivity(root, current.actor, "engine-done", engineDoneLedgerSummary(current.title, done.changes.length)); }
        else if (status === "blocked") { blocked.push(task.id); recordActivity(root, current.actor, "engine-blocked", engineBlockedLedgerSummary(current.title, result)); }
        else { failed.push(task.id); recordActivity(root, current.actor, "engine-failed", engineFailedLedgerSummary(current.title, result)); }
      };
      // C4 branch sandbox first: the engine never runs in an
      // unbranched tree or on top of the owner's uncommitted work.
      let gitState: CodingGitState | null = null;
      try { gitState = prepareTaskBranch(root, current); }
      catch (e) { gitState = { mode: "refused", branch: null, baseSha: null, commits: [], pending: [], error: e instanceof Error ? errorReason(e) : "Git preparation failed" }; }
      current.git = gitState;
      updateEngineTask(root, task.id, { git: gitState });
      if (gitState.mode !== "branch") {
        current.verification = verificationStatus(root).state;
        close("blocked", gitState.mode === "none"
          ? "The designated code root is not a git repository, so there is no branch sandbox for the engine to run inside. Engine runs require a git code root; SAM's own coding loop (sam_coding_task) can work in a non-git tree."
          : "Git discipline refused the run: " + (gitState.error ?? "the code root's git state could not be prepared"));
        continue;
      }
      // The run rides the task's queue-time provider snapshot (a
      // legacy task resolves the current selection), and the
      // resolved provider is stamped onto the record so the
      // closing summary names the engine that actually ran.
      const provider = engineTaskProvider(root, current);
      current.provider = provider;
      updateEngineTask(root, task.id, { provider });
      const binary = engineRunBinary(provider, deps.env ?? process.env);
      if (!binary) { close("failed", notInstalledMessage(provider)); continue; }
      const base = codeRoot(root);
      if (!base) { close("blocked", "The designated code root vanished before the run could start."); continue; }
      const runner = deps.runEngine ?? defaultEngineRunner;
      let outcome: { exitCode: number | null; output: string; timedOut?: boolean };
      try { outcome = await runner(binary, engineArgv(current, provider), base, ENGINE_TIMEOUT_MS); }
      catch (e) { outcome = { exitCode: null, output: errorReason(e) }; }
      current.exitCode = outcome.exitCode;
      current.output = (outcome.output ?? "").slice(-OUTPUT_TAIL_CHARS);
      updateEngineTask(root, task.id, { exitCode: current.exitCode, output: current.output });
      if (outcome.timedOut || outcome.exitCode !== 0) {
        // A failed engine pass: whatever it half-wrote stays
        // uncommitted on the task branch, named in the record.
        try { current.changes = worktreeChanges(root).map(c => c.path); } catch { /* tree unreadable; the exit record stands */ }
        updateEngineTask(root, task.id, { changes: current.changes });
        close("failed", outcome.timedOut
          ? "The engine run timed out after " + Math.round(ENGINE_TIMEOUT_MS / 60000) + " minutes and was killed. Its partial changes, if any, stay uncommitted on " + gitState.branch + " for inspection."
          : "The engine exited with code " + String(outcome.exitCode) + ". Its partial changes, if any, stay uncommitted on " + gitState.branch + " for inspection. Output tail is on the task record.");
        continue;
      }
      // RECORD: enumerate the engine's changes against the branch
      // base and ledger each recordable one through the C1 shape.
      let changes: Array<{ path: string; deleted: boolean }> = [];
      try { changes = worktreeChanges(root); }
      catch (e) { close("blocked", "The engine finished, but SAM could not enumerate its changes: " + errorReason(e).slice(0, 200)); continue; }
      const recorded: string[] = []; const unreviewable: string[] = [];
      for (const change of changes) {
        if (change.deleted) { unreviewable.push(change.path + " (deleted)"); continue; }
        try {
          const after = readFileSync(join(base, change.path), "utf8");
          const before = headFileContent(root, change.path);
          recordExternalChange(root, current.actor, change.path, before ?? "", after, before === null);
          recorded.push(change.path);
        } catch { unreviewable.push(change.path); }
      }
      current.changes = recorded; current.unreviewable = unreviewable;
      updateEngineTask(root, task.id, { changes: recorded, unreviewable });
      if (unreviewable.length) {
        close("blocked", "The engine changed " + unreviewable.length + " path(s) outside the shape SAM can record, verify, and review (" + unreviewable.join(", ") + ") - protected, binary, oversize, or deleted files are refused by the same fences that bind SAM's own write hands. The recorded changes stay uncommitted on " + gitState.branch + "; fix the tree outside SAM and re-queue, or narrow the task.");
        continue;
      }
      if (!recorded.length) {
        current.verification = verificationStatus(root).state;
        close("done", "The engine made no changes; there was nothing to verify, review, or commit. " + (current.output ?? "").slice(-240));
        continue;
      }
      // VERIFY: SAM runs build + test itself through the C2
      // allowlist - the engine's own claims about its work are not
      // verification. A root with no build/test scripts cannot be
      // verified, which closes blocked, never done.
      let verifyError: string | null = null;
      try {
        await runCodeCommand(root, current.actor, "build", { runner: deps.codeRunner });
        await runCodeCommand(root, current.actor, "test", { runner: deps.codeRunner });
      } catch (e) { verifyError = errorReason(e); }
      const vstate = verificationStatus(root).state;
      current.verification = verifyError ? "unavailable: " + verifyError.slice(0, 160) : vstate;
      updateEngineTask(root, task.id, { verification: current.verification });
      if (verifyError || vstate !== "verified") {
        close("blocked", verifyError
          ? "SAM could not verify the engine's changes: " + verifyError.slice(0, 240) + " The changes stay uncommitted on " + gitState.branch + "."
          : "The engine's changes did not verify (the verification ledger reads \"" + vstate + "\" after SAM ran build and test through the C2 allowlist). Unverified work is not done; the changes stay uncommitted on " + gitState.branch + ".");
        continue;
      }
      // REVIEW: the C5 goldfish over the recorded diff, fresh
      // context. A block or an unavailable review closes blocked.
      let reviewOutcome: string | null = null; let reviewUnavailable: string | null = null;
      if (deps.review) {
        try {
          const record = await deps.review(current);
          reviewOutcome = record.verdict + ": " + record.summary;
          recordActivity(root, current.actor, "engine-review", engineReviewLedgerSummary(record.verdict, current.title));
        } catch (e) { reviewUnavailable = e instanceof Error ? errorReason(e) : "Self-review failed"; }
        current.review = reviewUnavailable ? "unavailable: " + reviewUnavailable.slice(0, 240) : reviewOutcome;
        updateEngineTask(root, task.id, { review: current.review });
        if (reviewUnavailable) {
          close("blocked", "The engine's work verified, but the fresh-context self-review could not run (" + reviewUnavailable.slice(0, 200) + ") - unreviewed work is not done. The changes stay uncommitted on " + gitState.branch + ".");
          continue;
        }
        if (!reviewOutcome?.startsWith("PASS")) {
          close("blocked", "The fresh-context reviewer BLOCKED the engine's verified diff (" + (reviewOutcome ?? "no verdict").slice(0, 240) + "). The changes stay uncommitted on " + gitState.branch + "; a new engine proposal can take the findings as its task.");
          continue;
        }
      }
      // COMMIT: exactly the recorded paths, locally, on the task
      // branch (C4). Anything left pending closes blocked.
      gitState.pending = [...recorded];
      try { commitTaskPaths(root, gitState, [...recorded], 1, current.title); gitState.error = null; }
      catch (e) { gitState.error = e instanceof Error ? errorReason(e) : "git commit failed"; }
      current.git = gitState;
      updateEngineTask(root, task.id, { git: gitState });
      if (gitState.pending.length) {
        close("blocked", "The engine's work verified and reviewed, but git discipline is incomplete: " + gitState.pending.join(", ") + " not committed on " + gitState.branch + (gitState.error ? " - " + gitState.error.slice(0, 200) : "") + ". Uncommitted work is not done.");
        continue;
      }
      close("done", "The engine's changes were recorded by SAM, verified with a fresh build and test, " + (deps.review ? "passed the fresh-context review, " : "") + "and committed locally on " + gitState.branch + ". " + (current.output ?? "").slice(-240));
    }
    return { ran, blocked, failed, recovered };
  } finally { draining.delete(key); }
}

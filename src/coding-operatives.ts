import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./telegram.js";
import { OperativeRegistry, OPERATIVE_HEARTBEAT_TTL_MS, type Operative } from "./operatives.js";
import { commandCandidates, namedExecutable, probeDelimiter, probePlatform, type BinaryProbe } from "./bin-path.js";

// Coding-agent operatives (item 9). SAM delegates a repo job to a
// local Codex CLI or Claude Code process the way a coordinator hands
// work to a coding agent. The operative registry stays the capability
// declaration (name, adapter, code capability, heartbeat, lease). The
// approval gate is the only thing that may start a process: a
// delegation is a pending card until the owner approves it.
//
// The process runs in a dedicated git worktree on the named branch.
// That branch is never main. Nothing here pushes, opens a pull
// request, or sends anything. Auth is the CLI's own login on this
// machine, or an env var the operator already set. This module stores
// and logs the env-var NAME, never a key value.

export const CODING_ADAPTERS = ["codex", "claude-code"] as const;
export type CodingAdapter = (typeof CODING_ADAPTERS)[number];

export interface Delegation {
  id: string;
  actionId: string | null;
  adapter: CodingAdapter;
  repo: string;
  branch: string;
  prompt: string;
  actor: string;
  chatId: string | null;
  operativeId: string | null;
  leaseId: string | null;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  timeoutMs: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  diffStat: string | null;
  testResult: string | null;
  worktree: string | null;
  summary: string | null;
  auth: { binEnv: string; keyEnv: string; key: "present" | "absent" };
}

export interface OperativeRunResult { exitCode: number | null; timedOut: boolean; killed: boolean; output: string }
export type OperativeSpawn = (spec: { id: string; bin: string; args: string[]; cwd: string; timeoutMs: number; onChunk: (text: string) => void }) => Promise<OperativeRunResult>;

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const REFUSED_BRANCHES = new Set(["main", "master", "head", "HEAD"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_PROMPT = 1_500;
const MAX_OUTPUT = 1_000_000;
const killers = new Map<string, () => void>();

function delegationsPath(root: string): string { return join(resolve(root), ".sam", "delegations.json"); }
function logPath(root: string, id: string): string { return join(resolve(root), ".sam", "delegations", id + ".log"); }
function registryPath(root: string): string { return join(resolve(root), ".sam", "missions.db"); }

export function redactOperativeOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function adapterArgv(adapter: CodingAdapter, prompt: string): string[] {
  if (adapter === "codex") return ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--", prompt];
  return ["-p", prompt, "--output-format", "text", "--permission-mode", "acceptEdits"];
}

export function adapterLaunch(adapter: CodingAdapter, env: NodeJS.ProcessEnv = process.env): { bin: string; binEnv: string; keyEnv: string; key: "present" | "absent" } {
  if (adapter === "codex") {
    const named = env.SAM_CODEX_BIN?.trim();
    return { bin: named || "codex", binEnv: "SAM_CODEX_BIN", keyEnv: "CODEX_API_KEY", key: env.CODEX_API_KEY?.trim() ? "present" : "absent" };
  }
  const named = env.SAM_CLAUDE_BIN?.trim() || env.SAM_ENGINE_BIN?.trim();
  return {
    bin: named || "claude",
    binEnv: env.SAM_CLAUDE_BIN?.trim() ? "SAM_CLAUDE_BIN" : "SAM_ENGINE_BIN",
    keyEnv: "ANTHROPIC_API_KEY",
    key: env.ANTHROPIC_API_KEY?.trim() ? "present" : "absent",
  };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 512_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: ((err.stdout ?? "") + (err.stderr ?? "") || err.message || "git failed").trim() };
  }
}

/** The binary ONE adapter's run would spawn, resolved exactly
 *  as adapterLaunch resolves it: Codex rides SAM_CODEX_BIN, else
 *  "codex" on PATH; Claude Code rides SAM_CLAUDE_BIN, else
 *  SAM_ENGINE_BIN, else "claude" on PATH - through the bin-path
 *  helpers (the engine-connect providerBinary pattern: a named
 *  executable must be a real file, a symlink is not a file).
 *  Null means that adapter is not installed on this machine. */
export function delegateBinary(adapter: CodingAdapter, env: NodeJS.ProcessEnv = process.env, probe?: BinaryProbe): string | null {
  const platform = probePlatform(probe);
  const delimiter = probeDelimiter(probe);
  const launch = adapterLaunch(adapter, env);
  const namedRaw = adapter === "codex" ? env.SAM_CODEX_BIN?.trim() : (env.SAM_CLAUDE_BIN?.trim() || env.SAM_ENGINE_BIN?.trim());
  if (namedRaw) {
    const named = namedExecutable(namedRaw, platform);
    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }
  }
  for (const candidate of commandCandidates(env.PATH, delimiter, launch.bin, platform)) {
    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** The ONE source of the delegate not-installed refusal: the
 *  proposal-time gate in validateDelegateSpec throws it, so a
 *  card that cannot execute is never shown, in the engine
 *  kind's own shape. */
export function delegateNotInstalledReason(adapter: CodingAdapter): string {
  return adapter === "codex"
    ? "The coding operative (Codex) is not installed on this machine - no SAM_CODEX_BIN is set and no \"codex\" binary is on PATH. Installing it is the operator's act; until then a delegation cannot execute."
    : "The coding operative (Claude Code) is not installed on this machine - neither SAM_CLAUDE_BIN nor SAM_ENGINE_BIN is set and no \"claude\" binary is on PATH. Installing it is the operator's act; until then a delegation cannot execute.";
}

export function validateDelegateSpec(input: { adapter: string; repo: string; branch: string; prompt: string; timeoutMs?: number; chatId?: string | null }, env: NodeJS.ProcessEnv = process.env): { adapter: CodingAdapter; repo: string; branch: string; prompt: string; timeoutMs: number; chatId: string | null } {
  if (!CODING_ADAPTERS.includes(input.adapter as CodingAdapter)) throw new Error("Unknown coding adapter \"" + input.adapter + "\". Adapters: " + CODING_ADAPTERS.join(", "));
  const branch = (input.branch ?? "").trim();
  if (!BRANCH_RE.test(branch) || branch.split("/").includes("..") || REFUSED_BRANCHES.has(branch) || REFUSED_BRANCHES.has(branch.toLowerCase()))
    throw new Error("Refused branch \"" + branch + "\". A coding operative works on its own branch, never main or master.");
  const prompt = (input.prompt ?? "").trim();
  if (!prompt || prompt.length > MAX_PROMPT) throw new Error("Delegation prompt must be 1 to " + MAX_PROMPT + " characters");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) throw new Error("Timeout must be " + MIN_TIMEOUT_MS + " to " + MAX_TIMEOUT_MS + " milliseconds");
  const repo = resolve(input.repo ?? "");
  if (!existsSync(repo)) throw new Error("Repo does not exist: " + repo);
  const inside = git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") throw new Error("Repo is not a git work tree: " + repo);
  const head = git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw new Error("Repo has no commits yet, so a worktree branch cannot be created: " + repo);
  // The operative binary is the run's last deterministic
  // precondition: with no binary installed, the approved run's
  // spawn can only fail (ENOENT, exit code null, delegation
  // failed), so a card for that adapter can never execute. The
  // engine kind refuses not-installed at proposal time for
  // exactly this reason; the delegate gate now reads the same
  // precondition before any card is shown, in the ONE reason's
  // words. Installing the CLI stays the operator's act.
  if (!delegateBinary(input.adapter as CodingAdapter, env)) throw new Error(delegateNotInstalledReason(input.adapter as CodingAdapter));
  const chatId = input.chatId ?? null;
  if (chatId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) throw new Error("Invalid chat id");
  return { adapter: input.adapter as CodingAdapter, repo, branch, prompt, timeoutMs, chatId };
}

export function validateDelegateDetail(detail: string, env: NodeJS.ProcessEnv = process.env): { adapter: CodingAdapter; repo: string; branch: string; prompt: string; timeoutMs: number } {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid delegate detail: expected JSON {adapter, repo, branch, prompt}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid delegate detail: expected JSON {adapter, repo, branch, prompt}");
  const s = spec as { adapter?: unknown; repo?: unknown; branch?: unknown; prompt?: unknown; timeoutMs?: unknown };
  return validateDelegateSpec({
    adapter: typeof s.adapter === "string" ? s.adapter : "",
    repo: typeof s.repo === "string" ? s.repo : "",
    branch: typeof s.branch === "string" ? s.branch : "",
    prompt: typeof s.prompt === "string" ? s.prompt : "",
    timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
  }, env);
}

// State convergence (UNIFICATION item 4, thirty-fourth store):
// the delegations registry is SQLite (.sam/delegations.db, the
// coding pattern: better-sqlite3, WAL, busy_timeout 5000, one row
// per delegation holding the record's full JSON, rowid order =
// the old file order). The old delegations.json was rewritten
// whole on every put (propose, every run transition, cancel),
// and its writers span the gate executor process, the CLI, and
// any cancelling process, so two writers holding the same
// snapshot silently lost the second one's record: a cancel
// could revert under the run's next put (the run's own
// cancelled re-check is the read that can be fooled), a done
// mark could revert to pending and be run a second time, and a
// fresh proposal could vanish under its card. Here each
// mutation is a single-row INSERT or UPDATE. First open
// imports a legacy delegations.json in file order and renames
// it delegations.json.migrated - imported, never deleted; a
// malformed file or a non-array payload imports nothing and is
// left in place (reading as no delegations, exactly the old
// forgiving contract). A pure read on an install with neither
// file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with
// no backup change. The per-delegation run logs
// (.sam/delegations/<id>.log) are a different store and stay.
function delegationsDbFile(root: string): string { return join(resolve(root), ".sam", "delegations.db"); }
function openDelegationsStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(delegationsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyDelegations(db, root);
  return db;
}
function migrateLegacyDelegations(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM delegations").get() as { n: number };
  if (n > 0) return;
  const legacy = delegationsPath(root);
  if (!existsSync(legacy)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(legacy, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO delegations (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Partial<Delegation>;
      if (typeof item.id !== "string" || !item.id) continue;
      insert.run(item.id, JSON.stringify(item));
    }
  });
  importAll(data);
  renameSync(legacy, legacy + ".migrated");
}
function rowToDelegation(data: string): Delegation | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as Delegation : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(delegationsDbFile(root)) || existsSync(delegationsPath(root));
}
function readAll(root: string): Delegation[] {
  if (!storeExists(root)) return [];
  const db = openDelegationsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM delegations ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Delegation[] = [];
    for (const row of rows) { const item = rowToDelegation(row.data); if (item) items.push(item); }
    return items;
  } finally { db.close(); }
}
function readOne(root: string, id: string): Delegation | null {
  if (!storeExists(root)) return null;
  const db = openDelegationsStore(root);
  try {
    const row = db.prepare("SELECT data FROM delegations WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToDelegation(row.data) : null;
  } finally { db.close(); }
}
export function listDelegations(root: string): Delegation[] { return readAll(root); }
export function getDelegation(root: string, id: string): Delegation | null {
  return readAll(root).find(d => d.id === id || d.actionId === id) ?? null;
}
function put(root: string, job: Delegation): void {
  const db = openDelegationsStore(root);
  try {
    db.prepare("INSERT INTO delegations (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(job.id, JSON.stringify(job));
  } finally { db.close(); }
}
// The store's update door (the updateCodingTask precedent): patch
// one record by id through the store's own shape. Returns the
// updated record, or null when no such delegation exists - and a
// miss on an install with no store at all creates nothing.
export function updateDelegation(root: string, id: string, patch: Partial<Delegation>): Delegation | null {
  if (!storeExists(root)) return null;
  const current = readOne(root, id);
  if (!current) return null;
  const next: Delegation = { ...current, ...patch, id: current.id };
  put(root, next);
  return next;
}

function ensureOperative(root: string, adapter: CodingAdapter): Operative {
  const reg = new OperativeRegistry(registryPath(root));
  try {
    const found = reg.list().find(o => o.adapter === adapter && o.capabilities.includes("code"));
    if (found) return found;
    return reg.register({ name: adapter, adapter, capabilities: ["code"], maxConcurrency: 1 });
  } finally { reg.close(); }
}

export function operativeLiveness(operative: Operative, now = Date.now()): "fresh" | "stale" | "offline" {
  if (operative.state !== "available" || !operative.last_seen_at) return "offline";
  return Date.parse(operative.last_seen_at) > now - OPERATIVE_HEARTBEAT_TTL_MS ? "fresh" : "stale";
}

export function proposeDelegation(root: string, input: { actor?: string; adapter: string; repo: string; branch: string; prompt: string; timeoutMs?: number; chatId?: string | null }, propose: (detail: string, title: string) => { id: string }, env: NodeJS.ProcessEnv = process.env): Delegation {
  const spec = validateDelegateSpec(input, env);
  if (spec.chatId) {
    const db = new ChatStore(root);
    try { if (!db.get(spec.chatId)) throw new Error("Unknown chat: " + spec.chatId); }
    finally { db.close(); }
  }
  const operative = ensureOperative(root, spec.adapter);
  const launch = adapterLaunch(spec.adapter, env);
  const detail = JSON.stringify({ adapter: spec.adapter, repo: spec.repo, branch: spec.branch, prompt: spec.prompt, timeoutMs: spec.timeoutMs });
  const title = "Delegate to " + spec.adapter + " on " + spec.branch;
  const proposal = propose(detail, title);
  const job: Delegation = {
    id: randomUUID(), actionId: proposal.id, adapter: spec.adapter, repo: spec.repo, branch: spec.branch, prompt: spec.prompt,
    actor: input.actor ?? "sam", chatId: spec.chatId, operativeId: operative.id, leaseId: null, status: "pending",
    timeoutMs: spec.timeoutMs, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    exitCode: null, timedOut: false, diffStat: null, testResult: null, worktree: null, summary: null,
    auth: { binEnv: launch.binEnv, keyEnv: launch.keyEnv, key: launch.key },
  };
  put(root, job);
  recordActivity(root, job.actor, "delegate-proposed", delegateProposedLedgerSummary(job.id, spec.adapter, spec.branch));
  return job;
}

function prepareWorktree(repo: string, branch: string, worktree: string): void {
  if (REFUSED_BRANCHES.has(branch) || REFUSED_BRANCHES.has(branch.toLowerCase())) throw new Error("Refused to check out " + branch);
  mkdirSync(dirname(worktree), { recursive: true });
  const exists = git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
  const added = exists.ok
    ? git(repo, ["worktree", "add", worktree, branch])
    : git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  if (!added.ok) throw new Error("Could not create a worktree for " + branch + ": " + added.out.slice(0, 300));
  const checked = git(worktree, ["branch", "--show-current"]);
  if (!checked.ok || checked.out === "main" || checked.out === "master" || checked.out !== branch)
    throw new Error("Worktree came up on " + (checked.out || "no branch") + ", not " + branch);
}

function diffStat(worktree: string): string {
  const status = git(worktree, ["status", "--short"]);
  const diff = git(worktree, ["diff", "--stat"]);
  const parts = [];
  if (status.out) parts.push(status.out);
  if (diff.out) parts.push(diff.out);
  return redactOperativeOutput(parts.join("\n") || "(no changes)");
}

function runTests(worktree: string, timeoutMs: number): string {
  const pkgPath = join(worktree, "package.json");
  if (!existsSync(pkgPath)) return "not-run: no package.json";
  let scripts: { test?: unknown } = {};
  try { scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: { test?: unknown } }).scripts ?? {}; }
  catch { return "not-run: package.json unreadable"; }
  if (typeof scripts.test !== "string" || !scripts.test.trim()) return "not-run: no test script";
  try {
    execFileSync("npm", ["test", "--silent"], { cwd: worktree, encoding: "utf8", timeout: timeoutMs, maxBuffer: 512_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: process.env });
    return "passed";
  } catch (error) {
    const err = error as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (err.killed) return "failed: timed out";
    const tail = redactOperativeOutput(((err.stdout ?? "") + (err.stderr ?? "")).trim()).slice(-400);
    return "failed" + (tail ? ": " + tail : "");
  }
}

export function delegationKillArmed(id: string): boolean { return killers.has(id); }

export const defaultOperativeSpawn: OperativeSpawn = (spec) => new Promise(done => {
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: process.env, detached: true });
  let settled = false;
  let timedOut = false;
  let killed = false;
  let output = "";
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    killers.delete(spec.id);
    done({ exitCode, timedOut, killed: killed && !timedOut, output: redactOperativeOutput(output).slice(0, MAX_OUTPUT) });
  };
  const kill = () => {
    killed = true;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the direct kill below still runs */ }
    child.kill("SIGKILL");
  };
  killers.set(spec.id, kill);
  const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
  const take = (buf: Buffer) => {
    const piece = redactOperativeOutput(buf.toString("utf8"));
    if (output.length >= MAX_OUTPUT) { kill(); return; }
    output += piece;
    spec.onChunk(piece.slice(0, 500));
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", err => {
    output += redactOperativeOutput(errorReason(err));
    finish(null);
  });
  child.on("close", code => finish(code));
});

function appendLog(root: string, id: string, text: string): void {
  const file = logPath(root, id);
  mkdirSync(dirname(file), { recursive: true });
  const prior = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, (prior + text).slice(-MAX_OUTPUT), { mode: 0o600 });
}

function postReport(root: string, job: Delegation, text: string): void {
  if (!job.chatId) return;
  try {
    const db = new ChatStore(root);
    try { db.add(job.chatId, "assistant", text.slice(0, 12_000)); }
    finally { db.close(); }
  } catch { /* the report still lives on the delegation record */ }
}

// Delegation failures carry their cause (gap found
// 2026-11-17, hourly run 01:04 EST): runApprovedDelegation's
// catch took error.message alone over the operative
// registry and lease doors, worktree git, filesystem
// writes, and the operative spawn, and that one bare
// message fed every record of the death - the delegation's
// stored summary, the ONE delegate-failed (or
// delegate-cancelled) activity line per failed run, and
// the report posted into the originating chat, which
// carries the summary - so an error carrying its real
// reason on error.cause, or an errno-style code the
// message omits, named nothing (launch vs lease vs
// worktree vs store indistinguishable). The reason now
// composes through errorReason (the 04:04 bridge seam):
// the cause chain is walked bounded and deduped,
// errno-style codes are appended, and bot-token segments
// are redacted, so a delegation dying on a coded store or
// transport-shaped error names it in every record in the
// same shape. Causeless errors read byte-identically, a
// non-Error throw keeps the existing "failed" fallback,
// and the delegation prompt never enters a failure record.
export function delegateFailureReason(error: unknown): string {
  return error instanceof Error ? errorReason(error) : "failed";
}

export function delegateFailedSummary(status: string, error: unknown): string {
  return "Delegation " + status + ": " + delegateFailureReason(error);
}

// Delegation lifecycle history (gap found 2026-11-21, hourly
// run 19:04 EST): the delegation lifecycle ledgers five
// classes - "delegate-proposed", "delegate-output",
// "delegate-done", "delegate-failed", and
// "delegate-cancelled" (three shapes: the run terminal, the
// catch-path reason form, and cancelDelegation's own line) -
// but the shapes were inline strings in this module with no
// writer, no parser, and no fold, so how many delegations
// were ever proposed, completed, failed, or cancelled over
// an install's life was invisible in aggregate; the
// delegations store is rewritten in place and holds only
// current jobs, so a finished delegation's history leaves
// no surface but these lines (the failover-routes
// precedent). These are the ONE writers for every shape
// (byte-identical to the inline shapes they replace; the
// five seams ride them), the parsers, and the history
// scorecard. A failed delegation is the failure class, so
// the verdict is attention when any failed was ever
// recorded or any line is unparseable, else clear; a
// cancellation is an owner act, not a failure. The
// scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no delegation id, no
// adapter, no branch, no prompt, no output text, and no
// verbatim summary. The scorecard path is a pure read -
// it creates nothing, proposes nothing, and opens no
// store.
export function delegateProposedLedgerSummary(id: string, adapter: string, branch: string): string {
  return "Delegation " + id + " cards the owner: " + adapter + " " + branch + " (nothing has run)";
}

export function delegateOutputLedgerSummary(adapter: string, id: string, cleanChunk: string): string {
  return adapter + " " + id.slice(0, 8) + ": " + cleanChunk.replace(/\s+/g, " ").slice(0, 220);
}

export function delegateRunLedgerSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").slice(0, 280);
}

export function delegateFailureLedgerSummary(summary: string): string {
  return summary.slice(0, 280);
}

export function delegateCancelledLedgerSummary(id: string, adapter: string, branch: string): string {
  return "Cancelled delegation " + id + " (" + adapter + " " + branch + ")";
}

export function parseDelegateProposedSummary(summary: string): { id: string; adapter: string; branch: string } | null {
  const m = /^Delegation (\S+) cards the owner: (\S+) (\S+) \(nothing has run\)$/.exec(summary);
  if (!m) return null;
  return { id: m[1] ?? "", adapter: m[2] ?? "", branch: m[3] ?? "" };
}

export function parseDelegateOutputSummary(summary: string): { adapter: string; idPrefix: string } | null {
  const m = /^(\S+) ([0-9a-f]{8}): (.+)$/.exec(summary);
  if (!m) return null;
  return { adapter: m[1] ?? "", idPrefix: m[2] ?? "" };
}

export function parseDelegateDoneSummary(summary: string): { adapter: string; branch: string; exitCode: string } | null {
  const m = /^Delegation done: (\S+) on branch (\S+) exit (\S+)/.exec(summary);
  if (!m) return null;
  return { adapter: m[1] ?? "", branch: m[2] ?? "", exitCode: m[3] ?? "" };
}

export function parseDelegateFailedSummary(summary: string): { adapter: string | null; branch: string | null } | null {
  const m = /^Delegation failed: (.+)$/.exec(summary);
  if (!m) return null;
  const run = /^(\S+) on branch (\S+) exit \S+/.exec(m[1] ?? "");
  return { adapter: run ? (run[1] ?? null) : null, branch: run ? (run[2] ?? null) : null };
}

export function parseDelegateCancelledSummary(summary: string): { id: string | null; adapter: string | null; branch: string | null } | null {
  const own = /^Cancelled delegation (\S+) \((\S+) (\S+)\)$/.exec(summary);
  if (own) return { id: own[1] ?? "", adapter: own[2] ?? "", branch: own[3] ?? "" };
  const m = /^Delegation cancelled: (.+)$/.exec(summary);
  if (!m) return null;
  const run = /^(\S+) on branch (\S+) exit \S+/.exec(m[1] ?? "");
  return { id: null, adapter: run ? (run[1] ?? null) : null, branch: run ? (run[2] ?? null) : null };
}

export function delegateHistoryScorecardText(root: string): string {
  const proposedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "delegate-proposed" });
  const outputLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "delegate-output" });
  const doneLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "delegate-done" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "delegate-failed" });
  const cancelledLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "delegate-cancelled" });
  let proposed = 0;
  let output = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let unparseable = 0;
  const delegations = new Set<string>();
  for (const line of proposedLines) {
    const parsed = parseDelegateProposedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    proposed += 1;
    delegations.add(parsed.id);
  }
  for (const line of outputLines) {
    if (!parseDelegateOutputSummary(line.summary)) { unparseable += 1; continue; }
    output += 1;
  }
  for (const line of doneLines) {
    if (!parseDelegateDoneSummary(line.summary)) { unparseable += 1; continue; }
    done += 1;
  }
  for (const line of failedLines) {
    if (!parseDelegateFailedSummary(line.summary)) { unparseable += 1; continue; }
    failed += 1;
  }
  for (const line of cancelledLines) {
    const parsed = parseDelegateCancelledSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    cancelled += 1;
    if (parsed.id) delegations.add(parsed.id);
  }
  const total = proposedLines.length + outputLines.length + doneLines.length + failedLines.length + cancelledLines.length;
  const parts: string[] = [];
  parts.push("Delegate history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(proposed) + " proposed");
  parts.push(String(done) + " done");
  parts.push(String(failed) + " failed");
  parts.push(String(cancelled) + " cancelled");
  parts.push(String(output) + " output lines");
  parts.push(String(delegations.size) + " distinct delegations");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

export async function runApprovedDelegation(root: string, action: { id: string; actor: string; chatId: string | null; detail: string }, env: NodeJS.ProcessEnv = process.env, spawnImpl: OperativeSpawn = defaultOperativeSpawn): Promise<Delegation> {
  const existing = readAll(root).find(d => d.actionId === action.id);
  if (existing?.status === "cancelled") throw new Error("Delegation was cancelled before it ran");
  const spec = validateDelegateDetail(existing
    ? JSON.stringify({ adapter: existing.adapter, repo: existing.repo, branch: existing.branch, prompt: existing.prompt, timeoutMs: existing.timeoutMs })
    : action.detail, env);
  const launch = adapterLaunch(spec.adapter, env);
  const operative = ensureOperative(root, spec.adapter);
  const job: Delegation = existing ?? {
    id: randomUUID(), actionId: action.id, adapter: spec.adapter, repo: spec.repo, branch: spec.branch, prompt: spec.prompt,
    actor: action.actor, chatId: action.chatId, operativeId: operative.id, leaseId: null, status: "pending", timeoutMs: spec.timeoutMs,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, exitCode: null, timedOut: false,
    diffStat: null, testResult: null, worktree: null, summary: null,
    auth: { binEnv: launch.binEnv, keyEnv: launch.keyEnv, key: launch.key },
  };
  job.operativeId = operative.id;
  job.worktree = join(resolve(root), ".sam", "worktrees", job.id);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  put(root, job);
  const reg = new OperativeRegistry(registryPath(root));
  let leased = false;
  try {
    if (!reg.setState(operative.id, "available") && reg.list().every(o => o.id !== operative.id)) throw new Error("Coding operative is not registered");
    if (!reg.heartbeat(operative.id)) throw new Error("Coding operative could not renew its heartbeat");
    if (!reg.reserve(operative.id)) throw new Error("Coding operative is at capacity");
    const leases = new AssignmentLeases(registryPath(root));
    let generation = 0;
    try {
      const lease = leases.claim(operative.id, job.id, Date.now(), job.timeoutMs + 30_000);
      if (!lease) throw new Error("No assignment lease granted");
      job.leaseId = lease.id;
      generation = lease.generation;
      leased = true;
      put(root, job);
    } finally { leases.close(); }
    prepareWorktree(spec.repo, spec.branch, job.worktree);
    let chunks = 0;
    const result = await spawnImpl({
      id: job.id, bin: launch.bin, args: adapterArgv(spec.adapter, spec.prompt), cwd: job.worktree, timeoutMs: job.timeoutMs,
      onChunk: (text) => {
        const clean = redactOperativeOutput(text);
        appendLog(root, job.id, clean);
        if (chunks < 8 && clean.trim()) {
          chunks++;
          recordActivity(root, job.actor, "delegate-output", delegateOutputLedgerSummary(spec.adapter, job.id, clean));
        }
      },
    });
    job.exitCode = result.exitCode;
    job.timedOut = result.timedOut;
    job.diffStat = diffStat(job.worktree);
    job.testResult = result.killed ? "not-run: cancelled" : runTests(job.worktree, Math.min(30_000, job.timeoutMs));
    const latest = getDelegation(root, job.id);
    const cancelled = result.killed || latest?.status === "cancelled";
    job.status = cancelled ? "cancelled" : result.timedOut || result.exitCode !== 0 ? "failed" : "done";
    job.finishedAt = new Date().toISOString();
    job.summary = [
      "Delegation " + job.status + ": " + spec.adapter + " on branch " + spec.branch,
      "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : ""),
      "diff:",
      job.diffStat ?? "(none)",
      "tests: " + (job.testResult ?? "not-run"),
      "Not pushed. No pull request was opened.",
    ].join("\n").slice(0, 4_000);
    put(root, job);
    recordActivity(root, job.actor, "delegate-" + job.status, delegateRunLedgerSummary(job.summary));
    postReport(root, job, job.summary);
    if (leased && job.leaseId) {
      const leases = new AssignmentLeases(registryPath(root));
      try { leases.finish(job.leaseId, operative.id, generation); } finally { leases.close(); }
    }
    return job;
  } catch (error) {
    job.status = getDelegation(root, job.id)?.status === "cancelled" ? "cancelled" : "failed";
    job.finishedAt = new Date().toISOString();
    job.summary = delegateFailedSummary(job.status, error);
    put(root, job);
    recordActivity(root, job.actor, "delegate-" + job.status, delegateFailureLedgerSummary(job.summary));
    postReport(root, job, job.summary);
    throw error;
  } finally {
    try { reg.release(operative.id); } catch { /* capacity is best-effort once the process has ended */ }
    reg.close();
    killers.delete(job.id);
  }
}

export function cancelDelegation(root: string, id: string): Delegation {
  const job = getDelegation(root, id);
  if (!job) throw new Error("Unknown delegation: " + id);
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") throw new Error("Delegation is already " + job.status);
  killers.get(job.id)?.();
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.summary = "Delegation cancelled before it could finish. Nothing was pushed.";
  put(root, job);
  recordActivity(root, job.actor, "delegate-cancelled", delegateCancelledLedgerSummary(job.id, job.adapter, job.branch));
  return job;
}

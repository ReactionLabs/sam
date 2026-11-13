import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { OperativeRegistry, OPERATIVE_HEARTBEAT_TTL_MS, type Operative } from "./operatives.js";

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

export function validateDelegateSpec(input: { adapter: string; repo: string; branch: string; prompt: string; timeoutMs?: number; chatId?: string | null }): { adapter: CodingAdapter; repo: string; branch: string; prompt: string; timeoutMs: number; chatId: string | null } {
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
  const chatId = input.chatId ?? null;
  if (chatId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) throw new Error("Invalid chat id");
  return { adapter: input.adapter as CodingAdapter, repo, branch, prompt, timeoutMs, chatId };
}

export function validateDelegateDetail(detail: string): { adapter: CodingAdapter; repo: string; branch: string; prompt: string; timeoutMs: number } {
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
  });
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

export function proposeDelegation(root: string, input: { actor?: string; adapter: string; repo: string; branch: string; prompt: string; timeoutMs?: number; chatId?: string | null }, propose: (detail: string, title: string) => { id: string }): Delegation {
  const spec = validateDelegateSpec(input);
  if (spec.chatId) {
    const db = new ChatStore(root);
    try { if (!db.get(spec.chatId)) throw new Error("Unknown chat: " + spec.chatId); }
    finally { db.close(); }
  }
  const operative = ensureOperative(root, spec.adapter);
  const launch = adapterLaunch(spec.adapter);
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
  recordActivity(root, job.actor, "delegate-proposed", "Delegation " + job.id + " cards the owner: " + spec.adapter + " " + spec.branch + " (nothing has run)");
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
    output += redactOperativeOutput(err instanceof Error ? err.message : String(err));
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

export async function runApprovedDelegation(root: string, action: { id: string; actor: string; chatId: string | null; detail: string }, env: NodeJS.ProcessEnv = process.env, spawnImpl: OperativeSpawn = defaultOperativeSpawn): Promise<Delegation> {
  const existing = readAll(root).find(d => d.actionId === action.id);
  if (existing?.status === "cancelled") throw new Error("Delegation was cancelled before it ran");
  const spec = validateDelegateDetail(existing
    ? JSON.stringify({ adapter: existing.adapter, repo: existing.repo, branch: existing.branch, prompt: existing.prompt, timeoutMs: existing.timeoutMs })
    : action.detail);
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
          recordActivity(root, job.actor, "delegate-output", spec.adapter + " " + job.id.slice(0, 8) + ": " + clean.replace(/\s+/g, " ").slice(0, 220));
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
    recordActivity(root, job.actor, "delegate-" + job.status, job.summary.replace(/\s+/g, " ").slice(0, 280));
    postReport(root, job, job.summary);
    if (leased && job.leaseId) {
      const leases = new AssignmentLeases(registryPath(root));
      try { leases.finish(job.leaseId, operative.id, generation); } finally { leases.close(); }
    }
    return job;
  } catch (error) {
    job.status = getDelegation(root, job.id)?.status === "cancelled" ? "cancelled" : "failed";
    job.finishedAt = new Date().toISOString();
    job.summary = "Delegation " + job.status + ": " + (error instanceof Error ? error.message : "failed");
    put(root, job);
    recordActivity(root, job.actor, "delegate-" + job.status, job.summary.slice(0, 280));
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
  recordActivity(root, job.actor, "delegate-cancelled", "Cancelled delegation " + job.id + " (" + job.adapter + " " + job.branch + ")");
  return job;
}

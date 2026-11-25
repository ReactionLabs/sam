import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./telegram.js";

// Legs (program P5): background work. A chat can hand off a long task - the
// turn returns immediately with a task id, and the task runs later (drained by
// each heartbeat tick, or on demand by CLI) as a real chat turn in the SAME
// chat, on the deep "background" budget tier. The result lands in the chat as
// an ordinary exchange, so the owner reads it where they asked for it; the
// queue itself lives in .sam/background.db and every transition lands in the
// activity ledger. A task whose runner died mid-run is failed by the next
// drain instead of wedging the queue forever.
export type BackgroundStatus = "queued" | "running" | "done" | "failed";
export interface BackgroundTask {
  id: string; actor: string; chatId: string; title: string; prompt: string;
  status: BackgroundStatus; createdAt: string; startedAt: string | null;
  finishedAt: string | null; result: string | null;
}
const MAX_OPEN = 20;
const STALE_RUNNING_MS = 30 * 60000;
function bgFile(root: string): string { return join(resolve(root), ".sam", "background.json"); }
function bgDbFile(root: string): string { return join(resolve(root), ".sam", "background.db"); }
// State convergence (UNIFICATION item 4, fourth store): the background
// queue is SQLite (.sam/background.db, the actions/jobs pattern), one
// row per task holding the task's full JSON, rowid order = the old file
// order. The old background.json was rewritten whole on every queue and
// on every drain transition (the stale-recovery pass, each task's
// running mark, and its done/failed mark - several whole-file rewrites
// per task per tick), and three processes write this store (the
// dashboard/chat process queues through sam_handoff_task, the heartbeat
// tick drains, the CLI drains on demand), so two writers holding the
// same snapshot silently lost the second one's record: a queued task
// could vanish under a tick's transition save, and a finished task's
// done mark could revert to queued and run twice. Here each mutation
// is a single-row INSERT or UPDATE, and connections carry a
// busy_timeout (the F1 cross-process lock seam) so a writer waits out
// a peer's transaction instead of dying on "database is locked". First
// open imports a legacy background.json in file order and renames it
// background.json.migrated - imported, never deleted; a malformed file
// imports nothing and is left in place. A pure read on an install with
// neither file creates nothing, so read-only audits stay read-only.
// The P9 backup snapshots every .sam/*.db generically, so the migrated
// store is carried with no backup change.
// Failure visibility (gap found 2026-11-15, hourly run
// 18:04 EST): the background store holds the P5 legs
// queue - each handed-off task's actor, chat, title,
// prompt, status, and result - and every touch opened
// it raw. listBackgroundTasks rides the dashboard
// status payload, the morning brief, and the
// UNIFICATION census; getBackgroundTask and the row
// writes ride the heartbeat drain's transitions,
// updateBackgroundTask, and the CLI background verbs;
// queueBackgroundTask rides the sam_handoff_task chat
// tool. A dead background.db threw into whichever catch
// wrapped the call with the seam unnamed, and no
// background-store-failed kind existed
// (background-failed is the drain's task-outcome class,
// a different seam), so the class was uncountable, and
// any reader folding a dead store as "no tasks" would
// silently empty the legs queue dressed as an idle
// install - a handed-off task's record gone while its
// chat waits for a result that can now never land. Now
// the store's touches own their failure (the coding
// precedent): a failed touch ledgers ONE
// background-store-failed line (phase read for
// listBackgroundTasks / getBackgroundTask, write for
// insertTask / updateTaskRow and every mutation door
// riding them; actor sam; the verbatim reason collapsed
// and capped; never any task record - prompts, titles,
// and results are the owner's words, not failure data),
// tags the error, and rethrows exactly, so every
// caller's handling is unchanged and reads still fail
// closed. A touch already ledgered by an inner door
// keeps its one line and gains no second. Validation
// errors (actor / prompt / chat / queue-full refusals)
// are not store failures and ledger nothing. An absent
// store still reads empty with no line and creates
// nothing, and torn row payloads still parse forgiving
// - only the store touch is guarded.
export type BackgroundStorePhase = "read" | "write";

export function backgroundStoreFailureSummary(phase: BackgroundStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Background store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a background-store-failed line carries (census sprint
 * 2026-11-17): recordBackgroundStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function backgroundStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordBackgroundStoreFailure(root: string, phase: BackgroundStorePhase, error: unknown): void {
  const reason = backgroundStoreFailureReason(error);
  recordActivity(root, "sam", "background-store-failed", backgroundStoreFailureSummary(phase, reason));
}

function tagBackgroundStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { backgroundStoreLedgered?: boolean }).backgroundStoreLedgered = true;
  }
}

export function isBackgroundStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { backgroundStoreLedgered?: boolean }).backgroundStoreLedgered === true;
}

const BACKGROUND_STORE_VALIDATION = [/^Invalid actor$/, /^Invalid background prompt$/, /^A chat is required$/, /^Background queue is full$/];

function isBackgroundStoreValidation(error: unknown): boolean {
  return error instanceof Error && BACKGROUND_STORE_VALIDATION.some(re => re.test(error.message));
}

function failBackgroundStore(root: string, phase: BackgroundStorePhase, error: unknown): never {
  if (!isBackgroundStoreLedgered(error) && !isBackgroundStoreValidation(error)) recordBackgroundStoreFailure(root, phase, error);
  if (!isBackgroundStoreValidation(error)) tagBackgroundStoreLedgered(error);
  throw error;
}

function openBackgroundGuarded(root: string, phase: BackgroundStorePhase): Database.Database {
  try { return openBackgroundStore(root); }
  catch (error) { failBackgroundStore(root, phase, error); }
}
function openBackgroundStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(bgDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS background_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyBackground(db, root);
  return db;
}
function migrateLegacyBackground(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM background_tasks").get() as { n: number };
  if (n > 0) return;
  const file = bgFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO background_tasks (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const task = raw as Partial<BackgroundTask>;
      if (typeof task.id !== "string" || !task.id) continue;
      insert.run(task.id, JSON.stringify(task));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToTask(data: string): BackgroundTask | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as BackgroundTask : null; }
  catch { return null; }
}
export function listBackgroundTasks(root: string): BackgroundTask[] {
  if (!existsSync(bgDbFile(root)) && !existsSync(bgFile(root))) return [];
  const db = openBackgroundGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM background_tasks ORDER BY rowid").all() as Array<{ data: string }>;
    const items: BackgroundTask[] = [];
    for (const row of rows) { const task = rowToTask(row.data); if (task) items.push(task); }
    return items;
  } catch (error) { failBackgroundStore(root, "read", error); }
  finally { db.close(); }
}
export function getBackgroundTask(root: string, id: string): BackgroundTask | null {
  if (!existsSync(bgDbFile(root)) && !existsSync(bgFile(root))) return null;
  const db = openBackgroundGuarded(root, "read");
  try {
    const row = db.prepare("SELECT data FROM background_tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToTask(row.data) : null;
  } catch (error) { failBackgroundStore(root, "read", error); }
  finally { db.close(); }
}
function insertTask(root: string, item: BackgroundTask): void {
  const db = openBackgroundGuarded(root, "write");
  try { db.prepare("INSERT INTO background_tasks (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  catch (error) { failBackgroundStore(root, "write", error); }
  finally { db.close(); }
}
function updateTaskRow(root: string, item: BackgroundTask): void {
  const db = openBackgroundGuarded(root, "write");
  try { db.prepare("UPDATE background_tasks SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  catch (error) { failBackgroundStore(root, "write", error); }
  finally { db.close(); }
}
// The store's update door (the updateHeartbeatJob precedent): patch one
// task by id through the store's own shape. Returns the updated task,
// or null when no such task exists - and a miss on an install with no
// store at all creates nothing.
export function updateBackgroundTask(root: string, id: string, patch: Partial<BackgroundTask>): BackgroundTask | null {
  if (!existsSync(bgDbFile(root)) && !existsSync(bgFile(root))) return null;
  const current = getBackgroundTask(root, id);
  if (!current) return null;
  const next: BackgroundTask = { ...current, ...patch, id: current.id };
  updateTaskRow(root, next);
  return next;
}
function normalizeBackgroundProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source for why a background task cannot be queued
 *  for this actor profile: the name is not in the profile registry
 *  ("sam", the implicit core profile, plus every registered
 *  agent), so a task bound to it would be accounted to no one -
 *  the record sits in the queue under an actor that is no
 *  profile, its ledger line carries that same phantom actor,
 *  and the drain runs its turn under a profile that resolves
 *  no registered profile. The terminal queue door (CLI
 *  `background handoff --actor`) rides this source and refuses
 *  before queuing anything. When exactly one valid profile
 *  matches the bad name folded for case and separators, the
 *  refusal names it ("Second Shift" -> "second-shift"). Null
 *  means the profile can be named. queueBackgroundTask itself
 *  stays permissive by design: a profile removed after a task
 *  names it leaves the record with its stored actor, and the
 *  sam_handoff_task chat tool names its actor by construction
 *  (the speaking chat's own profile) and is not gated here, so
 *  queueBackgroundTask is NOT gated. */
export function backgroundProfileBlocker(root: string, profile: string): string | null {
  const db = new ChatStore(root);
  let names: string[];
  try { names = ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; } finally { db.close(); }
  if (names.includes(profile)) return null;
  const target = normalizeBackgroundProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizeBackgroundProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in background detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
export function queueBackgroundTask(root: string, input: { actor: string; chatId: string; prompt: string; title?: string }): BackgroundTask {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const prompt = (input.prompt ?? "").trim();
  if (!prompt || prompt.length > 4000) throw new Error("Invalid background prompt");
  if (!input.chatId) throw new Error("A chat is required");
  const db = new ChatStore(root);
  try { db.messages(input.chatId); } finally { db.close(); }
  const items = listBackgroundTasks(root);
  if (items.filter(t => t.status === "queued" || t.status === "running").length >= MAX_OPEN) throw new Error("Background queue is full");
  const title = (input.title ?? "").trim().slice(0, 120) || prompt.slice(0, 120);
  const item: BackgroundTask = {
    id: randomUUID(), actor: input.actor, chatId: input.chatId, title, prompt,
    status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null,
  };
  insertTask(root, item);
  recordActivity(root, input.actor, "background-queued", backgroundQueuedLedgerSummary(title));
  return item;
}
// Background failures carry their cause (gap found
// 2026-11-16, hourly run 12:04 EST): the drain catch took
// e.message alone over a real chat turn, so a task dying on
// transport ledgered the bare undici wrapper "fetch failed"
// as its background-failed line, its stored result, AND the
// failure post in the owner's chat - the wrapper in every
// record, the cause in none. The reason now composes
// through errorReason (the 04:04 bridge seam): the cause
// chain is walked bounded and deduped, errno-style codes are
// appended, and bot-token segments are redacted, so a task
// dying on a DNS failure names the lookup in all three
// records in the same shape. Causeless errors read
// byte-identically, a non-Error throw keeps the existing
// "Background run failed" fallback, and the task's prompt
// never enters any failure record (the title only, as
// before).
export function backgroundFailureReason(error: unknown): string {
  return error instanceof Error ? errorReason(error) : "Background run failed";
}

export function backgroundFailedSummary(title: string, error: unknown): string {
  return "Background task failed: " + title + " - " + backgroundFailureReason(error).slice(0, 120);
}

// The ONE writers for the background lifecycle's activity
// lines, so the history scorecard's parsers below can never
// drift from the seams they count. The shapes are
// byte-identical to what queueBackgroundTask and
// drainBackgroundTasks wrote inline before these writers
// existed; backgroundFailedSummary above stays the
// drain-failure writer for the same reason.
export function backgroundQueuedLedgerSummary(title: string): string {
  return "Handed off background task: " + title;
}
export function backgroundStartedLedgerSummary(title: string): string {
  return "Background task started: " + title;
}
export function backgroundDoneLedgerSummary(title: string): string {
  return "Background task finished in its chat: " + title;
}
export function backgroundDiedLedgerSummary(title: string): string {
  return "Background task died mid-run: " + title;
}

// The background history scorecard (2026-11-21, the
// measured-proof series): every background lifecycle event
// has ledgered as a background-queued / background-started /
// background-done / background-failed line since the legs
// landed - until now as inline concatenation at the seams,
// with no ONE writer and no fold, so how many tasks were
// ever handed off, started, finished, or failed was
// invisible in aggregate (listBackgroundTasks reads only
// the current store - a done or failed row is overwritten
// in place, and a recovered stale task's died-mid-run
// failure leaves no current-state trace). A failure is the
// signal of the four - a handed-off task that never landed
// its result in its chat - so the verdict is attention only
// when any failure was ever recorded or a line is
// unparseable, else clear. This text folds the four classes
// to counts only, on ONE line: queued, started, done, and
// failed counts, the distinct-title count as a number only,
// and the total. No stamp, no actor, no title, no failure
// reason, and no verbatim summary enters the text - the
// summaries carry task titles and failure reasons, which
// are the owner's words, and the fold consumes and never
// prints them. A pure read: it creates nothing, queues
// nothing, and drains nothing - the background seams
// themselves are untouched beyond riding their ONE writers.
export function parseBackgroundQueuedSummary(summary: string): { title: string } | null {
  const m = /^Handed off background task: (.+)$/.exec(summary);
  if (!m || !m[1].trim()) return null;
  return { title: m[1] };
}
export function parseBackgroundStartedSummary(summary: string): { title: string } | null {
  const m = /^Background task started: (.+)$/.exec(summary);
  if (!m || !m[1].trim()) return null;
  return { title: m[1] };
}
export function parseBackgroundDoneSummary(summary: string): { title: string } | null {
  const m = /^Background task finished in its chat: (.+)$/.exec(summary);
  if (!m || !m[1].trim()) return null;
  return { title: m[1] };
}
export function parseBackgroundFailedSummary(summary: string): { title: string } | null {
  const died = /^Background task died mid-run: (.+)$/.exec(summary);
  if (died) {
    if (!died[1].trim()) return null;
    return { title: died[1] };
  }
  const m = /^Background task failed: (.+) - (.+)$/.exec(summary);
  if (!m || !m[1].trim() || !m[2].trim()) return null;
  return { title: m[1] };
}

export function backgroundHistoryScorecardText(root: string): string {
  const queuedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "background-queued" });
  const startedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "background-started" });
  const doneLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "background-done" });
  const failedLines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "background-failed" });
  let queued = 0;
  let started = 0;
  let done = 0;
  let failed = 0;
  let unparseable = 0;
  const titles = new Set<string>();
  for (const line of queuedLines) {
    const parsed = parseBackgroundQueuedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    queued += 1;
    titles.add(parsed.title);
  }
  for (const line of startedLines) {
    const parsed = parseBackgroundStartedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    started += 1;
    titles.add(parsed.title);
  }
  for (const line of doneLines) {
    const parsed = parseBackgroundDoneSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    done += 1;
    titles.add(parsed.title);
  }
  for (const line of failedLines) {
    const parsed = parseBackgroundFailedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    failed += 1;
    titles.add(parsed.title);
  }
  const total = queuedLines.length + startedLines.length + doneLines.length + failedLines.length;
  const parts: string[] = [];
  parts.push("Background history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(queued) + " queued");
  parts.push(String(started) + " started");
  parts.push(String(done) + " done");
  parts.push(String(failed) + " failed");
  parts.push(String(titles.size) + " distinct titles");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

const draining = new Set<string>();
export interface DrainDeps { runTurn: (chatId: string, content: string) => Promise<string>; maxPerDrain?: number }
export async function drainBackgroundTasks(root: string, deps: DrainDeps): Promise<{ ran: string[]; failed: string[]; recovered: string[] }> {
  const key = resolve(root);
  if (draining.has(key)) return { ran: [], failed: [], recovered: [] };
  draining.add(key);
  const ran: string[] = []; const failed: string[] = []; const recovered: string[] = [];
  try {
    // Recover first: a task still marked running long after its runner could
    // have finished means the runner died. Fail it loudly in its own chat.
    const now = Date.now();
    for (const t of listBackgroundTasks(root)) {
      if (t.status === "running" && t.startedAt && now - Date.parse(t.startedAt) > STALE_RUNNING_MS) {
        updateTaskRow(root, { ...t, status: "failed", finishedAt: new Date().toISOString(), result: "Runner stopped mid-task; marked failed by the next drain." });
        recovered.push(t.id);
        recordActivity(root, t.actor, "background-failed", backgroundDiedLedgerSummary(t.title));
      }
    }
    const limit = deps.maxPerDrain ?? 3;
    const queued = listBackgroundTasks(root).filter(t => t.status === "queued").slice(0, limit);
    for (const task of queued) {
      const current = getBackgroundTask(root, task.id);
      if (!current || current.status !== "queued") continue;
      const running: BackgroundTask = { ...current, status: "running", startedAt: new Date().toISOString() };
      updateTaskRow(root, running);
      recordActivity(root, current.actor, "background-started", backgroundStartedLedgerSummary(current.title));
      try {
        const reply = await deps.runTurn(current.chatId, current.prompt);
        const done = getBackgroundTask(root, task.id);
        if (done) updateTaskRow(root, { ...done, status: "done", finishedAt: new Date().toISOString(), result: reply.slice(0, 300) });
        ran.push(task.id);
        recordActivity(root, current.actor, "background-done", backgroundDoneLedgerSummary(current.title));
      } catch (e) {
        const message = backgroundFailureReason(e);
        const bad = getBackgroundTask(root, task.id);
        if (bad) updateTaskRow(root, { ...bad, status: "failed", finishedAt: new Date().toISOString(), result: message.slice(0, 300) });
        failed.push(task.id);
        recordActivity(root, current.actor, "background-failed", backgroundFailedSummary(current.title, e));
        // The failure is posted into the chat too: silence in the thread the
        // owner is watching would read as the task still running.
        try { const db = new ChatStore(root); try { db.add(current.chatId, "assistant", "Background task failed: " + current.title + " (" + message.slice(0, 200) + ")"); } finally { db.close(); } } catch { /* chat gone; the ledger line stands */ }
      }
    }
    return { ran, failed, recovered };
  } finally { draining.delete(key); }
}

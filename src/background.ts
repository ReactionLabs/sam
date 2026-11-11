import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";

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
function openBackgroundStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = new Database(bgDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
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
  const db = openBackgroundStore(root);
  try {
    const rows = db.prepare("SELECT data FROM background_tasks ORDER BY rowid").all() as Array<{ data: string }>;
    const items: BackgroundTask[] = [];
    for (const row of rows) { const task = rowToTask(row.data); if (task) items.push(task); }
    return items;
  } finally { db.close(); }
}
export function getBackgroundTask(root: string, id: string): BackgroundTask | null {
  if (!existsSync(bgDbFile(root)) && !existsSync(bgFile(root))) return null;
  const db = openBackgroundStore(root);
  try {
    const row = db.prepare("SELECT data FROM background_tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToTask(row.data) : null;
  } finally { db.close(); }
}
function insertTask(root: string, item: BackgroundTask): void {
  const db = openBackgroundStore(root);
  try { db.prepare("INSERT INTO background_tasks (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  finally { db.close(); }
}
function updateTaskRow(root: string, item: BackgroundTask): void {
  const db = openBackgroundStore(root);
  try { db.prepare("UPDATE background_tasks SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
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
  recordActivity(root, input.actor, "background-queued", "Handed off background task: " + title);
  return item;
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
        recordActivity(root, t.actor, "background-failed", "Background task died mid-run: " + t.title);
      }
    }
    const limit = deps.maxPerDrain ?? 3;
    const queued = listBackgroundTasks(root).filter(t => t.status === "queued").slice(0, limit);
    for (const task of queued) {
      const current = getBackgroundTask(root, task.id);
      if (!current || current.status !== "queued") continue;
      const running: BackgroundTask = { ...current, status: "running", startedAt: new Date().toISOString() };
      updateTaskRow(root, running);
      recordActivity(root, current.actor, "background-started", "Background task started: " + current.title);
      try {
        const reply = await deps.runTurn(current.chatId, current.prompt);
        const done = getBackgroundTask(root, task.id);
        if (done) updateTaskRow(root, { ...done, status: "done", finishedAt: new Date().toISOString(), result: reply.slice(0, 300) });
        ran.push(task.id);
        recordActivity(root, current.actor, "background-done", "Background task finished in its chat: " + current.title);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Background run failed";
        const bad = getBackgroundTask(root, task.id);
        if (bad) updateTaskRow(root, { ...bad, status: "failed", finishedAt: new Date().toISOString(), result: message.slice(0, 300) });
        failed.push(task.id);
        recordActivity(root, current.actor, "background-failed", "Background task failed: " + current.title + " - " + message.slice(0, 120));
        // The failure is posted into the chat too: silence in the thread the
        // owner is watching would read as the task still running.
        try { const db = new ChatStore(root); try { db.add(current.chatId, "assistant", "Background task failed: " + current.title + " (" + message.slice(0, 200) + ")"); } finally { db.close(); } } catch { /* chat gone; the ledger line stands */ }
      }
    }
    return { ran, failed, recovered };
  } finally { draining.delete(key); }
}

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/**
 * Open loops (Smarter-and-Smoother S2 carry-in + the SECOND
 * ANSWERS record Dip ruled 2026-11-09 17:51: "SAM should be able
 * to sit there and reason and answer you and come back with
 * another answer later or update").
 *
 * A loop is one question whose answer may change: the question,
 * the answer given, what would change it, and when to look
 * again. Loops live per profile in .sam/loops.db (UNIFICATION
 * item 4, eighth store). This module is the record and the
 * carry-in: at a new session's first turn the open loops ride
 * into the prompt (see recall.ts), so the owner is greeted on
 * known ground instead of a cold start. The heartbeat revisit
 * engine that re-checks due loops and posts updates is the
 * SECOND ANSWERS build proper (loop-revisit.ts); it consumes
 * dueLoops() and delivers under the notification-worthiness
 * law (S5), which is why the engine follows S5 in the queue.
 */

export interface OpenLoop {
  id: string;
  profile: string;
  chatId: string | null;
  question: string;
  answer: string;
  watchFor: string;
  dueAt: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  lastCheckedAt?: string;
  // Revisit cadence in hours (SECOND ANSWERS): how far the next
  // look moves out after each check. Records written before the
  // revisit engine have no everyHours - loopIntervalHours derives
  // it from the first due window instead of stranding them.
  everyHours?: number;
  checks?: number;
  resolution?: string;
}

function loopsFile(root: string): string { return join(resolve(root), ".sam", "loops.json"); }
function loopsDbFile(root: string): string { return join(resolve(root), ".sam", "loops.db"); }
// State convergence (UNIFICATION item 4, eighth store): the
// open-loop store is SQLite (.sam/loops.db, the
// actions/jobs/background/coding/engine pattern), one row per
// loop holding the loop's full JSON, rowid order = the old file
// order. The old loops.json ({version, loops}) was rewritten
// whole on every open, close, reschedule, answer update, and
// chat adoption, and three processes write this store (the
// dashboard/chat process opens loops through sam_open_loop, the
// heartbeat tick's revisit drain mutates them, the CLI opens,
// closes, and revisits on demand), so two writers holding the
// same snapshot silently lost the second one's record: a loop
// opened from a chat could vanish under a tick's reschedule
// save, and a resolved loop's close could revert to open and be
// revisited (and re-posted) again. Here each mutation is a
// single-row INSERT or UPDATE, and connections carry a
// busy_timeout (the F1 cross-process lock seam) so a writer
// waits out a peer's transaction instead of dying on "database
// is locked". First open imports a legacy loops.json in file
// order and renames it loops.json.migrated - imported, never
// deleted; a malformed file imports nothing and is left in
// place (the old reader read a malformed file as empty, so the
// shape matches). A pure read on an install with neither file
// creates nothing - the old read path even created the .sam
// directory as a side effect; that is gone for reads, so
// read-only audits stay read-only. The P9 backup snapshots
// every .sam/*.db generically, so the migrated store is carried
// with no backup change.
function openLoopsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(loopsDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS open_loops (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyLoops(db, root);
  return db;
}
function migrateLegacyLoops(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM open_loops").get() as { n: number };
  if (n > 0) return;
  const file = loopsFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const rows: unknown = Array.isArray(data) ? data
    : (data && typeof data === "object" ? (data as { loops?: unknown }).loops : undefined);
  if (!Array.isArray(rows)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO open_loops (id, data) VALUES (?, ?)");
  const importAll = db.transaction((items: unknown[]) => {
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const loop = raw as Partial<OpenLoop>;
      if (typeof loop.id !== "string" || !loop.id) continue;
      insert.run(loop.id, JSON.stringify(loop));
    }
  });
  importAll(rows);
  renameSync(file, file + ".migrated");
}
function rowToLoop(data: string): OpenLoop | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as OpenLoop : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(loopsDbFile(root)) || existsSync(loopsFile(root));
}
export function listLoops(root: string, filter?: { profile?: string; status?: "open" | "closed" }): OpenLoop[] {
  if (!storeExists(root)) return [];
  const db = openLoopsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM open_loops ORDER BY rowid").all() as Array<{ data: string }>;
    const items: OpenLoop[] = [];
    for (const row of rows) { const loop = rowToLoop(row.data); if (loop) items.push(loop); }
    return items.filter(l =>
      (filter?.profile === undefined || l.profile === filter.profile) &&
      (filter?.status === undefined || l.status === filter.status));
  } finally { db.close(); }
}
export function getOpenLoop(root: string, id: string): OpenLoop | null {
  if (!storeExists(root)) return null;
  const db = openLoopsStore(root);
  try {
    const row = db.prepare("SELECT data FROM open_loops WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToLoop(row.data) : null;
  } finally { db.close(); }
}
function insertLoop(root: string, item: OpenLoop): void {
  const db = openLoopsStore(root);
  try { db.prepare("INSERT INTO open_loops (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item)); }
  finally { db.close(); }
}
function updateLoopRow(root: string, item: OpenLoop): void {
  const db = openLoopsStore(root);
  try { db.prepare("UPDATE open_loops SET data = ? WHERE id = ?").run(JSON.stringify(item), item.id); }
  finally { db.close(); }
}
// The store's update door (the updateBackgroundTask /
// updateCodingTask / updateEngineTask precedent): patch one loop
// by id through the store's own shape. Returns the updated loop,
// or null when no such loop exists - and a miss on an install
// with no store at all creates nothing.
export function updateOpenLoop(root: string, id: string, patch: Partial<OpenLoop>): OpenLoop | null {
  if (!storeExists(root)) return null;
  const current = getOpenLoop(root, id);
  if (!current) return null;
  const next: OpenLoop = { ...current, ...patch, id: current.id };
  updateLoopRow(root, next);
  return next;
}

export function openLoop(root: string, input: { profile: string; chatId?: string | null; question: string; answer?: string; watchFor: string; dueInHours?: number }): OpenLoop {
  const question = (input.question ?? "").trim();
  const watchFor = (input.watchFor ?? "").trim();
  if (!question) throw new Error("An open loop needs the question");
  if (!watchFor) throw new Error("An open loop needs what would change the answer (watchFor)");
  const hours = typeof input.dueInHours === "number" && Number.isFinite(input.dueInHours) && input.dueInHours > 0 ? input.dueInHours : 24;
  const now = new Date();
  const loop: OpenLoop = {
    id: randomUUID(),
    profile: input.profile,
    chatId: input.chatId ?? null,
    question,
    answer: (input.answer ?? "").trim(),
    watchFor,
    dueAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    status: "open",
    createdAt: now.toISOString(),
    everyHours: hours,
    checks: 0,
  };
  insertLoop(root, loop);
  return loop;
}

export function closeLoop(root: string, id: string, resolution?: string): OpenLoop | null {
  const loop = getOpenLoop(root, id);
  if (!loop || loop.status === "closed") return null;
  loop.status = "closed";
  loop.closedAt = new Date().toISOString();
  if (resolution !== undefined) loop.resolution = resolution.slice(0, 2000);
  updateLoopRow(root, loop);
  return loop;
}

// The revisit cadence: the stored everyHours when present, else
// the original due window (dueAt - createdAt) for records written
// before the engine existed, else the 24h openLoop default.
export function loopIntervalHours(loop: OpenLoop): number {
  if (typeof loop.everyHours === "number" && Number.isFinite(loop.everyHours) && loop.everyHours > 0) return loop.everyHours;
  const window = (Date.parse(loop.dueAt) - Date.parse(loop.createdAt)) / 3_600_000;
  if (Number.isFinite(window) && window > 0) return window;
  return 24;
}

function mutateLoop(root: string, id: string, fn: (loop: OpenLoop) => void): OpenLoop | null {
  const loop = getOpenLoop(root, id);
  if (!loop) return null;
  fn(loop);
  updateLoopRow(root, loop);
  return loop;
}

// One revisit happened: stamp the check, count it, and push the
// next look out by the loop's own interval. Used for unchanged
// verdicts and for failed re-checks alike - a loop that cannot be
// checked moves on instead of wedging every tick (the Phase C
// failure-isolation shape).
export function rescheduleLoop(root: string, id: string, now: Date = new Date()): OpenLoop | null {
  return mutateLoop(root, id, (loop) => {
    loop.lastCheckedAt = now.toISOString();
    loop.checks = (loop.checks ?? 0) + 1;
    loop.dueAt = new Date(now.getTime() + loopIntervalHours(loop) * 3_600_000).toISOString();
  });
}

// A changed verdict: the new answer becomes the recorded answer
// (the next comparison judges against IT, not the stale one),
// the check is stamped, and the loop stays open on its interval.
export function updateLoopAnswer(root: string, id: string, answer: string, now: Date = new Date()): OpenLoop | null {
  return mutateLoop(root, id, (loop) => {
    loop.answer = answer.trim().slice(0, 4000);
    loop.lastCheckedAt = now.toISOString();
    loop.checks = (loop.checks ?? 0) + 1;
    loop.dueAt = new Date(now.getTime() + loopIntervalHours(loop) * 3_600_000).toISOString();
  });
}

// A chatless loop adopts the revisit engine's check chat as its
// home chat on first revisit, so later updates have somewhere to
// land and the owner can open the thread.
export function adoptLoopChat(root: string, id: string, chatId: string): OpenLoop | null {
  return mutateLoop(root, id, (loop) => { if (!loop.chatId) loop.chatId = chatId; });
}

export function dueLoops(root: string, now: Date = new Date()): OpenLoop[] {
  return listLoops(root, { status: "open" }).filter(l => l.dueAt <= now.toISOString());
}

export function openLoopCount(root: string): number {
  return listLoops(root, { status: "open" }).length;
}

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Open loops (Smarter-and-Smoother S2 carry-in + the SECOND
 * ANSWERS record Dip ruled 2026-11-09 17:51: "SAM should be able
 * to sit there and reason and answer you and come back with
 * another answer later or update").
 *
 * A loop is one question whose answer may change: the question,
 * the answer given, what would change it, and when to look
 * again. Loops live per profile in .sam/loops.json. This module
 * is the record and the carry-in: at a new session's first turn
 * the open loops ride into the prompt (see recall.ts), so the
 * owner is greeted on known ground instead of a cold start.
 * The heartbeat revisit engine that re-checks due loops and
 * posts updates is the SECOND ANSWERS build proper (loop-revisit.ts);
 * it consumes dueLoops() and delivers under the notification-worthiness
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

interface LoopsFile { version: 1; loops: OpenLoop[] }

function loopsPath(root: string): string {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "loops.json");
}

function readLoops(root: string): LoopsFile {
  const path = loopsPath(root);
  if (!existsSync(path)) return { version: 1, loops: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LoopsFile;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.loops)) return { version: 1, loops: parsed.loops };
  } catch { /* corrupt state reads as empty, never fatal */ }
  return { version: 1, loops: [] };
}

function writeLoops(root: string, file: LoopsFile): void {
  const path = loopsPath(root);
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(temp, path);
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
  const file = readLoops(root);
  file.loops.push(loop);
  writeLoops(root, file);
  return loop;
}

export function listLoops(root: string, filter?: { profile?: string; status?: "open" | "closed" }): OpenLoop[] {
  return readLoops(root).loops.filter(l =>
    (filter?.profile === undefined || l.profile === filter.profile) &&
    (filter?.status === undefined || l.status === filter.status));
}

export function closeLoop(root: string, id: string, resolution?: string): OpenLoop | null {
  const file = readLoops(root);
  const loop = file.loops.find(l => l.id === id);
  if (!loop || loop.status === "closed") return null;
  loop.status = "closed";
  loop.closedAt = new Date().toISOString();
  if (resolution !== undefined) loop.resolution = resolution.slice(0, 2000);
  writeLoops(root, file);
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
  const file = readLoops(root);
  const loop = file.loops.find(l => l.id === id);
  if (!loop) return null;
  fn(loop);
  writeLoops(root, file);
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

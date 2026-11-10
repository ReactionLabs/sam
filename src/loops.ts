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
 * posts updates is the SECOND ANSWERS build proper; it consumes
 * dueLoops() and delivers under the notification-worthiness law
 * (S5), which is why the engine follows S5 in the queue.
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

export function closeLoop(root: string, id: string): OpenLoop | null {
  const file = readLoops(root);
  const loop = file.loops.find(l => l.id === id);
  if (!loop || loop.status === "closed") return null;
  loop.status = "closed";
  loop.closedAt = new Date().toISOString();
  writeLoops(root, file);
  return loop;
}

export function dueLoops(root: string, now: Date = new Date()): OpenLoop[] {
  return listLoops(root, { status: "open" }).filter(l => l.dueAt <= now.toISOString());
}

export function openLoopCount(root: string): number {
  return listLoops(root, { status: "open" }).length;
}

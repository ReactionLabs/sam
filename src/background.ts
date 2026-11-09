import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";

// Legs (program P5): background work. A chat can hand off a long task - the
// turn returns immediately with a task id, and the task runs later (drained by
// each heartbeat tick, or on demand by CLI) as a real chat turn in the SAME
// chat, on the deep "background" budget tier. The result lands in the chat as
// an ordinary exchange, so the owner reads it where they asked for it; the
// queue itself lives in .sam/background.json and every transition lands in the
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
export function listBackgroundTasks(root: string): BackgroundTask[] {
  const file = bgFile(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? data as BackgroundTask[] : []; }
  catch { return []; }
}
function saveTasks(root: string, items: BackgroundTask[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(bgFile(root), JSON.stringify(items, null, 2), { mode: 0o600 });
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
  items.push(item); saveTasks(root, items);
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
    const items = listBackgroundTasks(root);
    const now = Date.now(); let dirty = false;
    for (const t of items) {
      if (t.status === "running" && t.startedAt && now - Date.parse(t.startedAt) > STALE_RUNNING_MS) {
        t.status = "failed"; t.finishedAt = new Date().toISOString(); t.result = "Runner stopped mid-task; marked failed by the next drain.";
        recovered.push(t.id); dirty = true;
        recordActivity(root, t.actor, "background-failed", "Background task died mid-run: " + t.title);
      }
    }
    if (dirty) saveTasks(root, items);
    const limit = deps.maxPerDrain ?? 3;
    const queued = listBackgroundTasks(root).filter(t => t.status === "queued").slice(0, limit);
    for (const task of queued) {
      const live = listBackgroundTasks(root); const current = live.find(t => t.id === task.id);
      if (!current || current.status !== "queued") continue;
      current.status = "running"; current.startedAt = new Date().toISOString(); saveTasks(root, live);
      recordActivity(root, current.actor, "background-started", "Background task started: " + current.title);
      try {
        const reply = await deps.runTurn(current.chatId, current.prompt);
        const after = listBackgroundTasks(root); const done = after.find(t => t.id === task.id);
        if (done) { done.status = "done"; done.finishedAt = new Date().toISOString(); done.result = reply.slice(0, 300); saveTasks(root, after); }
        ran.push(task.id);
        recordActivity(root, current.actor, "background-done", "Background task finished in its chat: " + current.title);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Background run failed";
        const after = listBackgroundTasks(root); const bad = after.find(t => t.id === task.id);
        if (bad) { bad.status = "failed"; bad.finishedAt = new Date().toISOString(); bad.result = message.slice(0, 300); saveTasks(root, after); }
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

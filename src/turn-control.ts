import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { chatQueueTouch } from "./chat-queue-failure.js";
import { readActivity } from "./activity.js";

// Interactive turn control (Dip, 2026-11-14, after Test Chat
// 8d7f4341 burned dozens of model calls inside one turn while his
// "u seem stuck, are u?" waited behind it: "we need to be able to
// stop that"). Three mechanisms, one module:
//
// 1. A wall-clock deadline for interactive owner chat turns. Past
//    it the turn starts no new tool rounds and closes with a
//    status synthesis from the work already done. Long work
//    belongs in background handoffs and orchestration, never
//    occupying the chat the owner is looking at.
// 2. A per-request abort: the control's AbortSignal fires at the
//    deadline (and when a reset aborts it), and the provider
//    links every model request to it, so one hung provider call
//    cannot wedge a turn past either limit.
// 3. Reset invalidation: a reset bumps the chat's turn
//    generation and deletes its queue claim. Every turn carries
//    the generation (and, on the queue path, the claim token) it
//    started with and re-checks both at each round boundary and
//    before the final save - a late reply from a stopped turn is
//    discarded, never saved over the reset.
//
// The generation and claim reads live in the chat queue's store
// (chat-queue.db); this module reads them through its own handle
// so the queue, the turn, and the dashboard endpoint all agree
// without an import cycle.

/** Owner chat turns close out by this wall clock, however deep
 *  their tool budget runs. Simple questions answer in 1-2s; the
 *  recorded wedge was still drafting at 171s and died near 8
 *  minutes. Three minutes is far past any honest interactive
 *  answer and far short of a wedge. */
export const OWNER_TURN_DEADLINE_MS = 180_000;
/** One model request may hang at most this long before the
 *  provider aborts it. The turn deadline's signal can cut a
 *  request shorter; nothing stretches it past this. */
export const MODEL_REQUEST_TIMEOUT_MS = 60_000;

export class TurnInvalidatedError extends Error {
  constructor(chatId: string) {
    super("Turn stopped by reset in chat " + chatId.slice(0, 8));
    this.name = "TurnInvalidatedError";
  }
}

function dbFile(root: string): string { return join(resolve(root), ".sam", "chat-queue.db"); }
function openStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(dbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS queue_items (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS turn_claims (chat_id TEXT PRIMARY KEY, token TEXT NOT NULL, claimed_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0);" +
    "CREATE TABLE IF NOT EXISTS turn_state (chat_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, reset_at TEXT);");
  return db;
}

export function turnGeneration(root: string, chatId: string): number {
  return chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const row = db.prepare("SELECT generation FROM turn_state WHERE chat_id = ?").get(chatId) as { generation: number } | undefined;
      return row ? Number(row.generation) : 0;
    } finally { db.close(); }
  });
}

/** A reset stamps the chat: every turn that started under an
 *  earlier generation is invalid from this moment, wherever it
 *  runs. Returns the new generation. */
export function bumpTurnGeneration(root: string, chatId: string): number {
  return chatQueueTouch(root, "write", () => {
    const db = openStore(root);
    try {
      db.prepare("INSERT INTO turn_state (chat_id, generation, reset_at) VALUES (?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET generation = generation + 1, reset_at = excluded.reset_at")
        .run(chatId, new Date().toISOString());
      const row = db.prepare("SELECT generation FROM turn_state WHERE chat_id = ?").get(chatId) as { generation: number };
      return Number(row.generation);
    } finally { db.close(); }
  });
}

export function claimTokenFor(root: string, chatId: string): string | null {
  return chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const row = db.prepare("SELECT token FROM turn_claims WHERE chat_id = ?").get(chatId) as { token: string } | undefined;
      return row ? String(row.token) : null;
    } finally { db.close(); }
  });
}

// Per-process registry of in-flight turn abort controllers, by
// chat: the reset endpoint aborts the CURRENT request of the
// chat's running turn immediately instead of waiting for the
// next round boundary. Entries prune after 30 minutes (a chat
// turn's own deadline is 3 minutes; anything older is a leak,
// and generation checks still guard its save).
const REGISTRY_TTL_MS = 30 * 60 * 1000;
const abortRegistry = new Map<string, Map<AbortController, number>>();
function pruneRegistry(chatId: string): void {
  const set = abortRegistry.get(chatId);
  if (!set) return;
  const cutoff = Date.now() - REGISTRY_TTL_MS;
  for (const [controller, at] of set) if (at < cutoff) set.delete(controller);
  if (!set.size) abortRegistry.delete(chatId);
}
/** Abort every registered in-flight turn request for the chat.
 *  Returns how many controllers were aborted. */
export function abortChatTurnRequests(chatId: string): number {
  const set = abortRegistry.get(chatId);
  if (!set) return 0;
  let aborted = 0;
  for (const controller of set.keys()) { if (!controller.signal.aborted) { controller.abort(); aborted++; } }
  abortRegistry.delete(chatId);
  return aborted;
}

export interface TurnControl {
  chatId: string;
  startedAt: number;
  /** Absolute deadline, or null for machine routes (no deadline). */
  deadlineAt: number | null;
  /** Fires at the deadline, or when a reset aborts this chat's
   *  registered requests. The provider links requests to it. */
  signal: AbortSignal;
  deadlineExceeded(): boolean;
  /** True once a reset has invalidated this turn: the generation
   *  moved, or the queue claim this turn rode is gone/replaced. */
  invalidated(): boolean;
  remainingMs(): number;
}

export function createTurnControl(root: string, chatId: string, opts?: { claimToken?: string | null; deadlineMs?: number | null }): TurnControl {
  const startedAt = Date.now();
  const deadlineMs = opts?.deadlineMs === undefined ? OWNER_TURN_DEADLINE_MS : opts.deadlineMs;
  const deadlineAt = deadlineMs === null ? null : startedAt + deadlineMs;
  const generation = turnGeneration(root, chatId);
  const claimToken = opts?.claimToken ?? null;
  const controller = new AbortController();
  pruneRegistry(chatId);
  let set = abortRegistry.get(chatId);
  if (!set) { set = new Map(); abortRegistry.set(chatId, set); }
  set.set(controller, startedAt);
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (deadlineAt !== null) {
    timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - startedAt));
    if (typeof timer.unref === "function") timer.unref();
  }
  return {
    chatId, startedAt, deadlineAt, signal: controller.signal,
    deadlineExceeded() { return deadlineAt !== null && Date.now() >= deadlineAt; },
    invalidated() {
      if (turnGeneration(root, chatId) !== generation) return true;
      if (claimToken !== null && claimTokenFor(root, chatId) !== claimToken) return true;
      return false;
    },
    remainingMs() { return deadlineAt === null ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - Date.now()); },
  };
}

/** The system note a loop appends when the deadline closes the
 *  turn: the synthesis that follows is a status report for the
 *  owner, in the owner's own terms - not a failure, not an ask
 *  to continue, and never a dump of the turn's machinery (Dip,
 *  2026-11-15: the close-out bubble read as a tool ledger with a
 *  verification report stapled to it; the owner reads the
 *  answer, the activity record keeps the bookkeeping). */
export function deadlineCloseNote(): string {
  return "Time check: this turn has reached its interactive time limit and your tool access is now off. Close the turn NOW with a concise status answer in plain text, written for the owner in the owner's own terms: what they asked you to do, what is already done, what is not done yet, and the next step, in a few lines. Never name a tool, never list the steps you ran, and never mention budgets, rounds, or this note - the owner reads this answer, not your activity record. Do not call the answer incomplete and do not ask the owner to say continue - if the remaining work is long, say it belongs in a background handoff.";
}

/** The owner's ask, in their words, for the deterministic
 *  close: the last user message in the turn's prompt, with the
 *  provenance line SAM prepends stripped, whitespace collapsed,
 *  and the whole thing capped so the close stays short. Returns
 *  "" when the prompt carries no owner words. */
export function ownerAskForClose(messages: Array<{ role?: unknown; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    let text = m.content.replace(/^\[metadata source=[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > 180) {
      const cut = text.slice(0, 180);
      const at = cut.lastIndexOf(" ");
      text = (at > 80 ? cut.slice(0, at) : cut).trimEnd() + "…";
    }
    return text;
  }
  return "";
}

/** Whether a composed deadline close reads as a tool ledger
 *  instead of an owner summary: three or more distinct tool
 *  names in the text (SAM's own sam_* names, plus any executed
 *  connector tool the text names). One mention is a sentence;
 *  a run of names is the activity record wearing the reply's
 *  clothes, and the deterministic close replaces it. */
export function closeReadsAsToolLedger(text: string, executed: string[]): boolean {
  const named = new Set<string>();
  for (const m of text.matchAll(/\bsam_[a-z][a-z0-9_]*\b/g)) named.add(m[0]);
  for (const name of executed) if (name && text.includes(name)) named.add(name);
  return named.size >= 3;
}

/** The deterministic close when even the deadline synthesis
 *  cannot compose: a plain owner summary built from the ask
 *  itself - what Sam was asked to do, that the work stands
 *  unfinished, and the next step. Short, plain, no tool names:
 *  the per-tool record stays in the activity ledger
 *  (turnDeadlineLedgerSummary), never in the owner's bubble. */
export function turnDeadlineFallbackAnswer(ask: string): string {
  const trying = ask ? " You asked: \"" + ask + "\"" : "";
  return "I stopped that turn at its time limit." + trying + " I was still working on it when the limit hit, so count it as unfinished: nothing was deleted, and the details of what ran are on my activity record. Send the next message and I will pick up from there, or hand the long part to the background.";
}

export function turnDeadlineLedgerSummary(executed: string[], roundsUsed: number, deadlineMs: number): string {
  return "Interactive turn hit its " + Math.round(deadlineMs / 1000) + "s deadline after " + executed.length + " call(s) over " + roundsUsed + " round(s) (" + (executed.join(", ") || "none") + ") - no new tool rounds started; the turn closes with a status synthesis. Long work belongs in the background, not in the owner's open chat";
}

// The turn-deadline scorecard (2026-11-18, the measured-proof
// series): both chat loops ledger every turn the deadline
// closes as a "turn-deadline" line - the calls and rounds the
// turn had already spent when the wall clock cut it. But no
// daily surface ever counted the class, so a chat surface
// hitting its deadline regularly was invisible until the
// owner watched a turn stall for three minutes. This text
// folds the whole ledger's turn-deadline lines to counts
// only: the deadline-hit turns, and the calls and rounds
// summed from each line's own accounting. A line that does
// not match the fixed ledger shape still counts as a hit
// and contributes no calls or rounds. No stamp, no actor,
// no tool name, no deadline reading, and no verbatim summary
// enters the text, so a day no turn hits its deadline is
// byte-identical and P3-silent, and the first new
// deadline-hit turn is the news. A pure read: it creates
// nothing, spends no model call, and retries nothing - the
// ledger and the turn control are untouched, and moving or
// shortening the deadline stays the operator's act.
export function parseTurnDeadlineSummary(summary: string): { calls: number; rounds: number } | null {
  const m = /^Interactive turn hit its \d+s deadline after (\d+) call\(s\) over (\d+) round\(s\)/.exec(summary);
  return m ? { calls: Number(m[1]), rounds: Number(m[2]) } : null;
}
export function turnDeadlineScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "turn-deadline" });
  let calls = 0;
  let rounds = 0;
  for (const line of lines) {
    const parsed = parseTurnDeadlineSummary(line.summary);
    if (parsed) { calls += parsed.calls; rounds += parsed.rounds; }
  }
  const out: string[] = [];
  out.push("Turn deadlines: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Deadline-hit turns: " + String(lines.length));
  out.push("Calls before deadline: " + String(calls));
  out.push("Rounds before deadline: " + String(rounds));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a turn or prints a tool name or deadline; a new deadline-hit turn is the news");
  return out.join("\n");
}

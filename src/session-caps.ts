import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";
import { recordActivity } from "./activity.js";

/**
 * Cheap session caps (Harness Implementation Order item 3, Dip
 * 2026-11-09, from the harness study's turn/cost caps - SAM's budget
 * fix f862916 sits on this seam).
 *
 * A session is a chat: every route (chat, heartbeat, background)
 * enters through runChatTurn with a chatId, so the chat is the unit
 * that can run away - a hot heartbeat job re-entering its own chat,
 * a background chain posting back into itself, a door chat being
 * hammered. Each completed turn appends one line to
 * .sam/session-caps.jsonl with the tokens it actually spent
 * (accumulated from the provider's own usage reports, never
 * estimated). At a turn's entry, today's (UTC) turns and tokens for
 * that chat are summed; at the cap the turn closes gracefully with a
 * plain explanation and NO model call, and the first trip of the day
 * writes one ledger line. No stuck-detection machinery: the caps are
 * arithmetic, not judgment.
 *
 * Defaults are generous on purpose (100 turns, 2,000,000 tokens per
 * chat per day): a healthy 30-minute heartbeat makes 48 turns a day,
 * a heavy owner day far fewer. SAM_SESSION_MAX_TURNS /
 * SAM_SESSION_MAX_TOKENS override; 0 disables that cap. The token
 * cap is a between-turns ceiling by construction - a single turn can
 * overshoot it, bounded by the per-turn tool budgets; the turn cap
 * is the hard bound.
 */

export interface SessionCaps { maxTurns: number; maxTokens: number }

function parseCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return n;
}

export function sessionCaps(env: NodeJS.ProcessEnv = process.env): SessionCaps {
  return {
    maxTurns: parseCap(env.SAM_SESSION_MAX_TURNS, 100),
    maxTokens: parseCap(env.SAM_SESSION_MAX_TOKENS, 2_000_000),
  };
}

interface TurnEvent { type: "turn"; at: string; chatId: string; route: TurnRoute; tokens: number }
interface CapEvent { type: "cap"; at: string; chatId: string; route: TurnRoute; reason: "turns" | "tokens" }
type CapsEvent = TurnEvent | CapEvent;

function ledgerPath(root: string): string {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "session-caps.jsonl");
}

// The read seam follows the house contract fail-closed (gap
// found 2026-11-13, hourly run 18:04): this ledger is a spend
// BOUND, not a work record - a dead read folded to [] would
// read as "no turns, no tokens spent today", the gate would
// never trip, and a runaway chat would spend unbounded while
// every surface reported zero usage as truth. So a failed read
// ledgers ONE session-caps-failed line (what named "ledger
// read", the chat named when the reader knows it) and rethrows
// exactly: sessionCapStatus keeps failing the turn closed -
// never an unbounded spend on a dead gate - now with the true
// cause countable under its own kind instead of a raw
// filesystem error dressed as a generic turn failure, and
// sessionUsageToday's status readers surface the error instead
// of a false zero. The error is tagged so a caller whose own
// catch ledgers (noteCapTrip) can tell a read failure - already
// ledgered here, under the seam that actually died - from a
// failure of its own write, and never records it twice.
function readEvents(root: string, chatId = ""): CapsEvent[] {
  let raw: string | null;
  try {
    const path = ledgerPath(root);
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    recordSessionCapsFailure(root, "ledger read", chatId, error);
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      (error as { sessionCapsReadLedgered?: boolean }).sessionCapsReadLedgered = true;
    }
    throw error;
  }
  if (raw === null) return [];
  const events: CapsEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CapsEvent;
      if (parsed && (parsed.type === "turn" || parsed.type === "cap") && typeof parsed.at === "string" && typeof parsed.chatId === "string") events.push(parsed);
    } catch { /* torn line ignored */ }
  }
  return events;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

// One ledger line per failed caps-ledger touch (gap found
// 2026-11-13): this ledger is accounting, and accounting never
// breaks a turn - recordSessionTurn runs at the very end of a
// completed turn (and on the error path, right before the real
// error rethrows, where an accounting throw would mask it), and
// noteCapTrip runs inside the graceful cap reply itself. Each
// failed write ledgers one session-caps-failed activity line
// (which write, the chat prefix, the verbatim reason capped)
// and the caller proceeds exactly as if the write had landed.
// A failed READ is the one touch that does not proceed: it
// ledgers the same one line (what named "ledger read" - see
// readEvents above for why the gate fails closed) and rethrows.
// The chat segment is omitted when the reader has no single
// chat (sessionUsageToday reads for every chat at once); write
// summaries, which always carry a chat, are unchanged.
export function sessionCapsFailureSummary(what: string, chatId: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  const chat = chatId ? " for chat " + chatId.slice(0, 8) : "";
  return ("Session caps " + what + " failed" + chat + ": " + clean).slice(0, 200);
}

export function recordSessionCapsFailure(root: string, what: string, chatId: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "session-caps-failed", sessionCapsFailureSummary(what, chatId, reason));
}

export function recordSessionTurn(root: string, turn: { chatId: string; route: TurnRoute; tokens: number; at?: string }): void {
  const event: TurnEvent = { type: "turn", at: turn.at ?? new Date().toISOString(), chatId: turn.chatId, route: turn.route, tokens: Math.max(0, Math.floor(turn.tokens) || 0) };
  try {
    appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  } catch (error) {
    recordSessionCapsFailure(root, "turn record", turn.chatId, error);
  }
}

export interface SessionCapStatus {
  capped: boolean;
  reason: "turns" | "tokens" | null;
  turnsUsed: number;
  tokensUsed: number;
  caps: SessionCaps;
  day: string;
}

export function sessionCapStatus(root: string, chatId: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): SessionCapStatus {
  const caps = sessionCaps(env);
  const day = dayOf(now.toISOString());
  let turnsUsed = 0;
  let tokensUsed = 0;
  for (const event of readEvents(root, chatId)) {
    if (event.type !== "turn" || event.chatId !== chatId || dayOf(event.at) !== day) continue;
    turnsUsed++;
    tokensUsed += event.tokens;
  }
  const turnsHit = caps.maxTurns > 0 && turnsUsed >= caps.maxTurns;
  const tokensHit = caps.maxTokens > 0 && tokensUsed >= caps.maxTokens;
  return { capped: turnsHit || tokensHit, reason: turnsHit ? "turns" : tokensHit ? "tokens" : null, turnsUsed, tokensUsed, caps, day };
}

/** Record a cap trip for this chat today; returns true only for the
 *  first trip of the day, so the activity ledger gets one line per
 *  capped session per day instead of one per refused tick. */
export function noteCapTrip(root: string, chatId: string, route: TurnRoute, reason: "turns" | "tokens", now: Date = new Date()): boolean {
  try {
    const day = dayOf(now.toISOString());
    const already = readEvents(root, chatId).some(e => e.type === "cap" && e.chatId === chatId && dayOf(e.at) === day);
    if (already) return false;
    const event: CapEvent = { type: "cap", at: now.toISOString(), chatId, route, reason };
    appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch (error) {
    // A trip that could not be recorded reads as not-noted: the
    // caller's own session-cap line does not ride it, the failure
    // line above stands instead, and the graceful cap reply the
    // caller is holding still returns. A READ failure arrives
    // already ledgered by readEvents under the seam that died
    // (and tagged) - recording it again here would count one
    // touch twice and mislabel it as this write, so it stands
    // on the read seam's line alone.
    if (!(error !== null && typeof error === "object" && (error as { sessionCapsReadLedgered?: boolean }).sessionCapsReadLedgered)) {
      recordSessionCapsFailure(root, "cap trip", chatId, error);
    }
    return false;
  }
}

export function sessionCapReply(status: SessionCapStatus): string {
  return "This chat has reached today's session cap (" + status.turnsUsed + " turns and " + status.tokensUsed + " tokens used; the caps are " + status.caps.maxTurns + " turns and " + status.caps.maxTokens + " tokens per chat per day), so I am pausing here instead of spending more. The cap resets at the start of the next UTC day, and it can be raised or turned off with the SAM_SESSION_MAX_TURNS and SAM_SESSION_MAX_TOKENS settings.";
}

export function sessionUsageToday(root: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Array<{ chatId: string; turns: number; tokens: number; capped: boolean; reason: "turns" | "tokens" | null }> {
  const caps = sessionCaps(env);
  const day = dayOf(now.toISOString());
  const byChat = new Map<string, { turns: number; tokens: number }>();
  for (const event of readEvents(root)) {
    if (event.type !== "turn" || dayOf(event.at) !== day) continue;
    const entry = byChat.get(event.chatId) ?? { turns: 0, tokens: 0 };
    entry.turns++;
    entry.tokens += event.tokens;
    byChat.set(event.chatId, entry);
  }
  return [...byChat.entries()].map(([chatId, usage]) => {
    const turnsHit = caps.maxTurns > 0 && usage.turns >= caps.maxTurns;
    const tokensHit = caps.maxTokens > 0 && usage.tokens >= caps.maxTokens;
    return { chatId, turns: usage.turns, tokens: usage.tokens, capped: turnsHit || tokensHit, reason: (turnsHit ? "turns" : tokensHit ? "tokens" : null) as "turns" | "tokens" | null };
  }).sort((a, b) => b.tokens - a.tokens);
}

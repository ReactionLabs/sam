import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TurnRoute } from "./budgets.js";

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

function readEvents(root: string): CapsEvent[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  const events: CapsEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CapsEvent;
      if (parsed && (parsed.type === "turn" || parsed.type === "cap") && typeof parsed.at === "string" && typeof parsed.chatId === "string") events.push(parsed);
    } catch { /* torn line ignored */ }
  }
  return events;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

export function recordSessionTurn(root: string, turn: { chatId: string; route: TurnRoute; tokens: number; at?: string }): void {
  const event: TurnEvent = { type: "turn", at: turn.at ?? new Date().toISOString(), chatId: turn.chatId, route: turn.route, tokens: Math.max(0, Math.floor(turn.tokens) || 0) };
  appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
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
  for (const event of readEvents(root)) {
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
  const day = dayOf(now.toISOString());
  const already = readEvents(root).some(e => e.type === "cap" && e.chatId === chatId && dayOf(e.at) === day);
  if (already) return false;
  const event: CapEvent = { type: "cap", at: now.toISOString(), chatId, route, reason };
  appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  return true;
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

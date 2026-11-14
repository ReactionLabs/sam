import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";

/**
 * Rate-limit grace (Dip via main, 2026-11-12 ~20:25 EST).
 *
 * Pain: when Dip's MiniMax tokens maxed out, the Telegram bot
 * answered with a raw platform failure ("Something went wrong...
 * All models are temporarily rate-limited"). The fix, specced by
 * Dip: when the provider returns a rate-limit or quota-exhausted
 * response on SAM's chat path, SAM answers ONCE with one plain
 * message in its own voice - no raw error text, no error codes,
 * no platform language - and stays silent on further capped
 * messages until the cap resets.
 *
 * - CLASSIFY AT THE MODEL-CALL BOUNDARY: agent-turn's route loop
 *   is where every chat-path provider failure lands (the provider
 *   layer strips response bodies, so the durable signals are the
 *   HTTP 429 in its three shapes - "Model request failed",
 *   "Model connector request failed", "Model tool request
 *   failed" - plus rate-limit / too-many-requests / quota
 *   wording). Only that class takes this path: auth, billing
 *   without quota wording, timeout, network, empty, and unsafe
 *   errors keep their current handling exactly.
 * - ONE EPISODE, ACCOUNT-WIDE: the cap belongs to the provider
 *   account, not to a chat, so the episode is a single global
 *   record (.sam/rate-limit.db, the singleton pattern - ONE row
 *   holding {since, chatId}). The first capped failure opens it
 *   and speaks; capped failures while it is open stay silent;
 *   the first successful model call closes it, so the next
 *   capped failure speaks again. A pure read creates nothing.
 * - STORAGE IS UNCHANGED: a message received while capped was
 *   already stored by the turn before the model call, exactly
 *   as before; silence means no assistant row is written for
 *   it, and delivering surfaces (Telegram bridge, web door)
 *   send nothing for an empty reply.
 */

export const RATE_LIMIT_GRACE_MESSAGE =
  "Heads up, I am out of tokens right now, so I cannot think straight until the cap resets. Anything you send is saved, and I will pick it back up when I am back.";

// The one classifier for the chat path. Deliberately narrow:
// a 402 billing error with no quota wording is NOT this class
// (it keeps surfacing as the failure it is), and neither is a
// generic failure that merely mentions tokens in passing.
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /HTTP 429\b/.test(message) ||
    /rate.?limit/i.test(message) ||
    /too many requests/i.test(message) ||
    /insufficient_quota/i.test(message) ||
    /quota[^.]{0,40}(exceed|exhaust|reach|limit)/i.test(message) ||
    /(exceed|exhaust|reach)[^.]{0,40}quota/i.test(message) ||
    /out of tokens/i.test(message)
  );
}

export interface RateLimitEpisode { since: string; chatId: string | null }

function episodeDbFile(root: string): string {
  return join(resolve(root), ".sam", "rate-limit.db");
}

function openEpisodeStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(episodeDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS rate_limit_episode (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  return db;
}

function parseEpisode(data: string): RateLimitEpisode | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as { since?: unknown; chatId?: unknown };
    if (typeof raw.since !== "string" || !raw.since) return null;
    return { since: raw.since, chatId: typeof raw.chatId === "string" ? raw.chatId : null };
  } catch { return null; }
}

function readEpisodeRow(db: Database.Database): RateLimitEpisode | null {
  const row = db.prepare("SELECT data FROM rate_limit_episode WHERE id = 1").get() as { data: string } | undefined;
  return row ? parseEpisode(row.data) : null;
}

// Rate-limit episode failure visibility (hourly run
// 2026-11-14): the episode store was touched at exactly three
// places, all silent. agent-turn's open catch set opened=true
// on ANY throw, so a dead store made EVERY capped turn speak
// the grace message - the once-only contract inverted,
// indistinguishable from a working store. Its close catch
// swallowed any throw, so a failed close left the episode
// state unknown while SAM kept answering (and a surviving
// row silenced the next cap forever). And the direct reader
// (status rides rateLimitStatus bare) threw raw out of
// rateLimitEpisode, killing the whole status payload. Now
// each exported touch owns its failure: a failed open / read
// / close ledgers ONE rate-limit-failed line (phase, the
// chat prefix when the touch knows it, the verbatim reason
// collapsed and capped, never any episode content) and
// rethrows exactly, tagged (the session-caps / bindings
// precedent) so a catching caller records nothing more for
// the same touch. agent-turn keeps its exact fallbacks -
// an open failure still speaks once-ish rather than raw,
// a close failure still never breaks a successful turn -
// now countable instead of silent. An absent store still
// reads null / closes false with no line and creates
// nothing, and a pure read still creates nothing.
export type RateLimitPhase = "read" | "open" | "close";

export function rateLimitFailureSummary(phase: RateLimitPhase, reason: string, chatId?: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  const chat = chatId ? " for chat " + chatId.slice(0, 8) : "";
  return ("Rate limit " + phase + " failed" + chat + ": " + clean).slice(0, 200);
}

export function recordRateLimitFailure(root: string, phase: RateLimitPhase, error: unknown, chatId?: string): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "rate-limit-failed", rateLimitFailureSummary(phase, reason, chatId));
}

function tagRateLimitLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { rateLimitLedgered?: boolean }).rateLimitLedgered = true;
  }
}

export function isRateLimitLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { rateLimitLedgered?: boolean }).rateLimitLedgered === true;
}

function failRateLimit(root: string, phase: RateLimitPhase, error: unknown, chatId?: string): never {
  if (!isRateLimitLedgered(error)) recordRateLimitFailure(root, phase, error, chatId);
  tagRateLimitLedgered(error);
  throw error;
}

/** The open episode, or null - and a read on an install with no
 *  store at all creates nothing. A failed read ledgers one
 *  rate-limit-failed line and rethrows exactly (fail-closed
 *  for direct readers such as status). */
export function rateLimitEpisode(root: string): RateLimitEpisode | null {
  if (!existsSync(episodeDbFile(root))) return null;
  let db: Database.Database;
  try {
    db = openEpisodeStore(root);
  } catch (error) { failRateLimit(root, "read", error); }
  try { return readEpisodeRow(db!); } catch (error) { failRateLimit(root, "read", error); }
  finally { db!.close(); }
}

export function rateLimitStatus(root: string): { open: boolean; since: string | null } {
  const episode = rateLimitEpisode(root);
  return { open: episode !== null, since: episode?.since ?? null };
}

/** Open the episode if none is open. Returns true only for the
 *  call that opened it - that caller speaks the grace message;
 *  every later caller, while it stays open, stays silent. A
 *  failed open ledgers one rate-limit-failed line and
 *  rethrows exactly; agent-turn's catch keeps its speak
 *  once-ish fallback, now countable. */
export function openRateLimitEpisode(root: string, chatId?: string): boolean {
  let db: Database.Database;
  try {
    db = openEpisodeStore(root);
  } catch (error) { failRateLimit(root, "open", error, chatId); }
  try {
    if (readEpisodeRow(db!)) return false;
    const episode: RateLimitEpisode = { since: new Date().toISOString(), chatId: chatId ?? null };
    db!.prepare("INSERT OR IGNORE INTO rate_limit_episode (id, data) VALUES (1, ?)").run(JSON.stringify(episode));
    return readEpisodeRow(db!)?.since === episode.since;
  } catch (error) { failRateLimit(root, "open", error, chatId); }
  finally { db!.close(); }
}

/** Close the episode on the first successful model call.
 *  Returns true when an episode was open and is now closed.
 *  A failed close ledgers one rate-limit-failed line and
 *  rethrows exactly; agent-turn's catch keeps its
 *  never-break-a-turn fallback, now countable. */
export function closeRateLimitEpisode(root: string): boolean {
  if (!existsSync(episodeDbFile(root))) return false;
  let db: Database.Database;
  try {
    db = openEpisodeStore(root);
  } catch (error) { failRateLimit(root, "close", error); }
  try {
    const info = db!.prepare("DELETE FROM rate_limit_episode WHERE id = 1").run();
    return info.changes > 0;
  } catch (error) { failRateLimit(root, "close", error); }
  finally { db!.close(); }
}

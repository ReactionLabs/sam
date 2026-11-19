import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity, readActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Skill-use ledger (Dip, 2026-11-10: "we need to be able to see what
// skills it's using while it's using it"). One JSON line per
// sam_read_skill the MODEL makes - a model reading a skill IS SAM
// using it. Written only from the own-tool dispatch, never from the
// operator CLI read, so the ledger answers "which skills is SAM
// actually riding, in which chats" rather than "what did the
// operator peek at". Append-only like the other ledgers; readers
// fold it. A corrupt line is skipped, never fatal. Recording is
// best-effort: visibility never breaks the skill read it records,
// and a failed write ledgers one skill-use-failed activity line
// instead of vanishing (the readers keep folding the frozen ledger
// as truth, so the failure line is the only signal it has stopped
// moving). Reading is the opposite discipline: a failed read
// ledgers the same one line and rethrows, because a summary folded
// from an unreadable ledger would report no skill use as truth
// (see skillUseEntries).
export interface SkillUse { at: string; actor: string; chatId: string | null; skill: string }

function ledgerFile(root: string): string { return join(resolve(root), ".sam", "skill-use.jsonl"); }

// One ledger line per failed skill-use write (gap found 2026-11-13):
// the verbatim reason (collapsed, capped), the skill, and the chat
// prefix when present - never any skill content.
export function skillUseFailureSummary(skill: string, chatId: string | null, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Skill use record failed for skill " + skill + (chatId ? " in chat " + chatId.slice(0, 8) : "") + ": " + clean).slice(0, 200);
}

/**
 * The reason a skill-use-failed line carries (census sprint
 * 2026-11-17): recordSkillUseFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function skillUseFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordSkillUseFailure(root: string, actor: string, skill: string, chatId: string | null, error: unknown): void {
  const reason = skillUseFailureReason(error);
  recordActivity(root, actor, "skill-use-failed", skillUseFailureSummary(skill, chatId, reason));
}

// One ledger line per failed skill-use READ (gap found
// 2026-11-14): the read seam was the one silent touch left in
// this ledger - skillUseEntries read bare, so a dead ledger
// threw raw out of buildStatusPayload (which calls it twice
// per build), the TUI chat header, and the CLI used view, with
// no line anywhere and the class uncountable. The reader is
// the system, so the line carries actor "sam" (the usage read
// precedent) and no skill name; skill content never enters it.
export function skillUseReadFailureSummary(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Skill use read failed: " + clean).slice(0, 200);
}

/**
 * The reason a skill-use-failed line carries (census sprint
 * 2026-11-17): recordSkillUseReadFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function skillUseReadFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordSkillUseReadFailure(root: string, error: unknown): void {
  const reason = skillUseReadFailureReason(error);
  recordActivity(root, "sam", "skill-use-failed", skillUseReadFailureSummary(reason));
}

export function recordSkillUse(root: string, entry: { actor: string; chatId?: string | null; skill: string }): boolean {
  const line: SkillUse = { at: new Date().toISOString(), actor: entry.actor, chatId: entry.chatId ?? null, skill: entry.skill };
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    appendFileSync(ledgerFile(root), JSON.stringify(line) + "\n");
    return true;
  } catch (error) {
    recordSkillUseFailure(root, entry.actor, entry.skill, line.chatId, error);
    return false;
  }
}

export function skillUseEntries(root: string): SkillUse[] {
  // The read seam follows the house contract fail-closed (gap
  // found 2026-11-14): this ledger is folded as truth by the
  // dashboard rail, the chat header, and status, and a dead
  // read folded to [] reads as "SAM has used no skills" - the
  // frozen-truth lie - while a raw throw kills the whole
  // status payload with no trace. So a failed filesystem
  // touch ledgers ONE skill-use-failed line (the read
  // recorder above) and rethrows exactly. An absent ledger
  // still reads [] (a fresh install has genuinely used no
  // skills) and per-line torn parsing stays forgiving; only
  // the filesystem touch is guarded.
  const file = ledgerFile(root);
  let raw: string | null;
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch (error) {
    recordSkillUseReadFailure(root, error);
    throw error;
  }
  if (raw === null) return [];
  const out: SkillUse[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as SkillUse;
      if (typeof v?.skill === "string" && typeof v?.at === "string") out.push({ at: v.at, actor: String(v.actor ?? ""), chatId: typeof v.chatId === "string" ? v.chatId : null, skill: v.skill });
    } catch { /* a torn line is skipped, never fatal */ }
  }
  return out;
}

export function recentSkillUse(root: string, limit = 10): SkillUse[] {
  const capped = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 10;
  return skillUseEntries(root).slice(-capped).reverse();
}

/** The most recent skill each chat rode, for the dashboard rail and
 *  the chat header: chatId -> { skill, at }. */
export function lastSkillByChat(root: string): Map<string, { skill: string; at: string }> {
  const map = new Map<string, { skill: string; at: string }>();
  for (const entry of skillUseEntries(root)) {
    if (entry.chatId) map.set(entry.chatId, { skill: entry.skill, at: entry.at });
  }
  return map;
}

// The ONE writer for a skill use's activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. The shape is byte-identical to what the own-tool
// dispatch wrote inline before this writer existed: the
// skill the model read, and the chat prefix when the turn
// carries one.
export function skillUseLedgerSummary(skill: string, chatId: string | null): string {
  return "Used skill " + skill + (chatId ? " in chat " + chatId.slice(0, 8) : "");
}

// The skill-use scorecard (2026-11-18, the measured-proof
// series): every sam_read_skill the model makes ledgers one
// "skill-use" activity line carrying the skill's name and
// the chat prefix - but no daily surface ever counted the
// uses, so skill auto-selection going silent, a one-skill
// habit, or a first use of a newly installed skill was
// invisible in aggregate. (The curator's usage pass reads
// the separate skill-use.jsonl ledger for staleness; this
// folds the activity class.) The text folds counts only:
// the total uses, the distinct-skill count and the
// distinct-chat count as NUMBERS only, and the no-chat use
// count parsed from the fixed summaries. A summary matching
// no fixed shape counts as a use and contributes no skill
// or chat count, and no stamp, actor, skill name, chat id,
// or verbatim summary is ever printed - a skill name is a
// library identifier and a chat prefix identifies a
// conversation, and neither belongs in a trending surface.
// The verdict is attention when any line is unparseable,
// else clear. No stamp and no actor enters the text, so a
// quiet day is byte-identical and P3-silent, and a malformed
// line or a mix shift is the news. A pure read: it creates
// nothing, spends no model call, and reads no skill - the
// ledger and the use seam are untouched, and recording a
// use stays recordSkillUse's job.
export function parseSkillUseSummary(summary: string): { skill: string; chat: string | null } | null {
  const m = /^Used skill (\S+)(?: in chat (\S+))?$/.exec(summary);
  if (!m) return null;
  return { skill: m[1], chat: m[2] ?? null };
}
export function skillUseScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "skill-use" });
  const skills = new Set<string>();
  const chats = new Set<string>();
  let noChat = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseSkillUseSummary(line.summary);
    if (!parsed) {
      unparseable += 1;
      continue;
    }
    skills.add(parsed.skill);
    if (parsed.chat) chats.add(parsed.chat); else noChat += 1;
  }
  const out: string[] = [];
  out.push("Skill uses: " + (unparseable > 0 ? "attention" : "clear"));
  out.push("Uses: " + String(lines.length));
  out.push("Distinct skills: " + String(skills.size));
  out.push("Distinct chats: " + String(chats.size));
  out.push("Uses with no chat: " + String(noChat));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never reads a skill, never prints a skill name or a chat id; a malformed line, a mix shift, or auto-selection going silent is the news");
  return out.join("\n");
}

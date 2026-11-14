import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity } from "./activity.js";

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

export function recordSkillUseFailure(root: string, actor: string, skill: string, chatId: string | null, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
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

export function recordSkillUseReadFailure(root: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
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

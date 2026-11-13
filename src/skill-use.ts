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
// best-effort: visibility never breaks the read, and a failed write
// ledgers one skill-use-failed activity line instead of vanishing
// (the readers keep folding the frozen ledger as truth, so the
// failure line is the only signal it has stopped moving).
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
  const file = ledgerFile(root);
  if (!existsSync(file)) return [];
  const out: SkillUse[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
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

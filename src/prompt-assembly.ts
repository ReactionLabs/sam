import { withMessageProvenance } from "./message-provenance.js";

/**
 * Prompt assembly for one chat turn (defect fix, hourly run
 * 2026-11-12 15:04 EST): a stored message enters the prompt
 * AT MOST ONCE, keyed by its message id.
 *
 * The defect: agent-turn stores the person's message first,
 * re-reads the history (which now ends with that same
 * message), and the kept tail from compaction therefore
 * already carries it - then the assembly appended the same
 * message AGAIN as the final user turn, both copies carrying
 * the "[metadata source=telegram]" provenance line. SAM
 * quite reasonably reported the owner's messages as "coming
 * in twice" and blamed Telegram delivery; the store held
 * each message exactly once and the doubling lived here.
 *
 * The rule, per the roadmap's fix shape: dedupe by message
 * id across the history tail and the appended turn, first
 * occurrence wins - the HISTORY copy of the current message
 * is the one the model sees, and the turn appends its final
 * user message only when that message is not already in the
 * kept tail (a compaction safety slice can drop it, and then
 * it must still arrive, exactly once). Messages without an
 * id (legacy shapes in tests and callers) are never deduped
 * against each other. The resuming-partial instruction is a
 * synthetic continuation, not a copy of any stored message,
 * so it always appends.
 */

export interface HistoryPromptMessage {
  id?: string | null;
  role: "user" | "assistant";
  content: string;
  source?: string;
}

export interface AssembledPromptMessage {
  role: "user" | "assistant";
  content: string;
}

export const RESUME_PARTIAL_INSTRUCTION =
  "Continue the partial assistant reply above from where it stopped. Do not repeat the text already saved.";

/** First occurrence wins: later entries carrying an id that
 *  was already seen are dropped. Id-less entries always pass. */
export function dedupeMessageIds<T extends { id?: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (item.id) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    out.push(item);
  }
  return out;
}

/** How many entries repeat an id an earlier entry already
 *  carried - the context audit's duplicate counter. */
export function duplicateMessageIdCount(items: Array<{ id?: string | null }>): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) duplicates++;
    else seen.add(item.id);
  }
  return duplicates;
}

/** Assemble the conversation part of one turn's prompt: the
 *  deduped kept history (user entries carrying their stored
 *  provenance) plus, only when needed, the current message. */
export function assembleTurnMessages(opts: {
  kept: HistoryPromptMessage[];
  currentId: string | null;
  currentContent: string;
  currentSource?: unknown;
  resuming: boolean;
}): AssembledPromptMessage[] {
  const kept = dedupeMessageIds(opts.kept);
  const messages: AssembledPromptMessage[] = kept.map(m => ({
    role: m.role,
    content: m.role === "user" ? withMessageProvenance(m.content, m.source) : m.content,
  }));
  if (opts.resuming) {
    messages.push({ role: "user", content: RESUME_PARTIAL_INSTRUCTION });
    return messages;
  }
  if (opts.currentId && kept.some(m => m.id === opts.currentId)) return messages;
  messages.push({ role: "user", content: withMessageProvenance(opts.currentContent, opts.currentSource) });
  return messages;
}

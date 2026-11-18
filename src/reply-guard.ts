import { readActivity } from "./activity.js";

// Reply guard (Dip catch, 2026-11-14 ~19:39Z): SAM put its raw
// internal planning into the chat as a SAM bubble - a first-person
// monologue about loading sam_artifact / sam_manage_chats for a
// "can you make a PDF of something in your artifacts?" ask, ending
// mid-sentence ("Also the question"). The same shape is in the
// Test Chat transcript (2026-11-14T19:06:53Z: "No orchestration
// file in code root? Let's search for orchestrate tool
// implementation."). stripModelMarkup (a4ce832) catches TAGGED
// markup leaks; this leak is UNTAGGED prose reasoning, a different
// shape: the model narrates its process instead of answering, and
// the loops' content-with-no-calls path saves the narration as
// the reply.
//
// The standard (Dip): the reply must read as an answer to the
// owner, not as narration of the model's process. "Let me check"
// style phrasing as the substance of a reply is not acceptable
// either. When in doubt the guard prefers the retry/failure path
// over showing monologue.
//
// The detector is deterministic and deliberately scored, not a
// single keyword: ordinary answers that mention a tool or report
// completed work in prose survive (a lone signal never blocks);
// narration is several signals at once - a process-verb phrase
// ("let's search", "I need to load"), internal tool names in
// prose, machinery references ("code root", "tool
// implementation"), meta-narration about the ask itself, and a
// fragment ending. Longer texts need one more signal than short
// ones, so a substantive answer that happens to open with a
// process phrase is not condemned for its first line alone.

export interface ReasoningSignal { name: string; weight: number }

const SIGNAL_RULES: Array<{ name: string; weight: number; re: RegExp }> = [
  { name: "process-verb", weight: 2, re: /\b(let me|let's|i need to|i should|i'll|i will|i am going to|i'm going to)\s+(check|search|look|load|use|find|read|fetch|run|call|start|see|pull|open|write|draft)\b/i },
  { name: "meta-ask", weight: 2, re: /\b(the user|the owner)\s+(is\s+)?(asking|asked|wants|wanted)\b|\balso,?\s+the\s+question\b/i },
  { name: "tool-names", weight: 1, re: /\bsam_[a-z][a-z_]*\b/ },
  { name: "machinery", weight: 1, re: /\b(code root|tool implementation|system prompt|tool calls?|orchestration file)\b/i },
  { name: "loading-gerund", weight: 1, re: /\bloading\s+(the\s+|a\s+)?(sam_[a-z_]+|tools?)\b/i },
];

/** The named signals a text carries, with the fragment-ending
 *  signal computed from its shape. */
export function reasoningNarrationSignals(text: string): ReasoningSignal[] {
  const found: ReasoningSignal[] = [];
  for (const rule of SIGNAL_RULES) if (rule.re.test(text)) found.push({ name: rule.name, weight: rule.weight });
  const trimmed = text.trim();
  if (trimmed && !/[.!?…]["')\]]*$/.test(trimmed)) found.push({ name: "fragment-ending", weight: 1 });
  return found;
}

/** True when the text reads as the model's process narration
 *  rather than an answer. Short texts block at 3 points of
 *  signal; longer, potentially substantive texts need 4. */
export function isReasoningNarration(text: string): boolean {
  if (!text || !text.trim()) return false;
  const score = reasoningNarrationSignals(text).reduce((n, s) => n + s.weight, 0);
  return score >= (text.trim().length > 600 ? 4 : 3);
}

/** The loop's one steering note after a blocked reply: answer
 *  the owner, do not narrate the work. */
export function answerDirectlyNote(): string {
  return "Your last reply narrated your own process (loading, searching, what you are about to do) instead of answering. That text was withheld. Answer the owner directly now, in plain final form, from what you already have: state the answer or the result, not your next step. If you cannot answer yet, say what is missing in one line.";
}

/** The honest close when a turn cannot produce an answer that
 *  is not narration: short, plain, and never the reasoning
 *  itself. */
export const REASONING_BLOCKED_REPLY = "I tangled that one up in my own working notes and stopped rather than hand you the mess. Ask me again and I will answer straight.";

export function reasoningBlockedLedgerSummary(signals: ReasoningSignal[], seam: string): string {
  return "Blocked a reasoning-shaped reply at the " + seam + " seam (signals: " + signals.map(s => s.name).join(", ") + ") - the narration was withheld; the turn was steered to answer directly or closed with the honest line";
}

// The reasoning-leak scorecard (2026-11-18, the measured-proof
// series): the reply guard ledgers every reply it blocks as a
// "reasoning-leak-blocked" line - the seam that withheld it and
// the fixed signal names that condemned it. But no daily
// surface ever counted the class, so a model that started
// narrating its process regularly was invisible until the
// owner read a reply closely. This text folds the whole
// ledger's blocked lines to counts only: the blocked replies,
// counts per fixed seam bucket (save, connector, own-tools,
// other), and counts per fixed signal name. A summary that
// does not match the fixed shape still counts as a block and
// contributes no seam or signal counts, and is never printed.
// No stamp, no actor, and no verbatim summary enters the text,
// so a day no reply is blocked is byte-identical and
// P3-silent, and the first new blocked reply is the news. A
// pure read: it creates nothing, spends no model call, and
// retries nothing - the ledger and the guard are untouched,
// and fixing a narrating model stays the work lane's act.
export const REASONING_LEAK_SEAMS = ["save", "connector", "own-tools", "other"] as const;
export const REASONING_LEAK_SIGNALS = ["process-verb", "meta-ask", "tool-names", "machinery", "loading-gerund", "fragment-ending"] as const;
export function parseReasoningLeakBlocked(summary: string): { seam: string; signals: string[] } | null {
  const m = /^Blocked a reasoning-shaped reply at the (.+?) seam \(signals: ([^)]*)\) - /.exec(summary);
  if (!m) return null;
  const seam = m[1] === "save" ? "save" : m[1] === "connector loop" ? "connector" : m[1] === "own-tools loop" ? "own-tools" : "other";
  const signals = m[2].split(", ").map(s => s.trim()).filter(s => (REASONING_LEAK_SIGNALS as readonly string[]).includes(s));
  return { seam, signals };
}
export function reasoningLeakScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "reasoning-leak-blocked" });
  const seams: Record<string, number> = {};
  const signals: Record<string, number> = {};
  for (const line of lines) {
    const parsed = parseReasoningLeakBlocked(line.summary);
    const seam = parsed ? parsed.seam : "other";
    seams[seam] = (seams[seam] ?? 0) + 1;
    if (parsed) for (const s of parsed.signals) signals[s] = (signals[s] ?? 0) + 1;
  }
  const seamText = REASONING_LEAK_SEAMS.filter(s => seams[s]).map(s => s + " " + String(seams[s])).join(", ") || "none";
  const signalText = REASONING_LEAK_SIGNALS.filter(s => signals[s]).map(s => s + " " + String(signals[s])).join(", ") || "none";
  const out: string[] = [];
  out.push("Reasoning leaks: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Blocked replies: " + String(lines.length));
  out.push("By seam: " + seamText);
  out.push("By signal: " + signalText);
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a reply or prints a summary; a new blocked reply is the news");
  return out.join("\n");
}

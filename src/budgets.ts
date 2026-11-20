import { errorReason } from "./telegram.js";
import { readActivity } from "./activity.js";

// Tool budgets tier by route (program P5). Not every turn deserves the same
// leash: a heartbeat poll is SAM glancing at a gauge and must stay cheap, an
// interactive chat is the owner's live question, and a background task exists
// precisely to go deep. One shared budget shape, three tiers, so a poll can
// never starve a deep question by burning the same allowance - and a deep
// question never has to fit inside a poll's allowance.
export type TurnRoute = "chat" | "heartbeat" | "background";
export interface ToolBudget { rounds: number; maxCalls: number }
const BUDGETS: Record<TurnRoute, ToolBudget> = {
  heartbeat: { rounds: 2, maxCalls: 4 },
  chat: { rounds: 3, maxCalls: 6 },
  background: { rounds: 6, maxCalls: 16 },
};
export function toolBudget(route: TurnRoute = "chat"): ToolBudget {
  return { ...BUDGETS[route] };
}

// Owner-turn budgets (Dip ruling 2026-11-14, after he hit the death
// live on his phone: a five-call dashboard turn - memory_search,
// search_chats, workspace_list, memory_list, workspace_list again -
// ended "I ran out of steps for this turn... Ask me to continue").
// The owner's own surfaces (the dashboard, Telegram, his CLI: route
// "chat" on a non-visitor chat that did not arrive through a scoped
// door) effectively do not run out: the standard budget is an order
// of magnitude past the old chat tier, and past it the turn keeps
// going in tranches instead of ending. What keeps a tight leash is
// only what the leash protects: visitor doors and the per-person
// scoped SAMs (minis) ride the legacy chat tier with no ceiling
// extension, and the machine routes keep their tiers untouched.
// The ceiling is the real internal guardrail: a hard stop against a
// runaway loop, far past any honest turn, whose trip is ledgered as
// a named failure (budget-guardrail) and closes the turn with a
// synthesis from the material already gathered - never with the
// incomplete-answer text, which is unreachable on owner surfaces.
export type ChatSurface = "owner" | "scoped";
/** Mid-turn owner steering (Defect 2): at a tool-round boundary the
 *  loop asks the provider for whatever the owner sent while the turn
 *  ran. The provider has already persisted the messages to the chat;
 *  the loop only folds them into its live prompt. cancel means the
 *  owner said stop: the turn closes after this step. */
export interface SteerBatch { contents: string[]; cancel: boolean }
export type SteerProvider = () => SteerBatch | null;
export function messageSteerLedgerSummary(count: number): string {
  return "Owner sent " + count + " message(s) mid-turn; folded into the running turn, the latest governs";
}
export function messageStopLedgerSummary(calls: number): string {
  return "Owner said stop mid-turn after " + calls + " calls; the turn closes with an accounting";
}
export const OWNER_CHAT_BUDGET: ToolBudget = { rounds: 30, maxCalls: 120 };
export const OWNER_CHAT_CEILING: ToolBudget = { rounds: 60, maxCalls: 300 };
export function chatTurnBudget(input: { route: TurnRoute; surface?: ChatSurface; visitor?: boolean }): { budget: ToolBudget; ceiling: ToolBudget | null } {
  if (input.route !== "chat") return { budget: toolBudget(input.route), ceiling: null };
  if (input.visitor || input.surface === "scoped") return { budget: toolBudget("chat"), ceiling: null };
  return { budget: { ...OWNER_CHAT_BUDGET }, ceiling: { ...OWNER_CHAT_CEILING } };
}
/** The stub for a call past the hard ceiling: the transcript stays
 *  valid, and the wording names the limit as the internal guardrail
 *  it is - not a budget the owner is meant to manage. */
export function guardrailStubContent(executed: string[], ceiling: ToolBudget): string {
  return JSON.stringify({
    error: "Internal safety limit reached - this call was not executed",
    note: "This turn has used its hard safety limit of " + ceiling.maxCalls + " tool calls (" + (executed.join(", ") || "none") + "). No more tools will run in this turn. Answer now from the results already gathered.",
  });
}
export function budgetContinuedSummary(tranche: number, executed: string[], roundsUsed: number): string {
  return "Owner turn continued past its standard budget (tranche " + tranche + "): " + executed.length + " calls over " + roundsUsed + " rounds so far - the turn keeps going instead of ending on a budget message";
}
export function guardrailLedgerSummary(executed: string[], skipped: string[], ceiling: ToolBudget, reason: TurnEndReason = "calls"): string {
  if (reason === "steps") return "Owner turn hit the internal budget guardrail (rounds): " + ceiling.rounds + " rounds used with " + executed.length + " calls (" + (executed.join(", ") || "none") + ") - closed with a synthesis from gathered material" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
  return "Owner turn hit the internal budget guardrail (calls): " + executed.length + "/" + ceiling.maxCalls + " calls used (" + (executed.join(", ") || "none") + ") - closed with a synthesis from gathered material" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
}
export function guardrailFallbackAnswer(executed: string[], skipped: string[], ceiling: ToolBudget): string {
  // The last-resort close when even the tool-free synthesis would
  // not compose an answer at the ceiling. It is a finished statement
  // of what ran and what did not - never the incomplete-answer text
  // and never an instruction to ask for a continuation: at 300 calls
  // the honest statement is that the internal limit stopped the
  // turn, with the gathered work named.
  return "I reached my internal safety limit for a single turn (" + executed.length + " tool calls: " + (executed.join(", ") || "none") + ") and stopped there instead of looping further. " + (skipped.length ? "These checks did not run: " + skipped.join(", ") + ". " : "") + "Everything gathered before the limit is in this turn's results, and the limit itself is recorded in my activity log.";
}
/** A single turn whose spend is actually large earns one plain
 *  activity line (the owner's cost visibility), at this threshold. */
export const LARGE_TURN_CALLS = 40;
// The ONE writer for the turn-cost ledger line: both chat
// loops' large-turn seams ledger exactly this shape (through
// largeTurnSummary below) when a ceiling-mode owner turn
// crosses LARGE_TURN_CALLS, so the writer and the scorecard's
// parser below can never drift.
export function largeTurnLedgerSummary(executed: string[], roundsUsed: number): string {
  return "Large owner turn: " + executed.length + " tool calls over " + roundsUsed + " rounds in one answer (" + (executed.join(", ") || "none") + ")";
}
export function largeTurnSummary(executed: string[], roundsUsed: number): string {
  return largeTurnLedgerSummary(executed, roundsUsed);
}
// The turn-cost scorecard (2026-11-19, the measured-proof
// series): large owner turns have ledgered as "turn-cost"
// lines in the one fixed shape above since the owner-budget
// ruling landed, but the class was never folded, so how many
// turns ran large, how many calls and rounds they burned in
// aggregate, and what the largest single turn cost were
// invisible in aggregate - the tool-budget scorecard counts
// turns that END on budget, never turns that simply ran big
// and finished. Every turn-cost line is by construction one
// of the owner's most expensive turns, so the verdict is
// attention when any line exists or any line is unparseable,
// else clear. This text folds the whole ledger's turn-cost
// lines to counts only, on ONE line: the parsed large-turn
// count, the summed tool calls and rounds (both ride the
// line's header, which always survives), the largest turn's
// call count, the distinct-tool count, and the total. Tool
// names ride each line's list internally and surface as a
// count only: no stamp, no actor, no tool name, and no
// verbatim summary enters the text. The stored shapes are
// TWO: the writer's full shape, and the ledger's 300-char
// capped shape (every live line is capped - a 40+ call list
// never fits - cut mid-name with no closing paren); a capped
// line's header still parses exactly, and its list
// contributes only its complete entries (each name followed
// by a separator), the loop-check precedent - the trailing
// fragment may be a partial name and is never counted. A
// summary matching neither shape counts toward the total
// and the unparseable count only, and is never printed. A
// pure read: it creates nothing, spends no model call, and
// retries nothing - the ledger and the large-turn seams are
// untouched.
export function parseLargeTurnSummary(summary: string): { calls: number; rounds: number; tools: string[]; complete: boolean } | null {
  const full = /^Large owner turn: (\d+) tool calls over (\d+) rounds in one answer \(([^)]*)\)$/.exec(summary);
  if (full) {
    const list = full[3];
    return { calls: Number(full[1]), rounds: Number(full[2]), tools: list === "none" ? [] : list.split(", "), complete: true };
  }
  const capped = /^Large owner turn: (\d+) tool calls over (\d+) rounds in one answer \((.+)$/.exec(summary);
  if (capped) {
    const segments = capped[3].split(", ");
    return { calls: Number(capped[1]), rounds: Number(capped[2]), tools: segments.slice(0, -1), complete: false };
  }
  return null;
}
export function largeTurnScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "turn-cost" });
  const tools = new Set<string>();
  let calls = 0;
  let rounds = 0;
  let largest = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseLargeTurnSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    calls += parsed.calls;
    rounds += parsed.rounds;
    if (parsed.calls > largest) largest = parsed.calls;
    for (const tool of parsed.tools) tools.add(tool);
  }
  const parts: string[] = [];
  parts.push("Turn costs: " + (lines.length > 0 ? "attention" : "clear"));
  parts.push(String(lines.length - unparseable) + " large turns");
  parts.push(String(calls) + " tool calls");
  parts.push(String(rounds) + " rounds");
  parts.push("largest " + String(largest) + " calls");
  parts.push(String(tools.size) + " distinct tools");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
export function repeatLedgerSummary(repeats: string[]): string {
  return "Duplicate tool calls suppressed in one turn: " + repeats.length + " (" + repeats.join(", ") + ") - identical repeats returned the earlier result instead of re-executing";
}

// Graceful exhaustion (post-program fix, Dip hit the death live 2026-11-09):
// a turn that overspends its budget must ANSWER from what it already gathered,
// never die and discard the transcript. Both tool loops share these shapes:
// the stub that stands in for an unexecuted call (the transcript stays valid -
// every tool_call still gets a tool reply), the ledger summary that makes the
// next overspend diagnosable from data, and the fallback answer used when the
// tool-free synthesis still tries to call tools instead of summarizing.
export function budgetStubContent(executed: string[], maxCalls: number): string {
  return JSON.stringify({
    error: "Tool budget exhausted - this call was not executed",
    note: "You have used all " + maxCalls + " tool calls for this turn (" + (executed.join(", ") || "none") + "). No more tools will run. Answer now from the results already gathered, and say plainly which checks you could not finish.",
  });
}
export type TurnEndReason = "calls" | "steps";
/** The context-reset retry's trim: the system line plus the last six
 * messages. Shorter histories pass through unchanged (and the caller
 * treats "nothing trimmed" as no reset to offer). */
export function trimHistoryForRetry<T>(messages: T[]): T[] {
  if (messages.length <= 7) return messages;
  return [messages[0], ...messages.slice(-6)];
}
/** The turn-retry ledger line both chat loops write when the
 * context-reset retry fires. Its quoted reason composes through
 * errorReason (the 04:04 bridge seam; gap found 2026-11-16,
 * hourly run 18:04 EST): both loops took (e as Error).message
 * alone, so a triggering error carrying that message WITH a
 * cause (a provider attaching its sanitized transport cause,
 * the 09:04 shape, or any future completer) would ledger the
 * bare message and drop the cause its turn-failed sibling
 * names. errorReason walks the cause chain (bounded, deduped),
 * appends errno-style codes, redacts bot-token segments, and
 * collapses whitespace; causeless errors read byte-identically,
 * and the line's prefix and suffix are exactly the old shape. */
export function turnRetryLedgerSummary(error: unknown): string {
  return "Context reset after '" + errorReason(error) + "' before any tool ran; history trimmed to the last 6 messages";
}
export function turnRetrySummary(error: unknown): string {
  return turnRetryLedgerSummary(error);
}
// The turn-retry scorecard (2026-11-19, the measured-proof
// series): the context-reset retry has ledgered as a
// "turn-retry" line in the one fixed shape above since the
// context-reset fix landed (2026-11-10), but the class was
// never folded, so how often a turn's history had to be
// reset for the turn to survive, and whether the trigger
// was unsafe or empty model output, was invisible in
// aggregate - its turn-lifecycle siblings (turn, turn-failed,
// turn-cost, turn-reset, tool-budget, provider-retry) are
// all measured. Every retry line is by construction a first
// completion that failed before any tool ran, so the verdict
// is attention when any line exists or any line is
// unparseable, else clear. This text folds the whole
// ledger's turn-retry lines to counts only, on ONE line: the
// parsed retry count, counts per fixed reason bucket
// (unsafe / empty / other, read from the reason's head - the
// two failure shapes the reset exists for, everything else
// other), and the total. No stamp, no actor, and no verbatim
// reason enters the text. The stored shapes are TWO: the
// writer's full shape, and the ledger's 300-char capped
// shape (a long cause chain is cut mid-reason with the
// suffix gone); a capped line's reason head still buckets
// exactly - unsafe and empty both name themselves at the
// head - and it is marked incomplete, the turn-cost
// precedent. A capped shape is only a capped shape at the
// cap length: a shorter line missing its suffix matches
// neither shape, counts toward the total and the
// unparseable count only, and is never printed. A pure
// read: it creates nothing, spends no model call, and
// retries nothing - the ledger and the retry seams are
// untouched.
export type TurnRetryReasonBucket = "unsafe" | "empty" | "other";
function turnRetryBucket(reasonHead: string): TurnRetryReasonBucket {
  if (reasonHead.startsWith("Unsafe model output")) return "unsafe";
  if (reasonHead.startsWith("Empty model response")) return "empty";
  return "other";
}
export function parseTurnRetrySummary(summary: string): { bucket: TurnRetryReasonBucket; complete: boolean } | null {
  const full = /^Context reset after '(.+)' before any tool ran; history trimmed to the last 6 messages$/.exec(summary);
  if (full) return { bucket: turnRetryBucket(full[1]), complete: true };
  if (summary.length >= 300) {
    const capped = /^Context reset after '(.+)$/.exec(summary);
    if (capped) return { bucket: turnRetryBucket(capped[1]), complete: false };
  }
  return null;
}
export function turnRetryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "turn-retry" });
  let unsafe = 0;
  let empty = 0;
  let other = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseTurnRetrySummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.bucket === "unsafe") unsafe += 1;
    else if (parsed.bucket === "empty") empty += 1;
    else other += 1;
  }
  const parts: string[] = [];
  parts.push("Turn retries: " + (lines.length > 0 ? "attention" : "clear"));
  parts.push(String(lines.length - unparseable) + " retries");
  parts.push("unsafe " + String(unsafe));
  parts.push("empty " + String(empty));
  parts.push("other " + String(other));
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
export function budgetLedgerSummary(executed: string[], skipped: string[], maxCalls: number, reason: TurnEndReason = "calls"): string {
  if (reason === "steps") return "Turn step limit reached: " + executed.length + " calls used (" + (executed.join(", ") || "none") + ") - the call budget (" + maxCalls + ") was NOT reached" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
  return "Tool budget exhausted: " + executed.length + "/" + maxCalls + " calls used (" + (executed.join(", ") || "none") + ")" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
}
// The tool-budget scorecard (2026-11-18, the measured-proof
// series): the graceful-exhaustion seam ledgers every turn
// that ends on its budget as a "tool-budget" line, in the
// two honest shapes budgetLedgerSummary writes - the call
// cap really hit, or the rounds ran out with the cap NOT
// reached. Self-work ranks the class as a top recurring
// defect, but no daily surface ever counted it, so a turn
// that keeps truncating its work was invisible until the
// owner watched it happen. This text folds the whole
// ledger's tool-budget lines to counts only: the total,
// and counts per fixed end. A summary matching neither
// shape is "other" and is never printed. No stamp, no
// actor, no tool name, no verbatim summary enters the
// text, so a day no turn ends on budget is byte-identical
// and P3-silent, and the first new truncated turn is the
// news. A pure read: it creates nothing, spends no model
// call, and retries nothing - the ledger and the budget
// seam are untouched.
export type ToolBudgetEnd = "calls" | "steps" | "other";
export function parseToolBudgetEnding(summary: string): ToolBudgetEnd {
  if (summary.startsWith("Tool budget exhausted:")) return "calls";
  if (summary.startsWith("Turn step limit reached:")) return "steps";
  return "other";
}
export function toolBudgetScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "tool-budget" });
  const ends = new Map<ToolBudgetEnd, number>();
  for (const line of lines) {
    const end = parseToolBudgetEnding(line.summary);
    ends.set(end, (ends.get(end) ?? 0) + 1);
  }
  const byEnd = [...ends.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  out.push("Tool budget endings: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Ended turns: " + String(lines.length));
  out.push("By end: " + (byEnd.length ? byEnd.map(([end, n]) => end + " " + String(n)).join(", ") : "none"));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a turn or prints a tool name; a new truncated turn is the news");
  return out.join("\n");
}
export function budgetFallbackAnswer(executed: string[], skipped: string[], maxCalls: number, reason: TurnEndReason = "calls"): string {
  // The ending must be named honestly (owner defect 2026-11-10: a turn
  // that ran out of ROUNDS with 1 of 6 calls used reported "I reached
  // the tool budget"). "calls" means the call cap really was hit;
  // "steps" means the rounds ran out or the model kept asking for
  // tools in the tool-free synthesis step.
  if (reason === "steps") return "I ran out of steps for this turn (" + executed.length + " calls made" + (executed.length ? ": " + executed.join(", ") : "") + ") before I could finish, so this answer is incomplete. " + (skipped.length ? "These checks did not run: " + skipped.join(", ") + ". " : "") + "Ask me to continue, or hand the rest to the background, and I will pick it up from there.";
  return "I reached the tool budget for this turn (" + executed.length + " of " + maxCalls + " calls used" + (executed.length ? ": " + executed.join(", ") : "") + ") before I could finish, so this answer is incomplete. " + (skipped.length ? "These checks did not run: " + skipped.join(", ") + ". " : "") + "Ask me to continue, or hand the rest to the background, and I will pick it up from there.";
}

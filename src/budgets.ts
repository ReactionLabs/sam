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
export function largeTurnSummary(executed: string[], roundsUsed: number): string {
  return "Large owner turn: " + executed.length + " tool calls over " + roundsUsed + " rounds in one answer (" + (executed.join(", ") || "none") + ")";
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
export function budgetLedgerSummary(executed: string[], skipped: string[], maxCalls: number, reason: TurnEndReason = "calls"): string {
  if (reason === "steps") return "Turn step limit reached: " + executed.length + " calls used (" + (executed.join(", ") || "none") + ") - the call budget (" + maxCalls + ") was NOT reached" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
  return "Tool budget exhausted: " + executed.length + "/" + maxCalls + " calls used (" + (executed.join(", ") || "none") + ")" + (skipped.length ? "; not executed: " + skipped.join(", ") : "");
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

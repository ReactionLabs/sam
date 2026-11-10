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

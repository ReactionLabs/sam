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

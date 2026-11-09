import { join, resolve } from "node:path";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { ChatStore } from "./chats.js";
import { runMemoryToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";
import type { Message } from "./model-conversation.js";

export interface DashboardLocalToolTurnInput {
  stateRoot: string;
  toolRoot: string;
  chatId: string;
  messages: Message[];
  workspaceTools: boolean;
  request: (
    messages: ToolMessage[],
    toolsEnabled: boolean,
    memoryWriteEnabled?: boolean
  ) => Promise<ToolTurn>;
}

/**
 * Runs only the existing bounded read-only memory/workspace tool set.
 * Durable loop events live in the state database; chat events make tool
 * activity visible in the selected conversation after the turn completes.
 */
export async function runDashboardLocalToolTurn(input: DashboardLocalToolTurnInput): Promise<string> {
  const stateRoot = resolve(input.stateRoot);
  const toolRoot = resolve(input.toolRoot);
  const databasePath = join(stateRoot, ".sam", "missions.db");
  const journal = new AgentLoopJournal(databasePath);
  const chats = new ChatStore(stateRoot);
  const goal = [...input.messages].reverse().find(message => message.role === "user")?.content
    ?? "Dashboard local tool turn";
  let loopId: string | undefined;

  try {
    loopId = journal.create(goal.slice(0, 4000)).id;
    const answer = await runMemoryToolTurn(
      input.request,
      input.messages,
      databasePath,
      event => {
        const detail = (event.tool + " " + event.status + " " + event.detail).slice(0, 1000);
        journal.event(loopId!, "tool_" + event.status, detail);
        try { chats.addEvent(input.chatId, "sam", "tool", detail); }
        catch { /* The durable loop journal remains the primary audit record. */ }
      },
      input.workspaceTools ? toolRoot : undefined,
      (round, calls) => journal.progress(loopId!, round, calls),
      false,
      undefined,
      stateRoot
    );
    journal.finish(loopId, "completed", answer.slice(0, 8000));
    try { chats.addEvent(input.chatId, "sam", "result", "Local read-only tool turn completed."); }
    catch { /* Do not turn a completed read into a false model failure. */ }
    return answer;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Dashboard tool turn failed";
    if (loopId) {
      try { journal.finish(loopId, "failed", detail.slice(0, 8000)); } catch { /* Preserve the original error. */ }
      try { chats.addEvent(input.chatId, "sam", "result", "Local read-only tool turn failed."); }
      catch { /* The journal remains the durable audit record. */ }
    }
    throw error;
  } finally {
    chats.close();
    journal.close();
  }
}

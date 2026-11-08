/** Provider-neutral, text-only conversation contract. No network or tool execution. */
export type Role = "system" | "user" | "assistant";
export interface Message { role: Role; content: string }
export interface ConversationRequest {
  model: string;
  messages: readonly Message[];
}
export interface ConversationResponse {
  message: Message & { role: "assistant" };
  provider: string;
  model: string;
}
export interface ModelProvider {
  readonly id: string;
  complete(request: ConversationRequest): Promise<ConversationResponse>;
}
export function validateConversation(request: ConversationRequest): void {
  if (!request.model.trim()) throw new Error("Model is required");
  if (request.messages.length === 0 || request.messages.length > 100)
    throw new Error("Conversation must contain 1 to 100 messages");
  for (const message of request.messages) {
    if (!["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() ||
        message.content.length > 100_000)
      throw new Error("Invalid conversation message");
  }
}
/** Deterministic offline provider for contract tests and CLI smoke tests. */
export class FakeModelProvider implements ModelProvider {
  readonly id = "fake";
  async complete(request: ConversationRequest): Promise<ConversationResponse> {
    validateConversation(request);
    const lastUser = [...request.messages].reverse().find(m => m.role === "user");
    if (!lastUser) throw new Error("At least one user message is required");
    return { provider: this.id, model: request.model,
      message: { role: "assistant", content: "FAKE: " + lastUser.content } };
  }
}
export async function converse(provider: ModelProvider, request: ConversationRequest): Promise<ConversationResponse> {
  validateConversation(request);
  const result = await provider.complete(request);
  if (result.provider !== provider.id || result.model !== request.model ||
      result.message.role !== "assistant" || !result.message.content.trim())
    throw new Error("Provider returned an invalid response");
  return result;
}

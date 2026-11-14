import { ChatStore } from "./chats.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { modelEndpoint, modelApiKey } from "./config-wizard.js";
import { modelRoutingTable } from "./model-routing.js";

// Auto-titling for chats the dashboard creates on the owner's first send
// (Dip ruling 2026-11-14: messaging from the Talk empty state simply creates
// the chat, and SAM names it something relevant from the first message and
// the exchange). One cheap completion through the configured chat model;
// any failure or missing model leaves the provisional title in place. The
// rename only lands while the chat still carries the provisional title the
// client created it with, so an owner rename in the meantime always wins.

export function sanitizeChatTitle(raw: string): string | null {
  let t = (raw ?? "").split("\n")[0].trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "").replace(/\*+/g, "").trim();
  t = t.replace(/\s+/g, " ").replace(/[.!,;:]+$/, "").trim();
  if (t.length > 48) t = t.slice(0, 48).replace(/\s+\S*$/, "").trim();
  if (t.length < 3) return null;
  if (/^(new conversation|untitled|chat|conversation)$/i.test(t)) return null;
  return t;
}

export type TitleCompleter = (userText: string, replyText: string) => Promise<string>;

export function defaultTitleCompleter(env: NodeJS.ProcessEnv = process.env): TitleCompleter | null {
  const endpoint = modelEndpoint(env);
  const key = modelApiKey(env);
  const model = modelRoutingTable(env).find(r => r.route === "chat")?.model ?? null;
  if (!endpoint || !key || !model) return null;
  const provider = new OpenAICompatibleProvider(endpoint, key, 20_000);
  return async (userText: string, replyText: string) => {
    const prompt = [
      "Name this chat with a short, specific title of 3 to 6 words. No quotes, no ending punctuation. Reply with the title only.",
      "Owner said: " + userText.slice(0, 600),
      "Assistant replied: " + replyText.slice(0, 600),
    ].join("\n");
    const res = await provider.complete({ model, messages: [{ role: "user", content: prompt }] });
    return res.message.content;
  };
}

export async function autotitleChat(
  root: string,
  chatId: string,
  placeholder: string,
  env: NodeJS.ProcessEnv = process.env,
  complete?: TitleCompleter,
): Promise<string | null> {
  const db = new ChatStore(root);
  try {
    const chat = db.get(chatId);
    if (!chat || chat.title !== placeholder) return null;
    const msgs = db.messages(chatId);
    const user = msgs.find(m => m.role === "user");
    if (!user) return null;
    const asst = msgs.find(m => m.role === "assistant");
    const run = complete ?? defaultTitleCompleter(env);
    if (!run) return null;
    let raw: string;
    try {
      raw = await run(user.content, asst?.content ?? "");
    } catch {
      return null;
    }
    const title = sanitizeChatTitle(raw);
    if (!title || title === placeholder) return null;
    // Re-check under the same store: the owner may have renamed while the
    // model was thinking. Their name wins.
    const now = db.get(chatId);
    if (!now || now.title !== placeholder) return null;
    db.rename(chatId, title);
    return title;
  } finally {
    db.close();
  }
}

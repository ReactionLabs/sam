import { ChatStore } from "./chats.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { modelEndpoint, modelApiKey } from "./config-wizard.js";
import { modelRoutingTable } from "./model-routing.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./telegram.js";

// Auto-titling for chats the dashboard creates on the owner's first send
// (Dip ruling 2026-11-14: messaging from the Talk empty state simply creates
// the chat, and SAM names it something relevant from the first message and
// the exchange). One cheap completion through the configured chat model;
// any failure or missing model leaves the provisional title in place. The
// rename only lands while the chat still carries the provisional title the
// client created it with, so an owner rename in the meantime always wins.

/**
 * The provisional title the dashboard client gives a chat created from
 * the Talk empty state: a cleaned slice of the first message. This is
 * the server twin of provisionalTitle() in dashboard-ui.ts - the two
 * must agree, because the organize pass (chat-organize.ts) recognizes
 * a still-provisional chat by recomputing this from its first message
 * and comparing it with the stored title.
 */
export function provisionalTitle(text: string): string {
  let t = (text ?? "").split("\n")[0].trim();
  t = t.replace(/^(hey|hi|ok|okay|so|please|sam)[\s,:\-]+/i, "");
  t = t.replace(/^(what's|whats|what|how|why|when|where|who|can|could|should|would|is|are|do|does|did)\s+(is|are|was|were|do|does|did|i|we|you|the|a|an)?\s*/i, "");
  t = t.replace(/\s+/g, " ").replace(/[?.!,;:]+$/, "").trim();
  if (t.length > 42) t = t.slice(0, 42).replace(/\s+\S*$/, "");
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t || "New conversation";
}

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

// Autotitle failures are ledgered (gap found 2026-11-17,
// hourly run 02:04 EST): the completer catch used to bind
// nothing and return null, so a title route dying on
// transport, timeout, or auth left the provisional title in
// place - exactly as designed - with zero evidence anywhere:
// the class was neither countable nor diagnosable, and a
// persistently dead title route would silently leave every
// new chat provisionally named forever. Now the catch
// ledgers ONE autotitle-failed activity line and still
// returns null exactly as before. The reason composes
// through errorReason (the 04:04 bridge seam): the cause
// chain is walked bounded and deduped, errno-style codes are
// appended, and bot-token segments are redacted. Causeless
// errors read byte-identically to their plain message, a
// non-Error throw reads through String(error), and the
// person's message content never enters the line. Returns
// that are not failures stay silent: no model configured,
// a placeholder mismatch (the owner renamed first), and a
// completion that sanitizes to no title.
export function autotitleFailureReason(error: unknown): string {
  return errorReason(error);
}

export function autotitleFailedSummary(chatId: string, error: unknown): string {
  return ("Autotitle failed in chat " + chatId.slice(0, 8) + ": " + autotitleFailureReason(error)).slice(0, 200);
}

export function recordAutotitleFailure(root: string, actor: string, chatId: string, error: unknown): void {
  recordActivity(root, actor, "autotitle-failed", autotitleFailedSummary(chatId, error));
}

// The autotitle-failed history scorecard (2026-11-22, the
// measured-proof series): autotitle failures have ledgered
// as "autotitle-failed" lines in the one fixed shape above
// since the failure-ledgering fix landed (2026-11-17), and
// self-work ranks the class as a defect - but the class was
// never folded, so how often the title route has ever died,
// on how many chats, and whether the cause was transport,
// an unsafe completion, an empty completion, or something
// else was invisible in aggregate; a persistently dead
// title route would silently leave every new chat
// provisionally named forever, counted nowhere. Every
// failure line is by construction a title attempt the
// completer could not finish, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear (the turn-failure precedent).
// This text folds the whole ledger's autotitle-failed
// lines to counts only, on ONE line: the parsed failure
// count, the split per fixed reason-head bucket
// (transport / unsafe / empty / other, read from the
// reason's head only - the turn-retry bucket precedent),
// the distinct-chat count as a number only, and the
// total. No stamp, no actor, no chat id, and no verbatim
// reason enters the text: the reason is consumed by the
// bucket and never printed. The writer caps its own line
// at 200 chars, so the stored shape is the writer's shape
// alone (the ledger's 300-char cap never binds past it),
// and a truncated reason still buckets exactly -
// transport, unsafe, and empty all name themselves at the
// head. A summary matching the fixed shape with an empty
// or whitespace reason matches nothing: it counts toward
// the total and the unparseable count only, and is never
// printed. A pure read: it creates nothing, spends no
// model call, and titles nothing - the ledger and the
// autotitle seam are untouched beyond riding their
// writer.
export type AutotitleFailureBucket = "transport" | "unsafe" | "empty" | "other";
function autotitleFailureBucket(reasonHead: string): AutotitleFailureBucket {
  if (reasonHead.startsWith("fetch failed")) return "transport";
  if (reasonHead.startsWith("Unsafe model output")) return "unsafe";
  if (reasonHead.startsWith("Empty model response")) return "empty";
  return "other";
}
export function parseAutotitleFailedSummary(summary: string): { chat: string; bucket: AutotitleFailureBucket } | null {
  const m = /^Autotitle failed in chat ([0-9a-f]{8}): (.+)$/.exec(summary);
  if (!m) return null;
  const reason = m[2] ?? "";
  if (!reason.trim()) return null;
  return { chat: m[1] ?? "", bucket: autotitleFailureBucket(reason) };
}
export function autotitleFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "autotitle-failed" });
  let failures = 0;
  let transport = 0;
  let unsafe = 0;
  let empty = 0;
  let other = 0;
  let unparseable = 0;
  const chats = new Set<string>();
  for (const line of lines) {
    const parsed = parseAutotitleFailedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    failures += 1;
    chats.add(parsed.chat);
    if (parsed.bucket === "transport") transport += 1;
    else if (parsed.bucket === "unsafe") unsafe += 1;
    else if (parsed.bucket === "empty") empty += 1;
    else other += 1;
  }
  const parts: string[] = [];
  parts.push("Autotitle failed history: " + (failures > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failures) + " failures");
  parts.push("transport " + String(transport) + " / unsafe " + String(unsafe) + " / empty " + String(empty) + " / other " + String(other));
  parts.push(String(chats.size) + " distinct chats");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
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
    } catch (error) {
      try { recordAutotitleFailure(root, chat.agent_name ?? "sam", chatId, error); } catch { /* the ledger never breaks autotitle */ }
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

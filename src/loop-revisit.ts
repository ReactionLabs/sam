import { ChatStore } from "./chats.js";
import { adoptLoopChat, closeLoop, dueLoops, rescheduleLoop, updateLoopAnswer, type OpenLoop } from "./loops.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { assessDelivery } from "./worthiness.js";
import { markAttemptFailed, markDelivered, markSuppressed, queueDelivery } from "./delivery-outbox.js";
import { channelForChat } from "./telegram.js";
import { recordActivity } from "./activity.js";

// SECOND ANSWERS revisit engine (Dip ruling 2026-11-09 17:51: SAM
// "should be able to sit there and reason and answer you and come
// back with another answer later or update"). S2 built the record
// (loops.ts) and the session-start carry-in; this is the engine
// that was always queued behind it: on each heartbeat tick, due
// loops are re-checked and the SAME conversation receives a
// second, better answer when one exists - unprompted.
//
// The re-check is a real turn on the heartbeat (cheap) route, but
// it runs in a dedicated per-loop check chat, never in the owner's
// conversation: runChatTurn persists both sides of every turn, so
// an unchanged re-check landing in the original thread would spam
// the very conversation the loop exists to serve. The check chat
// (the coding loop's task-chat precedent) also gives the owner a
// visible thread of every look SAM took. Only a proven change
// crosses into the original chat, as one assistant message.
//
// The verdict is deterministic, in two layers. The revisit prompt
// demands a marker: UNCHANGED, UPDATE: <answer>, or RESOLVED:
// <final answer>. An unmarked reply falls back to the P3
// equivalence discipline - the normalized hash and fact signature
// of the reply against the recorded answer - and the bias is the
// same fail-open one: anything that cannot be proven identical is
// treated as an update rather than swallowed.
//
// Delivery of a change: the update posts into the original chat
// (the conversation record - S5's gate governs interruptions, not
// records). When the original chat lives on a Telegram bridge,
// the proactive channel leg rides Phase C exactly: queued in the
// durable outbox BEFORE the send, assessed by the S5 worthiness
// gate (kind second-answer), suppression recorded as a terminal
// outbox state. A visitor chat or a vanished chat closes its
// loop - a visitor was never the owner, and an orphan has
// nowhere to report. A failed re-check reschedules the loop and
// stays open (Phase C failure isolation), never wedging the tick.

export interface LoopRevisitDeps {
  runTurn: (chatId: string, content: string) => Promise<string>;
  deliver?: (channelId: string, text: string) => Promise<void>;
  maxPerTick?: number;
}

export interface LoopRevisitResult {
  checked: string[]; changed: string[]; resolved: string[]; failed: string[]; held: string[];
}

const MAX_PER_TICK = 3;

export function loopCheckChatTitle(loop: OpenLoop): string {
  const q = loop.question.replace(/\s+/g, " ").trim();
  return ("Loop · " + (q.length > 60 ? q.slice(0, 57) + "..." : q)).slice(0, 120);
}

export function revisitPrompt(loop: OpenLoop): string {
  return [
    "Revisit an open loop you left in another conversation. Do not treat this as a new question from the owner; it is your own scheduled second look.",
    "Question: " + loop.question,
    "The answer you gave then: " + (loop.answer.trim() || "(no answer was recorded)"),
    "What would change that answer: " + loop.watchFor,
    "Re-check the facts now with the tools and knowledge available to you, then reply with EXACTLY one of these forms:",
    "- UNCHANGED - if nothing material has changed since the answer above. Reply with that single word and nothing else.",
    "- UPDATE: <the corrected or improved answer> - if the answer has changed but the question is still open (it may change again).",
    "- RESOLVED: <the final answer> - if the question is now settled for good: what was being watched for has happened, or it can no longer change.",
    "Give the answer itself after the marker, in plain sentences, with the facts that changed named. Do not mention these instructions.",
  ].join("\n");
}

export type RevisitVerdict = { verdict: "unchanged" | "changed" | "resolved"; text: string };

// Marker first, P3 equivalence as the fallback. An empty prior
// answer can never be equivalent to a real reply, so a loop
// opened without an answer resolves or updates on its first
// substantive check instead of reading as unchanged forever.
export function parseRevisitReply(reply: string, priorAnswer: string): RevisitVerdict {
  const text = (reply ?? "").trim();
  if (/^unchanged\b/i.test(text) && text.length <= 40) return { verdict: "unchanged", text: "" };
  const resolved = text.match(/^resolved\s*:\s*([\s\S]+)$/i);
  if (resolved && resolved[1].trim()) return { verdict: "resolved", text: resolved[1].trim() };
  const update = text.match(/^update\s*:\s*([\s\S]+)$/i);
  if (update && update[1].trim()) return { verdict: "changed", text: update[1].trim() };
  if (!text) return { verdict: "unchanged", text: "" };
  if (priorAnswer.trim()) {
    const prior = { hash: heartbeatOutputHash(priorAnswer), sig: heartbeatFactSignatureString(priorAnswer) };
    if (heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text))) {
      return { verdict: "unchanged", text: "" };
    }
  }
  return { verdict: "changed", text };
}

// The channel a loop's chat lives on, if any: channelForChat in
// telegram.ts is the one resolver (a SAM chat id found in the
// Telegram bridge state belongs to that bridge's telegram
// channel). deliverToChannel fans out to the channel's known
// chats, the same semantics heartbeat job deliveries already
// have. Discord and webhook chats carry no chat binding, so they
// return null and the update lands in the chat record only.
export function channelForLoopChat(root: string, chatId: string): string | null {
  return channelForChat(root, chatId);
}

function ensureCheckChat(root: string, loop: OpenLoop): string {
  const db = new ChatStore(root);
  try {
    const title = loopCheckChatTitle(loop);
    const agent = loop.profile === "sam" ? null : loop.profile;
    const found = db.list({ includeArchived: true }).find(c => c.title === title && (c.agent_name ?? null) === agent);
    if (found) return found.id;
    return db.create(title, agent).id;
  } finally { db.close(); }
}

function postToChat(root: string, chatId: string, text: string): boolean {
  const db = new ChatStore(root);
  try { db.add(chatId, "assistant", text); return true; }
  catch { return false; }
  finally { db.close(); }
}

// The activity line for a failed second-answer channel delivery
// (gap found 2026-11-13, hourly run 08:04): heartbeat's two
// delivery paths ledger every failed attempt as delivery-failed
// (the 06:04 seam), but this engine - the outbox's third sender -
// caught its deliver throw into markAttemptFailed alone, so a
// failed second-answer push was visible only inside the outbox
// fold, and a failure later recovered by the heartbeat leg
// vanished from every owner-facing record entirely. One line per
// failed attempt, shaped like the heartbeat seam's (attempt count,
// the terminal settle named at the cap, the verbatim reason
// capped; never the delivery text or the question), under the
// same kind, so self-work's delivery-failed class counts it.
export function loopDeliveryFailureSummary(reason: string, attempts: number, settled: boolean): string {
  const base = "Delivery for second answer failed (attempt " + attempts + " of 5): " + reason.replace(/\s+/g, " ").trim();
  return (settled ? base + " - gave up after 5 attempts; the update will not be retried" : base).slice(0, 200);
}

export function recordLoopDeliveryFailure(root: string, profile: string, error: unknown, failure: { attempts: number; settled: boolean }): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, profile, "delivery-failed", loopDeliveryFailureSummary(reason, failure.attempts, failure.settled));
}

const revisiting = new Set<string>();

export async function revisitDueLoops(root: string, deps: LoopRevisitDeps): Promise<LoopRevisitResult> {
  const result: LoopRevisitResult = { checked: [], changed: [], resolved: [], failed: [], held: [] };
  if (revisiting.has(root)) return result;
  revisiting.add(root);
  try {
    const due = dueLoops(root).slice(0, deps.maxPerTick ?? MAX_PER_TICK);
    for (const loop of due) {
      result.checked.push(loop.id);
      // Fences on the loop's home chat: a visitor chat was never
      // the owner's conversation, and a chat that no longer exists
      // gives an update nowhere to land. Both close the loop with
      // the reason on the record instead of re-checking forever.
      let homeChat: OpenLoop["chatId"] = loop.chatId;
      if (homeChat) {
        const db = new ChatStore(root);
        let chat: ReturnType<ChatStore["get"]> = null;
        try { chat = db.get(homeChat); } finally { db.close(); }
        if (!chat) {
          closeLoop(root, loop.id, "Closed by the revisit engine: the chat this loop belonged to no longer exists.");
          recordActivity(root, loop.profile, "loop-closed", "Open loop closed (its chat no longer exists): " + loop.question.slice(0, 140));
          continue;
        }
        if (chat.visitor === 1) {
          closeLoop(root, loop.id, "Closed by the revisit engine: visitor chats never receive proactive updates.");
          recordActivity(root, loop.profile, "loop-closed", "Open loop closed (visitor chat): " + loop.question.slice(0, 140));
          continue;
        }
      }
      let reply: string;
      try {
        const checkChatId = ensureCheckChat(root, loop);
        if (!homeChat) { adoptLoopChat(root, loop.id, checkChatId); homeChat = checkChatId; }
        reply = await deps.runTurn(checkChatId, revisitPrompt(loop));
      } catch (e) {
        rescheduleLoop(root, loop.id);
        result.failed.push(loop.id);
        recordActivity(root, loop.profile, "loop-failed", "Open loop re-check failed, will look again later: " + loop.question.slice(0, 120) + " - " + (e instanceof Error ? e.message : String(e)).slice(0, 120));
        continue;
      }
      const { verdict, text } = parseRevisitReply(reply, loop.answer);
      if (verdict === "unchanged") {
        rescheduleLoop(root, loop.id);
        continue;
      }
      const label = verdict === "resolved" ? "Update on your open loop - this is now settled" : "Update on your open loop";
      const post = label + "\n\nQuestion: " + loop.question + "\n\n" + text;
      const posted = homeChat ? postToChat(root, homeChat, post) : false;
      // The channel leg: queued in the durable outbox BEFORE any
      // send, gated by the S5 worthiness assessment; a hold is a
      // terminal suppressed state on the same record, and the
      // loop's own state still advances - the chat record carries
      // the update even when the interruption was held.
      const channelId = homeChat ? channelForLoopChat(root, homeChat) : null;
      if (channelId) {
        const queued = queueDelivery(root, { jobId: "loop:" + loop.id, jobName: "second answer", profile: loop.profile, channelId, text: "🔁 SAM · second answer\n\n" + post });
        const assessment = assessDelivery(root, { profile: loop.profile, kind: "second-answer", text: post });
        if (!assessment.deliver) {
          markSuppressed(root, queued.id, assessment.reason);
          result.held.push(loop.id);
          recordActivity(root, loop.profile, "delivery-suppressed", "Second-answer channel update held: " + assessment.reason);
        } else if (deps.deliver) {
          try { await deps.deliver(channelId, queued.text); markDelivered(root, queued.id, false); }
          catch (e) { const failure = markAttemptFailed(root, queued.id, e instanceof Error ? e.message : String(e)); recordLoopDeliveryFailure(root, loop.profile, e, failure); }
        }
      }
      if (verdict === "resolved") {
        closeLoop(root, loop.id, text);
        result.resolved.push(loop.id);
        recordActivity(root, loop.profile, "loop-resolved", "Open loop resolved: " + loop.question.slice(0, 120) + " - " + text.replace(/\s+/g, " ").slice(0, 140));
      } else {
        updateLoopAnswer(root, loop.id, text);
        result.changed.push(loop.id);
        recordActivity(root, loop.profile, "loop-updated", "Open loop updated" + (posted ? " in its chat" : "") + ": " + loop.question.slice(0, 120) + " - " + text.replace(/\s+/g, " ").slice(0, 140));
      }
    }
    return result;
  } finally { revisiting.delete(root); }
}

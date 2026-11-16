import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { awaitChatQueue, enqueueChatMessage, type EnqueueResult } from "./chat-queue.js";
import { memberConnection, memberThinkBlock, type Member } from "./members.js";
import { getVaultCredentialValue } from "./vault.js";

// Voice on the member's MiniMax key (Dip, 2026-11-16: "make it
// native for my account and set mine to work so i dont have to
// dig" / "doesn't minimax have real time?"). MiniMax has NO
// speech-to-speech realtime API, so this path is honestly a
// stitched, turn-by-turn loop on the key the member ALREADY has
// for chat - no second key, no new deposit:
//
//   one recorded utterance -> MiniMax ASR (asr-1.0, file upload)
//   -> the transcript runs as an ordinary chat turn through the
//      member's scoped SAM on the same key (the chat queue, so
//      bursts, caps, and the ledger all behave exactly as typed)
//   -> the reply is spoken back sentence by sentence with
//      MiniMax TTS (speech-2.8-turbo), one synthesis per sentence
//
// The exchange lands in the chat with the "voice" provenance
// stamp, exactly like a transcript saved from the OpenAI live
// call, so the conversation continues in text. The OpenAI
// realtime path (member-voice.ts) is untouched and stays the
// default whenever a member holds a voice key; this mode is the
// one that lights up from the chat key alone.
//
// Fences, same as every member surface: the member's OWN key
// only, read from the vault here and only here; every spend is
// ledgered by name and purpose, never the value; the key never
// appears in a response or a log; a foreign chat is a 404-shaped
// refusal inside the module as well as at the door.

export const MM_KEY_MISSING = "mm-key-missing";
export const MM_KEY_NOT_MINIMAX = "mm-key-not-minimax";
export const MM_SPEAK_MAX_CHARS = 600;
export const MM_TURN_WAIT_MS = 240_000;

export interface MmVoiceConfig {
  /** Base for the MiniMax API. Derived from the member's own
   *  provider endpoint (https://api.minimax.io) unless
   *  SAM_MEMBER_MM_BASE_URL overrides it - the override exists
   *  so tests and the proof rig can point ASR/TTS at a local
   *  stub; production leaves it unset. */
  baseOverride: string;
  ttsModel: string;
  asrModel: string;
  voiceId: string;
}
export function mmVoiceConfig(env: NodeJS.ProcessEnv = process.env): MmVoiceConfig {
  return {
    baseOverride: (env.SAM_MEMBER_MM_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    ttsModel: (env.SAM_MEMBER_MM_TTS_MODEL ?? "").trim() || "speech-2.8-turbo",
    asrModel: (env.SAM_MEMBER_MM_ASR_MODEL ?? "").trim() || "asr-1.0",
    voiceId: (env.SAM_MEMBER_MM_VOICE_ID ?? "").trim() || "male-qn-qingse",
  };
}

type MmFetch = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>;
}>;
const realFetch = (async (url: string, init: Record<string, unknown>) =>
  fetch(url, init as RequestInit)) as unknown as MmFetch;

function coded(message: string, code: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

interface MmKey { key: string; baseUrl: string }

/** Resolve the member's MiniMax key for voice: the member must
 *  be active, thinking on a MiniMax key of their own (a custom
 *  endpoint key is not a MiniMax key and cannot buy MiniMax
 *  speech), with the value present in the vault. Plain-word,
 *  coded refusals for every other state. */
function mmKeyFor(root: string, member: Member, env: NodeJS.ProcessEnv): MmKey {
  if (member.status !== "active") throw new Error("This account is paused. Talk to the operator to turn it back on.");
  if (!member.provider || !member.keyName) {
    throw coded("Voice on your MiniMax key needs your MiniMax key first. Add it in Settings and voice is ready.", MM_KEY_MISSING);
  }
  if (member.provider.kind !== "minimax") {
    throw coded("This voice mode rides a MiniMax key, and your chat key points somewhere else. It cannot carry MiniMax voice.", MM_KEY_NOT_MINIMAX);
  }
  const conn = memberConnection(root, member);
  if ("unavailable" in conn) {
    throw coded("Voice on your MiniMax key needs your MiniMax key first. Add it in Settings and voice is ready.", MM_KEY_MISSING);
  }
  const key = getVaultCredentialValue(root, conn.vaultKey);
  if (!key) {
    throw coded("Voice on your MiniMax key needs your MiniMax key first. Add it in Settings and voice is ready.", MM_KEY_MISSING);
  }
  const cfg = mmVoiceConfig(env);
  let baseUrl = cfg.baseOverride;
  if (!baseUrl) {
    try { baseUrl = new URL(member.provider.endpoint).origin; }
    catch { baseUrl = "https://api.minimax.io"; }
  }
  return { key, baseUrl };
}

async function mmJson(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? data as Record<string, unknown> : null;
  } catch { return null; }
}
function baseRespProblem(data: Record<string, unknown> | null): string | null {
  const base = data?.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
  if (!base || typeof base.status_code !== "number" || base.status_code === 0) return null;
  return "MiniMax refused the request (code " + base.status_code + (typeof base.status_msg === "string" && base.status_msg ? ": " + base.status_msg : "") + ").";
}

/** Transcribe one recorded utterance with the member's key.
 *  ASR is file-upload only (no live mic stream exists), so the
 *  browser sends a finished recording and gets its words back.
 *  The spend is ledgered (vault-use, name and purpose only). */
export async function transcribeUtterance(
  root: string,
  member: Member,
  audio: { bytes: Buffer; filename: string; mime: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: MmFetch = realFetch,
): Promise<string> {
  const { key, baseUrl } = mmKeyFor(root, member, env);
  const cfg = mmVoiceConfig(env);
  const form = new FormData();
  form.append("model", cfg.asrModel);
  form.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mime || "audio/wav" }), audio.filename || "speech.wav");
  let res: Awaited<ReturnType<MmFetch>>;
  try {
    res = await fetchFn(baseUrl + "/v1/speech_to_text", {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("MiniMax could not be reached to hear that. Try again in a moment.");
  }
  const data = await mmJson(res);
  if (!res.ok) {
    // The refusal body stays out of every surface and log; the
    // one exception is the format verdict, which is the member's
    // own recording fact, not a secret.
    let formatRefusal = false;
    try {
      const errBody = data as { error?: { message?: unknown } } | null;
      formatRefusal = typeof errBody?.error?.message === "string" && /unsupported audio format/i.test(errBody.error.message);
    } catch { formatRefusal = false; }
    if (formatRefusal) throw new Error("That recording format is not one MiniMax can transcribe. Try again.");
    throw new Error("MiniMax would not transcribe that recording (HTTP " + res.status + "). Try again in a moment.");
  }
  const problem = baseRespProblem(data);
  if (problem) throw new Error(problem + " Try again in a moment.");
  const inner = (data?.data ?? null) as { text?: unknown; transcript?: unknown } | null;
  const raw = typeof inner?.text === "string" ? inner.text
    : typeof inner?.transcript === "string" ? inner.transcript
    : typeof data?.text === "string" ? data.text : "";
  const transcript = raw.trim();
  recordActivity(root, member.profile, "vault-use",
    "Vault credential " + member.keyName + " used for MiniMax speech-to-text (" + cfg.asrModel + ", " + audio.bytes.length + " bytes in)");
  recordActivity(root, member.profile, "member-mm-voice-asr",
    "An utterance was transcribed for member voice (" + transcript.length + " characters heard)");
  if (!transcript) throw new Error("SAM could not make out any words in that recording. Try again, a little closer to the mic.");
  return transcript;
}

/** Flatten a chat reply into speakable prose: code blocks and
 *  the Sources tail stay in the written chat (they are for
 *  eyes), markdown marks come off, links keep their words, and
 *  citation brackets go quiet. Idempotent, so the door can
 *  clean text the app already cleaned. */
export function speechText(text: string): string {
  let out = String(text ?? "");
  out = out.replace(/```[\s\S]*?(```|$)/g, " ");
  out = out.replace(/`([^`]*)`/g, "$1");
  const lines = out.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*sources\s*:/i.test(line)) break;
    kept.push(line);
  }
  out = kept.join(" ");
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[\d+\]/g, "");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s*>\s?/gm, "");
  out = out.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** Split speakable prose into sentence-sized chunks for the
 *  one-synthesis-per-sentence pipeline: fragments too small to
 *  say alone fold into their neighbour, and a run-on chunk is
 *  cut at a comma or a space so no single call carries a wall. */
export function splitSentences(text: string): string[] {
  const clean = speechText(text);
  if (!clean) return [];
  const parts = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [clean];
  const sentences: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (sentences.length && (part.length < 12 || sentences[sentences.length - 1].length < 12)) {
      sentences[sentences.length - 1] = (sentences[sentences.length - 1] + " " + part).trim();
    } else sentences.push(part);
  }
  const out: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > 280) {
      let cut = rest.lastIndexOf(", ", 280);
      if (cut < 120) cut = rest.lastIndexOf(" ", 280);
      if (cut < 120) cut = 280;
      out.push(rest.slice(0, cut + (rest[cut] === "," ? 1 : 0)).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out.filter(s => s.length > 0);
}

/** Synthesize one chunk of reply text with the member's key.
 *  One call per sentence is the shape MiniMax's own streaming
 *  speech is built around; the browser plays the chunks in the
 *  order they were asked for. Ledgered per call (chars only). */
export async function synthesizeSpeech(
  root: string,
  member: Member,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: MmFetch = realFetch,
): Promise<{ audio: Buffer; mime: string }> {
  const clean = speechText(text).slice(0, MM_SPEAK_MAX_CHARS);
  if (!clean) throw new Error("There is nothing to say in that text.");
  const { key, baseUrl } = mmKeyFor(root, member, env);
  const cfg = mmVoiceConfig(env);
  let res: Awaited<ReturnType<MmFetch>>;
  try {
    res = await fetchFn(baseUrl + "/v1/t2a_v2", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.ttsModel,
        text: clean,
        stream: false,
        voice_setting: { voice_id: cfg.voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
        subtitle_enable: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("MiniMax could not be reached to speak that. Try again in a moment.");
  }
  const data = await mmJson(res);
  if (!res.ok) {
    throw new Error("MiniMax would not speak that (HTTP " + res.status + "). Try again in a moment.");
  }
  const problem = baseRespProblem(data);
  if (problem) throw new Error(problem + " Try again in a moment.");
  const inner = (data?.data ?? null) as { audio?: unknown } | null;
  const hex = typeof inner?.audio === "string" ? inner.audio : "";
  if (!hex) throw new Error("MiniMax did not hand back any speech. Try again in a moment.");
  recordActivity(root, member.profile, "vault-use",
    "Vault credential " + member.keyName + " used for MiniMax text-to-speech (" + cfg.ttsModel + ", " + clean.length + " characters)");
  recordActivity(root, member.profile, "member-mm-voice-tts",
    "A reply chunk was spoken for member voice (" + clean.length + " characters)");
  return { audio: Buffer.from(hex, "hex"), mime: "audio/mpeg" };
}

export interface MmVoiceTurnResult {
  transcript: string;
  /** Set when SAM answered on the spot (cannot-think words, or a
   *  runtime status reply): the exchange is already saved. */
  reply?: string;
  /** Queue control effects (nevermind / stop): nothing was saved
   *  as a turn, and the note says what SAM heard it as. */
  effect?: string;
  note?: string;
}

/** The watcher that makes a queued voice turn read as spoken:
 *  when the chat's queue settles, the assistant row this voice
 *  turn produced is stamped "voice" (its user row already wears
 *  the stamp from the queue). Fire-and-forget by design - the
 *  turn itself never waits on bookkeeping - and every outcome
 *  is ledgered, never thrown. */
function watchVoiceReply(root: string, member: Member, chatId: string, beforeIds: Set<string>, transcript: string): void {
  void (async () => {
    try {
      await awaitChatQueue(root, chatId, MM_TURN_WAIT_MS);
    } catch { /* a timeout still gets one stamp attempt below */ }
    try {
      const store = new ChatStore(root);
      try {
        const rows = store.messages(chatId);
        const userIdx = rows.findIndex(m => !beforeIds.has(m.id) && m.role === "user" && m.source === "voice" && m.content === transcript);
        if (userIdx < 0) return;
        const reply = rows.slice(userIdx + 1).find(m => m.role === "assistant" && m.partial === 0);
        if (reply && reply.source !== "voice") store.setSource(chatId, reply.id, "voice");
        if (reply) {
          recordActivity(root, member.profile, "member-mm-voice-turn",
            "A MiniMax voice exchange settled in chat " + chatId + " and its reply was stamped as spoken");
        }
      } finally { store.close(); }
    } catch (error) {
      try {
        recordActivity(root, member.profile, "member-mm-voice-stamp-failed",
          "The voice reply stamp could not be written for chat " + chatId + ": " + (error instanceof Error ? error.message : String(error)).slice(0, 160));
      } catch { /* the ledger never masks the turn */ }
    }
  })();
}

/** One full MiniMax voice turn, door side: transcribe the
 *  utterance, then run the words as a normal chat turn in the
 *  member's own chat (queue, source "voice"). Returns as soon
 *  as the turn is queued - the app watches the thread for the
 *  reply and asks the speak route for each sentence. The chat
 *  must be the member's own, checked here as well as at the
 *  door, so no caller can speak into another member's world. */
export async function startMmVoiceTurn(
  root: string,
  member: Member,
  chatId: string,
  audio: { bytes: Buffer; filename: string; mime: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: MmFetch = realFetch,
  driveTurn: (content: string) => EnqueueResult = (content) =>
    enqueueChatMessage(root, { chatId, content, source: "voice" }),
): Promise<MmVoiceTurnResult> {
  const store = new ChatStore(root);
  let beforeIds = new Set<string>();
  try {
    const chat = store.get(chatId);
    if (!chat || chat.agent_name !== member.profile) throw new Error("No such chat.");
    beforeIds = new Set(store.messages(chatId).map(m => m.id));
  } finally { store.close(); }

  const transcript = await transcribeUtterance(root, member, audio, env, fetchFn);

  // Cannot-think states answer directly in the chat, the same
  // words the typed path gives: the exchange is saved as a real
  // voice exchange and the app speaks the reply like any other.
  const block = memberThinkBlock(root, member, env);
  if (block) {
    const save = new ChatStore(root);
    try {
      save.add(chatId, "user", transcript, "voice");
      save.add(chatId, "assistant", block, "voice");
    } finally { save.close(); }
    recordActivity(root, member.profile, "member-mm-voice-turn",
      "A MiniMax voice turn in chat " + chatId + " was answered with the plain cannot-think words");
    return { transcript, reply: block };
  }

  const result = driveTurn(transcript);
  if (result.effect === "status" && result.reply) {
    watchVoiceReply(root, member, chatId, beforeIds, transcript);
    return { transcript, reply: result.reply };
  }
  if (result.effect) {
    return {
      transcript,
      effect: result.effect,
      note: result.effect === "stop"
        ? "Heard that as a stop, so nothing was sent to SAM."
        : "Heard that as a nevermind, so nothing was sent to SAM.",
    };
  }
  watchVoiceReply(root, member, chatId, beforeIds, transcript);
  return { transcript };
}

/** Dictation (Dip, 2026-11-16: "put the dictation right inside
 *  the app... put that right inside the chat"): the mic inside
 *  the chat composer. It spends the same ASR call as a voice
 *  turn and that is ALL it does: the words come back as text
 *  for the composer, no turn is run, nothing is saved to the
 *  chat by the door, and no speech is made. The member reads
 *  the words, fixes them, and sends them like anything typed.
 *  Ownership is re-checked here as well as at the door, the
 *  same discipline as startMmVoiceTurn, and the spend is
 *  ledgered by transcribeUtterance plus the line below. */
export async function dictateTranscript(
  root: string,
  member: Member,
  chatId: string,
  audio: { bytes: Buffer; filename: string; mime: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: MmFetch = realFetch,
): Promise<string> {
  const store = new ChatStore(root);
  try {
    const chat = store.get(chatId);
    if (!chat || chat.agent_name !== member.profile) throw new Error("No such chat.");
  } finally { store.close(); }
  const transcript = await transcribeUtterance(root, member, audio, env, fetchFn);
  recordActivity(root, member.profile, "member-dictate",
    "An utterance was dictated into the composer of chat " + chatId + " (" + transcript.length + " characters heard); no turn was run and nothing was saved");
  return transcript;
}

import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { memberHasVoiceKey, type Member } from "./members.js";
import { memberFileView } from "./member-sam.js";
import { getVaultCredentialValue } from "./vault.js";

// Real-time voice for members (Dip ruling 2026-11-16): a member can
// TALK to their SAM, live, and the call rides the member's OWN
// OpenAI key - never the house key, never another member's. The
// key never leaves this server: the door spends it on exactly one
// thing, minting a short-lived ephemeral client secret from
// OpenAI's Realtime API (POST /v1/realtime/client_secrets, GA
// shape), and the browser receives only that secret, the model,
// and the expiry. The browser then carries its own WebRTC call to
// OpenAI with the secret; the media never passes through the door.
//
// The session is seeded with who this SAM is for this member:
// their SOUL standing file (or the starter persona), the profile's
// own instructions, and a short digest of the chat so far, so the
// voice picks the conversation up instead of starting cold. V1 is
// honest about its edges: voice is for talking. Building,
// research, and anything that needs a tool stays in the text chat,
// and the session instructions tell the voice SAM to say exactly
// that rather than fake work it cannot do.

export const VOICE_KEY_MISSING = "voice-key-missing";
export const VOICE_TRANSCRIPT_MAX_ENTRIES = 100;
export const VOICE_TRANSCRIPT_MAX_CHARS = 8000;

export interface VoiceConfig {
  /** Base for the OpenAI API; SAM_OPENAI_BASE_URL exists so the
   *  proof rig can point the door at a local stub of the
   *  client-secrets endpoint - production leaves it unset. */
  baseUrl: string;
  model: string;
  voice: string;
  transcribeModel: string;
}
export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const base = (env.SAM_OPENAI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return {
    baseUrl: base || "https://api.openai.com",
    model: (env.SAM_MEMBER_VOICE_MODEL ?? "").trim() || "gpt-realtime-2.1",
    voice: (env.SAM_MEMBER_VOICE ?? "").trim() || "marin",
    transcribeModel: (env.SAM_MEMBER_VOICE_TRANSCRIBE_MODEL ?? "").trim() || "gpt-4o-mini-transcribe",
  };
}

const VOICE_HONESTY = [
  "You are talking out loud, in real time. Keep answers short and spoken, a sentence or two at a time, the way people actually talk.",
  "Voice is for talking. You cannot build artifacts, run research, or use tools while on a call - that work happens in the text chat. " +
  "If they ask for something like that, do not pretend: say plainly that you will handle it in the chat, and tell them to type it there when the call ends. " +
  "Everything said on this call is saved into the chat, so the conversation continues there without repeating anything.",
].join("\n");

const CONTEXT_LINES = 14;
const CONTEXT_CHARS = 4000;

/** The instructions a voice session opens with: this member's
 *  SAM, in this member's words, with the chat so far in view. */
export function voiceInstructions(root: string, member: Member, chatId: string): string {
  const soul = memberFileView(root, member, "soul").content.trim();
  const parts: string[] = [soul || memberInstructionsFallback(member.person), VOICE_HONESTY];
  const store = new ChatStore(root);
  try {
    const chat = store.get(chatId);
    if (chat && chat.agent_name === member.profile) {
      const lines: string[] = [];
      let used = 0;
      for (const m of store.messages(chatId).slice(-CONTEXT_LINES)) {
        const text = m.content.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const line = (m.role === "user" ? member.person + ": " : "SAM: ") + text.slice(0, 600);
        if (used + line.length > CONTEXT_CHARS) break;
        lines.push(line);
        used += line.length;
      }
      if (lines.length) {
        parts.push("The conversation so far, most recent last:\n" + lines.join("\n"));
      }
    }
  } finally { store.close(); }
  return parts.join("\n\n");
}
function memberInstructionsFallback(person: string): string {
  return "You are SAM (Secret Agent Man), the personal AI assistant for " + person + ". Speak in plain words, no jargon.";
}

export interface VoiceSession {
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string;
  /** Where the browser posts its SDP offer, with the ephemeral
   *  secret as the bearer. Same base the mint rode. */
  callsUrl: string;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;

/** Mint a voice session for one of the member's own chats. The
 *  member's key is read from the vault here and only here; the
 *  use is ledgered (vault-use, name and purpose only, never the
 *  value, never the minted secret). Throws plain-word errors:
 *  VOICE_KEY_MISSING when there is no key to spend. */
export async function mintVoiceSession(
  root: string,
  member: Member,
  chatId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<VoiceSession> {
  if (member.status !== "active") throw new Error("This account is paused. Talk to the operator to turn it back on.");
  if (!memberHasVoiceKey(root, member) || !member.voiceKeyName) {
    const err = new Error("Voice needs your OpenAI key first. Add it in Settings and Talk is ready.");
    (err as { code?: string }).code = VOICE_KEY_MISSING;
    throw err;
  }
  const key = getVaultCredentialValue(root, member.voiceKeyName);
  if (!key) {
    const err = new Error("Voice needs your OpenAI key first. Add it in Settings and Talk is ready.");
    (err as { code?: string }).code = VOICE_KEY_MISSING;
    throw err;
  }
  const cfg = voiceConfig(env);
  const instructions = voiceInstructions(root, member, chatId);
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(cfg.baseUrl + "/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: cfg.model,
          instructions,
          audio: {
            input: { transcription: { model: cfg.transcribeModel } },
            output: { voice: cfg.voice },
          },
        },
      }),
    });
  } catch {
    throw new Error("OpenAI could not be reached to start the call. Try again in a moment.");
  }
  if (!res.ok) {
    // The response body stays out of every surface and log: the
    // status alone is the fact a member needs.
    throw new Error("OpenAI would not start a voice session (HTTP " + res.status + "). Check the voice key in Settings and try again.");
  }
  const data = (await res.json().catch(() => null)) as { value?: unknown; expires_at?: unknown } | null;
  const secret = data && typeof data.value === "string" ? data.value : "";
  if (!secret) throw new Error("OpenAI did not hand back a session secret. Try again in a moment.");
  recordActivity(root, member.profile, "vault-use",
    "Vault credential " + member.voiceKeyName + " used to mint a member voice session (" + cfg.model + ")");
  recordActivity(root, member.profile, "member-voice-session", "A voice session was minted for chat " + chatId + " (model " + cfg.model + ")");
  return {
    clientSecret: secret,
    expiresAt: data && typeof data.expires_at === "number" ? data.expires_at : null,
    model: cfg.model,
    voice: cfg.voice,
    callsUrl: cfg.baseUrl + "/v1/realtime/calls",
  };
}

export interface VoiceTranscriptEntry { role: "user" | "assistant"; content: string }

/** Save a finished call's transcript into the chat it belongs to.
 *  Rows ride the chat store with the "voice" provenance stamp, so
 *  the conversation continues in text exactly where the call left
 *  off, and every surface can see these words were spoken. The
 *  chat must be the member's own - checked here, not just at the
 *  door, so no caller can append to another member's world. */
export function saveVoiceTranscript(
  root: string,
  member: Member,
  chatId: string,
  entries: VoiceTranscriptEntry[],
): { saved: number } {
  const clean: VoiceTranscriptEntry[] = [];
  for (const entry of Array.isArray(entries) ? entries.slice(0, VOICE_TRANSCRIPT_MAX_ENTRIES) : []) {
    if (!entry || (entry.role !== "user" && entry.role !== "assistant")) continue;
    const content = typeof entry.content === "string" ? entry.content.trim().slice(0, VOICE_TRANSCRIPT_MAX_CHARS) : "";
    if (content) clean.push({ role: entry.role, content });
  }
  const store = new ChatStore(root);
  try {
    const chat = store.get(chatId);
    if (!chat || chat.agent_name !== member.profile) throw new Error("No such chat.");
    for (const entry of clean) store.add(chatId, entry.role, entry.content, "voice");
  } finally { store.close(); }
  if (clean.length) {
    recordActivity(root, member.profile, "member-voice-transcript",
      "A voice call transcript was saved to chat " + chatId + " (" + clean.length + " lines)");
  }
  return { saved: clean.length };
}

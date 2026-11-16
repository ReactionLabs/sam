import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveMemberDoor } from "./member-door.js";
import {
  findOrCreateMember, memberByEmail, memberView, mintMagicToken, setMemberKey, setMemberStatus,
} from "./members.js";
import {
  MM_KEY_MISSING, MM_KEY_NOT_MINIMAX, speechText, splitSentences, startMmVoiceTurn,
  synthesizeSpeech, transcribeUtterance,
} from "./member-mm-voice.js";
import { ChatStore } from "./chats.js";

// Voice on the member's MiniMax key (Dip, 2026-11-16): MiniMax
// has no realtime speech-to-speech, so this mode stitches ASR ->
// an ordinary chat turn -> sentence-by-sentence TTS on the ONE
// key the member already has. These tests pin the wire shapes
// against stub fetches (URLs, the member's key on the auth
// header, the models), the gating (no key / wrong kind of key),
// the speech cleaning, and the voice stamp the exchange lands
// with. The live loop on a real key is proven on the box.

const CHAT_KEY = "sk-mm-secret-abcdef1234567890";
const FAKE_MP3 = Buffer.from("fake mp3 bytes for a spoken sentence");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-mm-voice-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  return root;
}
function ownChatId(root: string, profile: string): string {
  const store = new ChatStore(root);
  try { return store.list().filter(c => c.agent_name === profile)[0].id; }
  finally { store.close(); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("gating: no key and the wrong kind of key are refused in plain, coded words", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "gate@example.com");
    const fresh = () => memberByEmail(root, "gate@example.com")!;
    const audio = { bytes: Buffer.from("wav"), filename: "speech.wav", mime: "audio/wav" };
    const noFetch = async (): Promise<never> => { throw new Error("fetch must not run without a key"); };
    await assert.rejects(transcribeUtterance(root, fresh(), audio, {}, noFetch),
      (err: Error & { code?: string }) => err.code === MM_KEY_MISSING && /MiniMax key first/.test(err.message));
    await assert.rejects(synthesizeSpeech(root, fresh(), "Hello there.", {}, noFetch),
      (err: Error & { code?: string }) => err.code === MM_KEY_MISSING);
    assert.equal(memberView(root, fresh()).hasMmVoice, false);

    // A custom-endpoint key is not a MiniMax key: it cannot buy
    // MiniMax speech, and the view does not light the mode up.
    setMemberKey(root, fresh(), { apiKey: CHAT_KEY, kind: "custom", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "stub-1" });
    await assert.rejects(transcribeUtterance(root, fresh(), audio, {}, noFetch),
      (err: Error & { code?: string }) => err.code === MM_KEY_NOT_MINIMAX && /points somewhere else/.test(err.message));
    assert.equal(memberView(root, fresh()).hasMmVoice, false);

    // The MiniMax key lights it up with no extra deposit.
    setMemberKey(root, fresh(), { apiKey: CHAT_KEY });
    assert.equal(memberView(root, fresh()).hasMmVoice, true);
    setMemberStatus(root, member.id, "disabled");
    await assert.rejects(transcribeUtterance(root, fresh(), audio, {}, noFetch), /paused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ASR: the member's key rides the auth header, the model is asr-1.0, words come back", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "asr@example.com");
    setMemberKey(root, member, { apiKey: CHAT_KEY });
    const fresh = () => memberByEmail(root, "asr@example.com")!;
    let seenUrl = "";
    let seenAuth = "";
    let seenModel = "";
    let seenFile = "";
    const transcript = await transcribeUtterance(root, fresh(),
      { bytes: Buffer.from("recorded wav bytes"), filename: "speech.wav", mime: "audio/wav" }, {},
      async (url, init) => {
        seenUrl = url;
        seenAuth = String((init.headers as Record<string, string>).authorization ?? "");
        const form = init.body as FormData;
        seenModel = String(form.get("model") ?? "");
        seenFile = (form.get("file") as File | null)?.name ?? "";
        return { ok: true, status: 200, json: async () => ({ data: { text: "  What is the ferry schedule? " } }), text: async () => "" };
      });
    assert.equal(transcript, "What is the ferry schedule?");
    assert.equal(seenUrl, "https://api.minimax.io/v1/speech_to_text");
    assert.equal(seenAuth, "Bearer " + CHAT_KEY);
    assert.equal(seenModel, "asr-1.0");
    assert.equal(seenFile, "speech.wav");
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /vault-use/);
    assert.match(ledger, /member-mm-voice-asr/);
    assert.equal(ledger.includes(CHAT_KEY), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ASR refusals stay plain: the format verdict names the format, other refusals name only the status", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "asr-no@example.com");
    setMemberKey(root, member, { apiKey: CHAT_KEY });
    const fresh = () => memberByEmail(root, "asr-no@example.com")!;
    const audio = { bytes: Buffer.from("webm"), filename: "speech.webm", mime: "audio/webm" };
    await assert.rejects(
      transcribeUtterance(root, fresh(), audio, {}, async () => ({
        ok: false, status: 400,
        json: async () => ({ type: "error", error: { type: "bad_request_error", message: "invalid params, unsupported audio format \"matroska,webm\", supported: wav, mp3, ogg (2013)" } }),
        text: async () => "",
      })),
      (err: Error) => /recording format/.test(err.message) && !err.message.includes("matroska"),
    );
    await assert.rejects(
      transcribeUtterance(root, fresh(), audio, {}, async () => ({
        ok: false, status: 500,
        json: async () => ({ error: { message: "internal canary CANARY_MM" } }),
        text: async () => "",
      })),
      (err: Error) => /HTTP 500/.test(err.message) && !err.message.includes("CANARY"),
    );
    await assert.rejects(
      transcribeUtterance(root, fresh(), audio, {}, async () => ({
        ok: true, status: 200, json: async () => ({ data: { text: "   " } }), text: async () => "",
      })),
      /could not make out any words/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TTS: one sentence in, mp3 bytes out, markdown cleaned before it is spoken", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "tts@example.com");
    setMemberKey(root, member, { apiKey: CHAT_KEY });
    const fresh = () => memberByEmail(root, "tts@example.com")!;
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const spoken = await synthesizeSpeech(root, fresh(), "The **first ferry** leaves at [six](https://example.com).", {},
      async (url, init) => {
        seenUrl = url;
        seenAuth = String((init.headers as Record<string, string>).authorization ?? "");
        seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          ok: true, status: 200,
          json: async () => ({ data: { audio: FAKE_MP3.toString("hex") }, base_resp: { status_code: 0, status_msg: "success" } }),
          text: async () => "",
        };
      });
    assert.equal(seenUrl, "https://api.minimax.io/v1/t2a_v2");
    assert.equal(seenAuth, "Bearer " + CHAT_KEY);
    assert.equal(seenBody.model, "speech-2.8-turbo");
    assert.equal(seenBody.text, "The first ferry leaves at six.");
    assert.equal((seenBody.voice_setting as { voice_id: string }).voice_id, "male-qn-qingse");
    assert.deepEqual(spoken.audio, FAKE_MP3);
    assert.equal(spoken.mime, "audio/mpeg");
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /member-mm-voice-tts/);
    assert.equal(ledger.includes(CHAT_KEY), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("speech cleaning and sentence splitting behave for eyes-only content", () => {
  const raw = "Here is the plan.\n\n- First, check the **harbor** report [1].\n- Then read `the tide table`.\n\n```js\nconst x = 1;\n```\n\nSources: [1] agent-reach web search: harbor news";
  const clean = speechText(raw);
  assert.equal(clean.includes("const x"), false);
  assert.equal(clean.includes("Sources"), false);
  assert.equal(clean.includes("[1]"), false);
  assert.equal(clean.includes("**"), false);
  assert.match(clean, /check the harbor report/);
  assert.match(clean, /read the tide table/);
  const sentences = splitSentences("First ferry leaves at six. Then it runs hourly until nine tonight! Are you coming?");
  assert.deepEqual(sentences, [
    "First ferry leaves at six.",
    "Then it runs hourly until nine tonight!",
    "Are you coming?",
  ]);
  assert.deepEqual(splitSentences("   "), []);
  const long = splitSentences("One very long sentence, with a great many clauses, each adding a little more detail, and still more after that, until the whole thing runs well past what one breath should have to carry in a single spoken chunk of reply text today, and then it keeps going with another clause about the harbor, the ferries, the tide tables, the weather rolling in off the bay, and every small thing a careful answer would want to mention before it finally stops.");
  assert.ok(long.length >= 2 && long.every(s => s.length <= 300), "run-on replies are cut into breath-sized chunks: " + long.map(s => s.length).join(","));
});

test("a voice turn transcribes, drives the turn, and the exchange lands stamped voice", async () => {
  const root = tempRoot();
  try {
    const a = findOrCreateMember(root, "turn-a@example.com").member;
    const b = findOrCreateMember(root, "turn-b@example.com").member;
    setMemberKey(root, a, { apiKey: CHAT_KEY });
    const freshA = () => memberByEmail(root, "turn-a@example.com")!;
    const chatId = ownChatId(root, a.profile);
    const asrFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { text: "What is the ferry schedule?" } }),
      text: async () => "",
    });
    // The fake driver stands in for the queue drain: it saves the
    // exchange the way runChatTurn does (user row stamped by the
    // turn's source, assistant row with the default stamp) so the
    // watcher has exactly the real shape to finish.
    const result = await startMmVoiceTurn(root, freshA(), chatId,
      { bytes: Buffer.from("wav"), filename: "speech.wav", mime: "audio/wav" }, {}, asrFetch,
      (content) => {
        const store = new ChatStore(root);
        try {
          store.add(chatId, "user", content, "voice");
          store.add(chatId, "assistant", "First ferry leaves at six, then hourly.");
        } finally { store.close(); }
        return { id: "fake-item", status: "queued" as const };
      });
    assert.equal(result.transcript, "What is the ferry schedule?");
    assert.equal(result.reply, undefined);
    // The watcher settles asynchronously; poll for the stamp.
    let stamped = false;
    for (let i = 0; i < 80 && !stamped; i++) {
      const store = new ChatStore(root);
      try {
        const rows = store.messages(chatId).filter(m => m.content.includes("ferry"));
        stamped = rows.length === 2 && rows.every(m => m.source === "voice");
      } finally { store.close(); }
      if (!stamped) await sleep(25);
    }
    assert.equal(stamped, true);
    // Another member cannot start a voice turn in this chat.
    setMemberKey(root, b, { apiKey: CHAT_KEY });
    await assert.rejects(
      startMmVoiceTurn(root, memberByEmail(root, "turn-b@example.com")!, chatId,
        { bytes: Buffer.from("wav"), filename: "speech.wav", mime: "audio/wav" }, {}, asrFetch),
      /No such chat/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Through the door, against a stub MiniMax ---------------------

let stub: Server;
let root = "";
let door: { port: number; close: () => Promise<void> } | null = null;
let base = "";
const savedEnv: Record<string, string | undefined> = {};

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: "Bearer " + opts.token } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function signIn(email: string): Promise<{ token: string; chatId: string }> {
  const { member } = findOrCreateMember(root, email);
  const raw = mintMagicToken(root, member);
  const redeemed = await api("/auth/redeem", { method: "POST", body: { token: raw } });
  assert.equal(redeemed.status, 200);
  return { token: String(redeemed.json.sessionToken), chatId: ownChatId(root, member.profile) };
}

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_MEMBER_DOOR_OFF", "SAM_MEMBER_MM_BASE_URL"]) savedEnv[k] = process.env[k];
  delete process.env.SAM_MODEL_API_KEY;
  delete process.env.SAM_MEMBER_DOOR_OFF;
  root = mkdtempSync(join(tmpdir(), "sam-mm-voice-door-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      if (req.url === "/v1/t2a_v2") {
        if (String(req.headers.authorization ?? "") !== "Bearer " + CHAT_KEY) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "stub refuses this key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { audio: FAKE_MP3.toString("hex") }, base_resp: { status_code: 0, status_msg: "success" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such stub route" }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  process.env.SAM_MEMBER_MM_BASE_URL = "http://127.0.0.1:" + (stub.address() as { port: number }).port;
  door = await serveMemberDoor(root, { port: 19349 });
  base = "http://127.0.0.1:" + door.port;
});

test.after(async () => {
  if (door) await door.close();
  stub.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("door: MiniMax speak round-trip, gating, isolation, and the /me flag", async () => {
  const a = await signIn("door-mm-a@example.com");
  const memberA = memberByEmail(root, "door-mm-a@example.com")!;
  // No key yet: /me keeps the mode dark and both routes refuse
  // with the coded plain reason.
  const me0 = await api("/me", { token: a.token });
  assert.equal((me0.json.member as { hasMmVoice: boolean }).hasMmVoice, false);
  const speakEarly = await api("/chats/" + a.chatId + "/mm-voice/speak", { method: "POST", token: a.token, body: { text: "Hello there." } });
  assert.equal(speakEarly.status, 400);
  assert.equal(speakEarly.json.code, MM_KEY_MISSING);
  const turnEarly = await api("/chats/" + a.chatId + "/mm-voice", {
    method: "POST", token: a.token,
    body: { audio: Buffer.from("wav").toString("base64"), filename: "speech.wav", mime: "audio/wav" },
  });
  assert.equal(turnEarly.status, 400);
  assert.equal(turnEarly.json.code, MM_KEY_MISSING);

  // With the MiniMax chat key saved, /me lights the mode and the
  // speak route returns the stub's audio, base64 in JSON, with
  // the member's key spent server-side only.
  setMemberKey(root, memberA, { apiKey: CHAT_KEY });
  const me1 = await api("/me", { token: a.token });
  assert.equal((me1.json.member as { hasMmVoice: boolean }).hasMmVoice, true);
  assert.equal(JSON.stringify(me1.json).includes(CHAT_KEY), false);
  const spoken = await api("/chats/" + a.chatId + "/mm-voice/speak", { method: "POST", token: a.token, body: { text: "First ferry leaves at six." } });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.json.mime, "audio/mpeg");
  assert.deepEqual(Buffer.from(String(spoken.json.audio), "base64"), FAKE_MP3);
  assert.equal(JSON.stringify(spoken.json).includes(CHAT_KEY), false);

  // A custom key cannot carry MiniMax voice through the door.
  const c = await signIn("door-mm-c@example.com");
  setMemberKey(root, memberByEmail(root, "door-mm-c@example.com")!, {
    apiKey: CHAT_KEY, kind: "custom", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "stub-1",
  });
  const speakCustom = await api("/chats/" + c.chatId + "/mm-voice/speak", { method: "POST", token: c.token, body: { text: "Hello there." } });
  assert.equal(speakCustom.status, 400);
  assert.equal(speakCustom.json.code, MM_KEY_NOT_MINIMAX);

  // Isolation: member B gets the same 404 as a missing chat on
  // both routes, and no credential at all gets a 401.
  const b = await signIn("door-mm-b@example.com");
  const foreignSpeak = await api("/chats/" + a.chatId + "/mm-voice/speak", { method: "POST", token: b.token, body: { text: "intruder" } });
  assert.equal(foreignSpeak.status, 404);
  const foreignTurn = await api("/chats/" + a.chatId + "/mm-voice", {
    method: "POST", token: b.token,
    body: { audio: Buffer.from("wav").toString("base64"), filename: "speech.wav", mime: "audio/wav" },
  });
  assert.equal(foreignTurn.status, 404);
  assert.equal((await api("/chats/" + a.chatId + "/mm-voice/speak", { method: "POST", body: { text: "x" } })).status, 401);
});

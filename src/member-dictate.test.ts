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
  findOrCreateMember, memberByEmail, mintMagicToken, setMemberKey,
} from "./members.js";
import { dictateTranscript, MM_KEY_MISSING, MM_KEY_NOT_MINIMAX } from "./member-mm-voice.js";
import { ChatStore } from "./chats.js";
import { listChatQueue } from "./chat-queue.js";

// Dictation (Dip, 2026-11-16): the mic inside the chat composer.
// The route is the text-only sibling of the MiniMax voice turn:
// one utterance in, ONLY its transcript out. These tests pin the
// shape that makes it dictation and not a voice turn - no chat
// rows are saved, no turn is queued, nothing is spoken - plus
// the standing member fences (own key only, foreign chat 404,
// no key refused in coded plain words, the key never surfaces).

const CHAT_KEY = "sk-mm-secret-abcdef1234567890";
const HEARD = "Remind me to call the harbor office at nine.";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-dictate-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  return root;
}
function ownChatId(root: string, profile: string): string {
  const store = new ChatStore(root);
  try { return store.list().filter(c => c.agent_name === profile)[0].id; }
  finally { store.close(); }
}
function messageCount(root: string, chatId: string): number {
  const store = new ChatStore(root);
  try { return store.messages(chatId).length; }
  finally { store.close(); }
}
const asrFetch = (text: string) => async () => ({
  ok: true, status: 200,
  json: async () => ({ data: { text } }),
  text: async () => "",
});

test("module: dictation returns the words and leaves the chat exactly as it was", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "dict-module@example.com");
    setMemberKey(root, member, { apiKey: CHAT_KEY });
    const fresh = () => memberByEmail(root, "dict-module@example.com")!;
    const chatId = ownChatId(root, member.profile);
    assert.equal(messageCount(root, chatId), 0);
    const transcript = await dictateTranscript(root, fresh(), chatId,
      { bytes: Buffer.from("recorded wav bytes"), filename: "speech.wav", mime: "audio/wav" }, {}, asrFetch("  " + HEARD + " "));
    assert.equal(transcript, HEARD);
    // The whole point: no turn ran and nothing was saved.
    assert.equal(messageCount(root, chatId), 0);
    assert.equal(listChatQueue(root, chatId).length, 0);
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /vault-use/);
    assert.match(ledger, /member-dictate/);
    assert.equal(ledger.includes(CHAT_KEY), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("module: dictation refuses a foreign chat and a missing or wrong-kind key", async () => {
  const root = tempRoot();
  try {
    const a = findOrCreateMember(root, "dict-a@example.com").member;
    const b = findOrCreateMember(root, "dict-b@example.com").member;
    const audio = { bytes: Buffer.from("wav"), filename: "speech.wav", mime: "audio/wav" };
    const noFetch = async (): Promise<never> => { throw new Error("fetch must not run when refused"); };
    const chatA = ownChatId(root, a.profile);
    // No key at all: coded plain refusal, before any ASR spend.
    await assert.rejects(dictateTranscript(root, memberByEmail(root, "dict-a@example.com")!, chatA, audio, {}, noFetch),
      (err: Error & { code?: string }) => err.code === MM_KEY_MISSING);
    // A custom-endpoint key cannot buy MiniMax transcription.
    setMemberKey(root, a, { apiKey: CHAT_KEY, kind: "custom", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "stub-1" });
    await assert.rejects(dictateTranscript(root, memberByEmail(root, "dict-a@example.com")!, chatA, audio, {}, noFetch),
      (err: Error & { code?: string }) => err.code === MM_KEY_NOT_MINIMAX);
    // Member B, key in hand, still cannot dictate into A's chat.
    setMemberKey(root, b, { apiKey: CHAT_KEY });
    await assert.rejects(dictateTranscript(root, memberByEmail(root, "dict-b@example.com")!, chatA, audio, {}, asrFetch(HEARD)),
      /No such chat/);
    assert.equal(messageCount(root, chatA), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Through the door, against a stub MiniMax ---------------------

let stub: Server;
let root = "";
let door: { port: number; close: () => Promise<void> } | null = null;
let base = "";
let stubAuth = "";
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
const dictateBody = { audio: Buffer.from("recorded wav bytes").toString("base64"), filename: "speech.wav", mime: "audio/wav" };

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_MEMBER_DOOR_OFF", "SAM_MEMBER_MM_BASE_URL"]) savedEnv[k] = process.env[k];
  delete process.env.SAM_MODEL_API_KEY;
  delete process.env.SAM_MEMBER_DOOR_OFF;
  root = mkdtempSync(join(tmpdir(), "sam-dictate-door-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      if (req.url === "/v1/speech_to_text") {
        stubAuth = String(req.headers.authorization ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { text: HEARD } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such stub route" }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  process.env.SAM_MEMBER_MM_BASE_URL = "http://127.0.0.1:" + (stub.address() as { port: number }).port;
  door = await serveMemberDoor(root, { port: 19355 });
  base = "http://127.0.0.1:" + door.port;
});

test.after(async () => {
  if (door) await door.close();
  stub.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("door: dictation returns only the transcript and saves nothing", async () => {
  const a = await signIn("door-dict-a@example.com");
  setMemberKey(root, memberByEmail(root, "door-dict-a@example.com")!, { apiKey: CHAT_KEY });
  const heard = await api("/chats/" + a.chatId + "/dictate", { method: "POST", token: a.token, body: dictateBody });
  assert.equal(heard.status, 200);
  assert.deepEqual(Object.keys(heard.json), ["transcript"]);
  assert.equal(heard.json.transcript, HEARD);
  assert.equal(stubAuth, "Bearer " + CHAT_KEY);
  assert.equal(JSON.stringify(heard.json).includes(CHAT_KEY), false);
  // Read the thread back through the door: dictation left no
  // rows and no queued work behind.
  const thread = await api("/chats/" + a.chatId, { token: a.token });
  assert.equal(thread.status, 200);
  assert.equal((thread.json.messages as unknown[]).length, 0);
  assert.equal((thread.json.queue as unknown[]).length, 0);
  assert.equal(messageCount(root, a.chatId), 0);
});

test("door: dictation gating and isolation match the other member routes", async () => {
  // No key: the coded plain refusal, before any ASR spend.
  const noKey = await signIn("door-dict-nokey@example.com");
  const refused = await api("/chats/" + noKey.chatId + "/dictate", { method: "POST", token: noKey.token, body: dictateBody });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, MM_KEY_MISSING);
  // A custom-endpoint key cannot carry dictation either.
  const custom = await signIn("door-dict-custom@example.com");
  setMemberKey(root, memberByEmail(root, "door-dict-custom@example.com")!, {
    apiKey: CHAT_KEY, kind: "custom", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "stub-1",
  });
  const refusedCustom = await api("/chats/" + custom.chatId + "/dictate", { method: "POST", token: custom.token, body: dictateBody });
  assert.equal(refusedCustom.status, 400);
  assert.equal(refusedCustom.json.code, MM_KEY_NOT_MINIMAX);
  // Isolation: member B dictating into member A's chat gets the
  // same 404 as a missing chat; no credential at all gets a 401.
  const a = await signIn("door-dict-owner@example.com");
  setMemberKey(root, memberByEmail(root, "door-dict-owner@example.com")!, { apiKey: CHAT_KEY });
  const b = await signIn("door-dict-other@example.com");
  setMemberKey(root, memberByEmail(root, "door-dict-other@example.com")!, { apiKey: CHAT_KEY });
  const foreign = await api("/chats/" + a.chatId + "/dictate", { method: "POST", token: b.token, body: dictateBody });
  assert.equal(foreign.status, 404);
  assert.equal((await api("/chats/" + a.chatId + "/dictate", { method: "POST", body: dictateBody })).status, 401);
  // An empty recording is refused in plain words, not transcribed.
  const empty = await api("/chats/" + a.chatId + "/dictate", { method: "POST", token: a.token, body: { audio: "", filename: "speech.wav", mime: "audio/wav" } });
  assert.equal(empty.status, 400);
  assert.match(String(empty.json.error), /did not arrive/);
});

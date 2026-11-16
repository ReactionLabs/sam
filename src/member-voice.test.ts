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
  findOrCreateMember, memberByEmail, memberView, mintMagicToken, removeMemberVoiceKey,
  setMemberKey, setMemberStatus, setMemberVoiceKey,
} from "./members.js";
import { mintVoiceSession, saveVoiceTranscript, VOICE_KEY_MISSING } from "./member-voice.js";
import { ChatStore } from "./chats.js";
import { getVaultCredentialValue, listVaultCredentials } from "./vault.js";
import { saveMemberFile } from "./member-sam.js";

// Real-time voice (Dip ruling 2026-11-16): the member's OpenAI key
// buys voice, the door spends it server-side on an ephemeral
// Realtime client secret, and the browser never sees the key.
// These tests prove the whole shape without a real OpenAI key: a
// local stub stands in for api.openai.com and asserts what it was
// handed; the injected-fetch unit tests pin the mint's payload.

const VOICE_KEY = "sk-voice-secret-abcdef1234567890";
const CHAT_KEY = "sk-chat-secret-abcdef1234567890";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-voice-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  return root;
}

test("the voice key is a second slot: it vaults apart from the chat key and never surfaces", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "voice@example.com");
    const fresh = () => memberByEmail(root, "voice@example.com")!;
    assert.equal(memberView(root, member).hasVoiceKey, false);

    setMemberKey(root, member, { apiKey: CHAT_KEY });
    const view = setMemberVoiceKey(root, fresh(), VOICE_KEY);
    assert.equal(view.hasKey, true);
    assert.equal(view.hasVoiceKey, true);
    // Two credentials, two names, each holding its own value.
    const creds = listVaultCredentials(root);
    assert.equal(creds.length, 2);
    assert.equal(JSON.stringify(view).includes(VOICE_KEY), false);
    assert.equal(JSON.stringify(view).includes(CHAT_KEY), false);
    const voiceName = creds.map(c => c.name).find(n => n.endsWith("-voice-key"))!;
    const chatName = creds.map(c => c.name).find(n => n.endsWith("-key") && !n.endsWith("-voice-key"))!;
    assert.equal(getVaultCredentialValue(root, voiceName), VOICE_KEY);
    assert.equal(getVaultCredentialValue(root, chatName), CHAT_KEY);
    assert.deepEqual(creds.find(c => c.name === voiceName)?.hosts, ["api.openai.com"]);
    // Removing the voice key leaves the chat key standing.
    const after = removeMemberVoiceKey(root, fresh());
    assert.equal(after.hasVoiceKey, false);
    assert.equal(after.hasKey, true);
    // An empty key is refused in plain words; a disabled account too.
    assert.throws(() => setMemberVoiceKey(root, fresh(), "  "), /Paste your OpenAI key first/);
    setMemberStatus(root, member.id, "disabled");
    assert.throws(() => setMemberVoiceKey(root, fresh(), VOICE_KEY), /disabled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the mint spends the member's key server-side and hands back only the secret", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "mint@example.com");
    const fresh = () => memberByEmail(root, "mint@example.com")!;
    setMemberVoiceKey(root, member, VOICE_KEY);
    saveMemberFile(root, fresh(), "soul", "You are SAM for a harbor master. Talk like a harbor master: tides first, small talk second.");
    const store = new ChatStore(root);
    let chatId = "";
    try {
      const chats = store.list().filter(c => c.agent_name === member.profile);
      chatId = chats[0].id;
      store.add(chatId, "user", "What is the ferry schedule tomorrow?");
      store.add(chatId, "assistant", "First ferry leaves at six, then hourly.");
    } finally { store.close(); }

    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const session = await mintVoiceSession(root, fresh(), chatId, {}, async (url, init) => {
      seenUrl = url; seenAuth = init.headers.authorization; seenBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ value: "ek_stub_secret", expires_at: 1899999999 }) };
    });
    assert.equal(seenUrl, "https://api.openai.com/v1/realtime/client_secrets");
    assert.equal(seenAuth, "Bearer " + VOICE_KEY);
    const cfg = seenBody.session as { type: string; model: string; instructions: string; audio: { input: { transcription: { model: string } }; output: { voice: string } } };
    assert.equal(cfg.type, "realtime");
    assert.equal(cfg.model, "gpt-realtime-2.1");
    assert.equal(cfg.audio.output.voice, "marin");
    assert.ok(cfg.audio.input.transcription.model.length > 0);
    // The persona is the member's SOUL; the chat so far rides
    // along; the v1 honesty line is in the instructions.
    assert.match(cfg.instructions, /harbor master/);
    assert.match(cfg.instructions, /ferry schedule/);
    assert.match(cfg.instructions, /Voice is for talking/);
    // Only the ephemeral secret comes back - never the key.
    assert.equal(session.clientSecret, "ek_stub_secret");
    assert.equal(session.expiresAt, 1899999999);
    assert.equal(session.callsUrl, "https://api.openai.com/v1/realtime/calls");
    assert.equal(JSON.stringify(session).includes(VOICE_KEY), false);
    // The use is ledgered by name and purpose only.
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /vault-use/);
    assert.equal(ledger.includes(VOICE_KEY), false);
    assert.equal(ledger.includes("ek_stub_secret"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no voice key, no mint - and an OpenAI refusal stays plain", async () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "nokey@example.com");
    const store = new ChatStore(root);
    let chatId = "";
    try { chatId = store.list().filter(c => c.agent_name === member.profile)[0].id; } finally { store.close(); }
    await assert.rejects(
      mintVoiceSession(root, member, chatId, {}, async () => { throw new Error("fetch must not run without a key"); }),
      (err: Error & { code?: string }) => err.code === VOICE_KEY_MISSING && /OpenAI key first/.test(err.message),
    );
    setMemberVoiceKey(root, memberByEmail(root, "nokey@example.com")!, VOICE_KEY);
    await assert.rejects(
      mintVoiceSession(root, memberByEmail(root, "nokey@example.com")!, chatId, {}, async () => ({
        ok: false, status: 401, json: async () => ({ error: { message: "bad key VOICE_KEY_LEAK_CANARY" } }),
      })),
      (err: Error) => /HTTP 401/.test(err.message) && !err.message.includes("CANARY"),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a call transcript lands in the chat as voice rows, and only in the owner's chat", () => {
  const root = tempRoot();
  try {
    const a = findOrCreateMember(root, "talker@example.com").member;
    const b = findOrCreateMember(root, "other@example.com").member;
    const store = new ChatStore(root);
    let chatId = "";
    try { chatId = store.list().filter(c => c.agent_name === a.profile)[0].id; } finally { store.close(); }
    const saved = saveVoiceTranscript(root, a, chatId, [
      { role: "user", content: "Remind me about the ferry." },
      { role: "assistant", content: "Six in the morning, then hourly." },
      { role: "user", content: "   " },
      { role: "assistant", content: "" },
    ]);
    assert.equal(saved.saved, 2);
    const store2 = new ChatStore(root);
    try {
      const rows = store2.messages(chatId).filter(m => m.source === "voice");
      assert.deepEqual(rows.map(m => [m.role, m.content]), [
        ["user", "Remind me about the ferry."],
        ["assistant", "Six in the morning, then hourly."],
      ]);
    } finally { store2.close(); }
    // Another member cannot append to this chat, and a stranger
    // chat id gets the same refusal as a missing one.
    assert.throws(() => saveVoiceTranscript(root, b, chatId, [{ role: "user", content: "intruder" }]), /No such chat/);
    assert.throws(() => saveVoiceTranscript(root, a, "no-such-chat", [{ role: "user", content: "x" }]), /No such chat/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Through the door, against a stub OpenAI ----------------------

let stub: Server;
let root = "";
let door: { port: number; close: () => Promise<void> } | null = null;
let base = "";
let stubAuth = "";
const savedEnv: Record<string, string | undefined> = {};

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: "Bearer " + opts.token } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function signIn(email: string): Promise<{ token: string }> {
  const { member } = findOrCreateMember(root, email);
  const raw = mintMagicToken(root, member);
  const redeemed = await api("/auth/redeem", { method: "POST", body: { token: raw } });
  assert.equal(redeemed.status, 200);
  return { token: String(redeemed.json.sessionToken) };
}

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_MEMBER_DOOR_OFF", "SAM_OPENAI_BASE_URL"]) savedEnv[k] = process.env[k];
  delete process.env.SAM_MODEL_API_KEY;
  delete process.env.SAM_MEMBER_DOOR_OFF;
  root = mkdtempSync(join(tmpdir(), "sam-voice-door-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      if (req.url === "/v1/realtime/client_secrets") {
        stubAuth = String(req.headers.authorization ?? "");
        if (stubAuth !== "Bearer " + VOICE_KEY) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stub refuses this key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: "ek_door_stub_secret", expires_at: 1899999999, session: { type: "realtime", model: "gpt-realtime-2.1" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such stub route" }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  process.env.SAM_OPENAI_BASE_URL = "http://127.0.0.1:" + (stub.address() as { port: number }).port;
  door = await serveMemberDoor(root, { port: 19347 });
  base = "http://127.0.0.1:" + door.port;
});

test.after(async () => {
  if (door) await door.close();
  stub.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("door: voice key round-trip, session mint against the stub, transcript save and read-back", async () => {
  const a = await signIn("door-voice@example.com");
  // No key yet: /me says so, and a mint attempt answers with the
  // plain reason and the code the app keys on.
  const me0 = await api("/me", { token: a.token });
  assert.equal((me0.json.member as { hasVoiceKey: boolean }).hasVoiceKey, false);
  const chats = await api("/chats", { token: a.token });
  const chatId = String((chats.json.chats as Array<{ id: string }>)[0].id);
  const early = await api("/me/voice/session", { method: "POST", token: a.token, body: { chatId } });
  assert.equal(early.status, 400);
  assert.equal(early.json.code, VOICE_KEY_MISSING);

  // Save the voice key through the door. The response shows the
  // slot filled and never the value.
  const savedKey = await api("/me/voice-key", { method: "POST", token: a.token, body: { apiKey: VOICE_KEY } });
  assert.equal(savedKey.status, 200);
  assert.equal((savedKey.json.member as { hasVoiceKey: boolean }).hasVoiceKey, true);
  assert.equal(JSON.stringify(savedKey.json).includes(VOICE_KEY), false);
  const me1 = await api("/me", { token: a.token });
  assert.equal(JSON.stringify(me1.json).includes(VOICE_KEY), false);

  // The mint: the stub saw the member's key server-side, and the
  // browser-side answer carries only the ephemeral secret.
  stubAuth = "";
  const minted = await api("/me/voice/session", { method: "POST", token: a.token, body: { chatId } });
  assert.equal(minted.status, 200);
  assert.equal(stubAuth, "Bearer " + VOICE_KEY);
  const session = minted.json.session as { clientSecret: string; model: string; callsUrl: string };
  assert.equal(session.clientSecret, "ek_door_stub_secret");
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.match(session.callsUrl, /\/v1\/realtime\/calls$/);
  assert.equal(JSON.stringify(minted.json).includes(VOICE_KEY), false);

  // The transcript save lands as voice rows in the thread.
  const saved = await api("/chats/" + chatId + "/voice-transcript", {
    method: "POST", token: a.token,
    body: { entries: [{ role: "user", content: "Ahoy, SAM." }, { role: "assistant", content: "Ahoy. First ferry is at six." }] },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved, 2);
  const thread = await api("/chats/" + chatId, { token: a.token });
  const voiceRows = (thread.json.messages as Array<{ role: string; content: string; source: string }>).filter(m => m.source === "voice");
  assert.deepEqual(voiceRows.map(m => m.content), ["Ahoy, SAM.", "Ahoy. First ferry is at six."]);

  // Isolation: member B cannot mint for A's chat nor append to it.
  const b = await signIn("door-voice-b@example.com");
  const foreignMint = await api("/me/voice/session", { method: "POST", token: b.token, body: { chatId } });
  assert.equal(foreignMint.status, 404);
  const foreignSave = await api("/chats/" + chatId + "/voice-transcript", { method: "POST", token: b.token, body: { entries: [{ role: "user", content: "intruder" }] } });
  assert.equal(foreignSave.status, 404);
  // And the voice routes demand a credential at all.
  assert.equal((await api("/me/voice/session", { method: "POST", body: { chatId } })).status, 401);
  assert.equal((await api("/me/voice-key", { method: "POST", body: { apiKey: VOICE_KEY } })).status, 401);

  // Removing the key closes the slot again.
  const removed = await api("/me/voice-key", { method: "DELETE", token: a.token });
  assert.equal((removed.json.member as { hasVoiceKey: boolean }).hasVoiceKey, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteCapTrip, recordSessionTurn, sessionCapReply, sessionCapStatus, sessionCaps, sessionUsageToday } from "./session-caps.js";
import { runChatTurn } from "./agent-turn.js";
import { ChatStore } from "./chats.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-caps-"));
}

const NOW = new Date("2026-11-09T15:00:00.000Z");
const TODAY = "2026-11-09T10:00:00.000Z";
const YESTERDAY = "2026-11-08T23:00:00.000Z";

test("session caps: defaults are generous, env overrides parse, garbage falls back, 0 disables", () => {
  assert.deepEqual(sessionCaps({}), { maxTurns: 100, maxTokens: 2_000_000 });
  assert.deepEqual(sessionCaps({ SAM_SESSION_MAX_TURNS: "5", SAM_SESSION_MAX_TOKENS: "9000" }), { maxTurns: 5, maxTokens: 9000 });
  assert.deepEqual(sessionCaps({ SAM_SESSION_MAX_TURNS: "soon", SAM_SESSION_MAX_TOKENS: "-3" }), { maxTurns: 100, maxTokens: 2_000_000 });
  const root = scratch();
  try {
    for (let i = 0; i < 5; i++) recordSessionTurn(root, { chatId: "c1", route: "chat", tokens: 10, at: TODAY });
    const disabled = sessionCapStatus(root, "c1", NOW, { SAM_SESSION_MAX_TURNS: "0", SAM_SESSION_MAX_TOKENS: "0" });
    assert.equal(disabled.capped, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session caps: only today's turns count, per chat", () => {
  const root = scratch();
  try {
    recordSessionTurn(root, { chatId: "c1", route: "chat", tokens: 500, at: YESTERDAY });
    recordSessionTurn(root, { chatId: "c1", route: "chat", tokens: 300, at: TODAY });
    recordSessionTurn(root, { chatId: "c2", route: "chat", tokens: 700, at: TODAY });
    const status = sessionCapStatus(root, "c1", NOW, {});
    assert.equal(status.turnsUsed, 1);
    assert.equal(status.tokensUsed, 300);
    assert.equal(status.capped, false);
    const usage = sessionUsageToday(root, NOW, {});
    assert.equal(usage.length, 2);
    assert.equal(usage[0].chatId, "c2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session caps: the turn cap and the token cap each trip, turns named first", () => {
  const root = scratch();
  try {
    for (let i = 0; i < 3; i++) recordSessionTurn(root, { chatId: "c1", route: "heartbeat", tokens: 10, at: TODAY });
    const byTurns = sessionCapStatus(root, "c1", NOW, { SAM_SESSION_MAX_TURNS: "3", SAM_SESSION_MAX_TOKENS: "100000" });
    assert.equal(byTurns.capped, true);
    assert.equal(byTurns.reason, "turns");
    recordSessionTurn(root, { chatId: "c2", route: "background", tokens: 6000, at: TODAY });
    const byTokens = sessionCapStatus(root, "c2", NOW, { SAM_SESSION_MAX_TURNS: "100", SAM_SESSION_MAX_TOKENS: "5000" });
    assert.equal(byTokens.capped, true);
    assert.equal(byTokens.reason, "tokens");
    const reply = sessionCapReply(byTokens);
    assert.match(reply, /session cap/);
    assert.match(reply, /6000 tokens/);
    assert.doesNotMatch(reply, /\*\*/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session caps: a cap trip ledgers once per chat per day", () => {
  const root = scratch();
  try {
    assert.equal(noteCapTrip(root, "c1", "chat", "turns", NOW), true);
    assert.equal(noteCapTrip(root, "c1", "chat", "turns", NOW), false);
    assert.equal(noteCapTrip(root, "c1", "chat", "turns", new Date("2026-11-10T00:30:00.000Z")), true);
    // A cap event is not a turn: usage stays at zero turns.
    assert.equal(sessionCapStatus(root, "c1", NOW, {}).turnsUsed, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session caps: runChatTurn closes gracefully at the cap with no model call", async () => {
  const root = scratch();
  const saved = { ...process.env };
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "dummy-key-not-real";
    process.env.SAM_SESSION_MAX_TURNS = "2";
    delete process.env.SAM_SESSION_MAX_TOKENS;
    const store = new ChatStore(root);
    const chat = store.create("Cap test");
    store.close();
    recordSessionTurn(root, { chatId: chat.id, route: "chat", tokens: 1200 });
    recordSessionTurn(root, { chatId: chat.id, route: "chat", tokens: 1300 });
    const reply = await runChatTurn(root, chat.id, "hello, are you there");
    assert.match(reply, /session cap/);
    assert.match(reply, /pausing/);
    // The exchange persisted, so the pause is visible in the chat itself.
    const check = new ChatStore(root);
    const messages = check.messages(chat.id);
    check.close();
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, reply);
    // One session-cap activity line for the day, even on a second refusal.
    await runChatTurn(root, chat.id, "and again");
    const activity = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.equal(activity.split("\n").filter(line => line.includes("session-cap")).length, 1);
    assert.ok(existsSync(join(root, ".sam", "session-caps.jsonl")));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

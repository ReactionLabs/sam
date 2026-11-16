import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatTurn, turnFailureNoteSummary } from "./agent-turn.js";
import { ChatStore } from "./chats.js";

// Turn-failure notes carry their cause (gap found 2026-11-16,
// hourly run 17:04 EST, the candidate the 16:04 run named):
// the turn-failure-note ledger line in agent-turn.ts took
// error.message alone, so a turn dying on transport in the
// note branch ledgered the bare undici wrapper beside a
// turn-failed line that (since 09:04) names the cause. The
// note line's reason now composes through errorReason (the
// 04:04 bridge seam) via turnFailureNoteSummary; the prefix,
// the 120-char reason cap, the note text posted into the
// chat, and the throw are untouched.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-notecause-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

const PREFIX = "Turn failure noted in chat 12345678: the owner reads one plain sentence in the chat (the raw error never reaches the owner); error: ";

test("a turn failure note summary names the transport cause behind the wrapper", () => {
  assert.equal(
    turnFailureNoteSummary("12345678-abcd", dnsErr()),
    PREFIX + "fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(turnFailureNoteSummary("12345678-abcd", err), PREFIX + "fetch failed: read (ECONNRESET)");
});

test("causeless errors and plain strings read exactly as before", () => {
  assert.equal(turnFailureNoteSummary("12345678-abcd", new Error("Unsafe model output")), PREFIX + "Unsafe model output");
  assert.equal(turnFailureNoteSummary("12345678-abcd", new Error("Model not configured")), PREFIX + "Model not configured");
  assert.equal(turnFailureNoteSummary("12345678-abcd", "plain string failure"), PREFIX + "plain string failure");
});

test("the reason keeps its 120-char cap even with a long cause chain", () => {
  const err = new TypeError("fetch failed", { cause: new Error("x".repeat(300)) });
  const summary = turnFailureNoteSummary("12345678-abcd", err);
  assert.equal(summary.length, PREFIX.length + 120);
  assert.ok(summary.startsWith(PREFIX + "fetch failed: xxx"));
});

test("no bot token leaks through a turn failure note summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = turnFailureNoteSummary("12345678-abcd", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a turn dying on a provider transport failure ledgers one note line naming the code, and no trace of the ask", async () => {
  const root = scratch();
  const savedEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "<redacted>";
    globalThis.fetch = async () => { throw dnsErr(); };
    const store = new ChatStore(root);
    const chat = store.create("Transport death note");
    store.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "my secret zebra phrase"), /Model connector network error/);
    const notes = ledger(root).filter(l => l.kind === "turn-failure-note");
    assert.equal(notes.length, 1, "exactly one note line for one dead turn");
    assert.match(notes[0].summary, /Model connector network error: ENOTFOUND/);
    assert.doesNotMatch(notes[0].summary, /getaddrinfo/, "the provider's sanitized cause carries the code only");
    assert.doesNotMatch(notes[0].summary, /api\.minimax\.io/, "no endpoint text enters the note line");
    assert.doesNotMatch(notes[0].summary, /zebra/, "the person's message content never enters the note line");
    const failures = ledger(root).filter(l => l.kind === "turn-failed");
    assert.equal(failures.length, 1, "the turn-failed sibling still lands exactly once");
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

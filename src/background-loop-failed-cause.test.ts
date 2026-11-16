import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { backgroundFailedSummary, backgroundFailureReason, drainBackgroundTasks, listBackgroundTasks, queueBackgroundTask } from "./background.js";
import { loopFailedSummary, revisitDueLoops } from "./loop-revisit.js";
import { listLoops, openLoop, updateOpenLoop } from "./loops.js";
import { readActivity } from "./activity.js";

// Background and loop failures carry their cause (gap found
// 2026-11-16, hourly run 12:04 EST): both turn seams took
// e.message alone, so a transport death ledgered the bare
// "fetch failed" wrapper. The summaries now compose through
// errorReason (the 04:04 bridge seam): causeless errors keep
// their plain message, a transport wrapper names its cause,
// and no bot token leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-bgloop-cause-"));
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a background failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    backgroundFailedSummary("Deep dive", dnsErr()),
    "Background task failed: Deep dive - fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
  assert.equal(backgroundFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    backgroundFailedSummary("Deep dive", err),
    "Background task failed: Deep dive - fetch failed: read (ECONNRESET)",
  );
});

test("causeless background errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(
    backgroundFailedSummary("Boom task", new Error("Model not configured")),
    "Background task failed: Boom task - Model not configured",
  );
  assert.equal(backgroundFailureReason("plain string failure"), "Background run failed");
  assert.equal(
    backgroundFailedSummary("Boom task", "plain string failure"),
    "Background task failed: Boom task - Background run failed",
  );
});

test("no bot token leaks through a background failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = backgroundFailedSummary("Deep dive", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a background failure reason slice caps at 120 in the ledger summary", () => {
  const summary = backgroundFailedSummary("T", new Error("x".repeat(400)));
  assert.equal(summary, "Background task failed: T - " + "x".repeat(120));
});

test("a drained task dying on transport carries its cause in the ledger line, the stored result, and the chat post - and never its prompt", async () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    const chatId = db.create("Desk", "trading").id;
    db.close();
    const task = queueBackgroundTask(root, { actor: "trading", chatId, prompt: "the owner's secret prompt wording", title: "Boom task" });
    const out = await drainBackgroundTasks(root, { runTurn: async () => { throw dnsErr(); } });
    assert.deepEqual(out.failed, [task.id]);
    const bad = listBackgroundTasks(root)[0];
    assert.equal(bad.status, "failed");
    assert.match(bad.result ?? "", /fetch failed: getaddrinfo ENOTFOUND api\.minimax\.io/);
    assert.equal((bad.result ?? "").includes("secret prompt"), false);
    const lines = readActivity(root, 50).filter(a => a.kind === "background-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Background task failed: Boom task - fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    assert.equal(lines[0].summary.includes("secret prompt"), false);
    const store = new ChatStore(root);
    try {
      const msgs = store.messages(chatId);
      assert.equal(msgs.length, 1);
      assert.match(msgs[0].content, /Background task failed: Boom task \(fetch failed: getaddrinfo ENOTFOUND api\.minimax\.io\)/);
      assert.equal(msgs[0].content.includes("secret prompt"), false);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a loop failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    loopFailedSummary("Is the stack restarted?", dnsErr()),
    "Open loop re-check failed, will look again later: Is the stack restarted? - fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
});

test("causeless loop errors and plain strings keep their plain message", () => {
  assert.equal(
    loopFailedSummary("Did the key land?", new Error("model down")),
    "Open loop re-check failed, will look again later: Did the key land? - model down",
  );
  assert.equal(
    loopFailedSummary("Did the key land?", "plain string failure"),
    "Open loop re-check failed, will look again later: Did the key land? - plain string failure",
  );
});

test("no bot token leaks through a loop failure summary, and a long reason caps at 120", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = loopFailedSummary("Q?", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
  const long = loopFailedSummary("Q?", new Error("x".repeat(400)));
  assert.equal(long, "Open loop re-check failed, will look again later: Q? - " + "x".repeat(120));
});

test("a re-check dying on transport ledgers exactly one loop-failed line carrying its cause, and the loop stays open rescheduled", async () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    const chatId = db.create("Main chat", null).id;
    db.close();
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "newest candidate advancing", dueInHours: 2 });
    const updated = updateOpenLoop(root, loop.id, { dueAt: new Date(Date.now() - 60_000).toISOString() });
    assert.ok(updated);
    const r = await revisitDueLoops(root, { runTurn: async () => { throw dnsErr(); } });
    assert.deepEqual(r.failed, [loop.id]);
    const lines = readActivity(root, 50).filter(a => a.kind === "loop-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Open loop re-check failed, will look again later: Is the stack restarted? - fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    const after = listLoops(root)[0];
    assert.equal(after.status, "open");
    assert.ok(Date.parse(after.dueAt) > Date.now(), "the failed re-check rescheduled the loop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

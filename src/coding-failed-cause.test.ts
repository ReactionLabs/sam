import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { codingFailedSummary, codingFailureReason, drainCodingTasks, listCodingTasks, queueCodingTask } from "./coding.js";
import { readActivity } from "./activity.js";

// Coding task failures carry their cause (gap found
// 2026-11-16, hourly run 16:04 EST): the drain's turn catch
// took e.message alone, so a transport death read the bare
// "fetch failed" wrapper in the stored result, the
// coding-failed ledger line, and the chat summary. The
// summaries now compose through errorReason (the 04:04
// bridge seam): causeless errors keep their plain message,
// a transport wrapper names its cause, and no bot token
// leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-coding-cause-"));
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a coding failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    codingFailedSummary("Fix the export", dnsErr()),
    "Coding task failed: Fix the export - fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
  assert.equal(codingFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    codingFailedSummary("Fix the export", err),
    "Coding task failed: Fix the export - fetch failed: read (ECONNRESET)",
  );
});

test("causeless coding errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(
    codingFailedSummary("Boom task", new Error("Model not configured")),
    "Coding task failed: Boom task - Model not configured",
  );
  assert.equal(codingFailureReason("plain string failure"), "Coding run failed");
  assert.equal(
    codingFailedSummary("Boom task", "plain string failure"),
    "Coding task failed: Boom task - Coding run failed",
  );
});

test("no bot token leaks through a coding failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = codingFailedSummary("Fix the export", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a coding failure reason slice caps at 120 in the ledger summary", () => {
  const summary = codingFailedSummary("T", new Error("x".repeat(400)));
  assert.equal(summary, "Coding task failed: T - " + "x".repeat(120));
});

test("a drained coding task dying on transport carries its cause in the ledger line, the stored result, and the chat summary - and the stored result carries no spec text", async () => {
  const base = scratch();
  const sam = join(base, "home");
  const proj = join(base, "proj");
  try {
    mkdirSync(sam, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
    const db = new ChatStore(sam);
    let chatId: string;
    try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "the owner's secret spec wording", maxIterations: 2 });
    const out = await drainCodingTasks(sam, { runTurn: async () => { throw dnsErr(); } });
    assert.deepEqual(out.failed, [task.id]);
    const failed = listCodingTasks(sam)[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.result, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    const lines = readActivity(sam, 100).filter(a => a.kind === "coding-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, codingFailedSummary(failed.title, dnsErr()));
    const db2 = new ChatStore(sam);
    let texts: string[];
    try { texts = db2.messages(chatId).map(m => m.content); } finally { db2.close(); }
    const summaryPost = texts[texts.length - 1];
    assert.match(summaryPost, /Coding task failed:/);
    assert.match(summaryPost, /fetch failed: getaddrinfo ENOTFOUND api\.minimax\.io/);
    assert.equal(failed.result?.includes("secret spec wording"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a drained coding task dying on a causeless error reads byte-identically in the stored result and the ledger line", async () => {
  const base = scratch();
  const sam = join(base, "home");
  const proj = join(base, "proj");
  try {
    mkdirSync(sam, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
    const db = new ChatStore(sam);
    let chatId: string;
    try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Fix the greeting export", maxIterations: 1 });
    const out = await drainCodingTasks(sam, { runTurn: async () => { throw new Error("model went away"); } });
    assert.deepEqual(out.failed, [task.id]);
    const failed = listCodingTasks(sam)[0];
    assert.equal(failed.result, "model went away");
    const lines = readActivity(sam, 100).filter(a => a.kind === "coding-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Coding task failed: " + failed.title + " - model went away");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

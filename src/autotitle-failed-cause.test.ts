import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { autotitleChat, autotitleFailureReason, autotitleFailedSummary, recordAutotitleFailure } from "./chat-title.js";
import { readActivity, recordActivity } from "./activity.js";
import { classifyDefect, rankDefects, buildSelfWorkSpec } from "./self-work.js";

// Autotitle failures are ledgered (gap found 2026-11-17,
// hourly run 02:04 EST): autotitleChat's completer catch
// bound nothing and returned null, so a title route dying
// on transport left the provisional title in place with
// zero evidence - neither countable nor diagnosable. Now
// the catch ledgers ONE autotitle-failed line whose reason
// composes through errorReason (the 04:04 bridge seam):
// causeless errors keep their plain message, bot-token
// segments are redacted, the person's message never enters
// the line, and non-failure returns (no model, owner rename
// first, unusable title) stay silent.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-autotitle-cause-")); }

function seededChat(root: string, title: string): string {
  const db = new ChatStore(root);
  try {
    const chat = db.create(title, null);
    db.add(chat.id, "user", "What needs my secret attention this morning?", "dashboard");
    db.add(chat.id, "assistant", "Two things: the venue deposit, and the banner proof.", "unknown");
    return chat.id;
  } finally { db.close(); }
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("an autotitle failure reason names the transport cause behind the wrapper", () => {
  assert.equal(autotitleFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
  const id = "12345678-1234-1234-1234-123456789012";
  assert.equal(autotitleFailedSummary(id, dnsErr()), "Autotitle failed in chat 12345678: fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(autotitleFailureReason(err), "fetch failed: read (ECONNRESET)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String", () => {
  assert.equal(autotitleFailureReason(new Error("Unsafe model output")), "Unsafe model output");
  assert.equal(autotitleFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through an autotitle failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = autotitleFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a completer dying on transport ledgers exactly one autotitle-failed line carrying the cause, and the provisional title stays", async () => {
  const root = scratch();
  try {
    const id = seededChat(root, "Needs my attention this morning");
    const title = await autotitleChat(root, id, "Needs my attention this morning", {}, async () => { throw dnsErr(); });
    assert.equal(title, null);
    const db = new ChatStore(root);
    try { assert.equal(db.get(id)?.title, "Needs my attention this morning"); } finally { db.close(); }
    const failed = readActivity(root, 100, { kind: "autotitle-failed" });
    assert.equal(failed.length, 1, "exactly one autotitle-failed line per failed attempt");
    assert.match(failed[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
    assert.equal(failed[0].summary.includes("secret attention"), false, "the person's message never enters the failure line");
    assert.equal(failed[0].actor, "sam");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-failure returns ledger nothing: no model, owner rename first, and an unusable title", async () => {
  const root = scratch();
  try {
    const id = seededChat(root, "Needs my attention this morning");
    assert.equal(await autotitleChat(root, id, "Needs my attention this morning", {}), null, "no model");
    assert.equal(await autotitleChat(root, id, "Some other placeholder", {}, async () => "Model Title Here"), null, "owner rename first");
    assert.equal(await autotitleChat(root, id, "Needs my attention this morning", {}, async () => "hi"), null, "unusable title");
    assert.equal(readActivity(root, 100, { kind: "autotitle-failed" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work classifies and specs the autotitle-failed class keyed by chat-title", () => {
  const root = scratch();
  try {
    const line = { at: "2026-11-17T07:00:00.000Z", actor: "sam", kind: "autotitle-failed", summary: autotitleFailedSummary("12345678-1234-1234-1234-123456789012", dnsErr()) };
    const cls = classifyDefect(line);
    assert.equal(cls?.key, "autotitle-failed");
    assert.equal(cls?.label, "chat autotitle failures");
    recordAutotitleFailure(root, "sam", "12345678-1234-1234-1234-123456789012", dnsErr());
    recordActivity(root, "sam", "autotitle-failed", line.summary);
    const ranked = rankDefects(root);
    assert.equal(ranked[0]?.key, "autotitle-failed");
    assert.equal(ranked[0]?.count, 2);
    const run = buildSelfWorkSpec(root, null);
    assert.equal(run.spec?.defectKey, "autotitle-failed");
    assert.ok(run.spec?.files.includes("chat-title.ts"));
    assert.ok(run.spec?.endGoal.includes("autotitling stops failing"), run.spec?.endGoal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

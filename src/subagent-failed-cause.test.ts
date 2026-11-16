import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent, listSubagents, subagentFailureReason, subagentFailedSummary, type SubagentCompleter } from "./subagents.js";
import { readActivity } from "./activity.js";

// Sub-agent failures carry their cause (gap found 2026-11-16,
// hourly run 14:04 EST): driveSubagent's catch took
// error.message alone, so a transport death read as the bare
// "fetch failed" wrapper in the subagent-failed ledger line,
// the helper's stored result, and the loop journal fold. The
// reason now composes through errorReason (the 04:04 bridge
// seam): causeless errors keep their plain message, a
// transport wrapper names its cause, and no bot token leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-sub-cause-"));
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a sub-agent failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    subagentFailedSummary("b54d9778-aaaa", dnsErr()),
    "Sub-agent b54d9778 failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
  assert.equal(subagentFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    subagentFailedSummary("b54d9778-aaaa", err),
    "Sub-agent b54d9778 failed: fetch failed: read (ECONNRESET)",
  );
});

test("causeless sub-agent errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(
    subagentFailedSummary("b54d9778-aaaa", new Error("Unsafe model output")),
    "Sub-agent b54d9778 failed: Unsafe model output",
  );
  assert.equal(subagentFailureReason("plain string failure"), "Sub-agent failed");
  assert.equal(
    subagentFailedSummary("b54d9778-aaaa", "plain string failure"),
    "Sub-agent b54d9778 failed: Sub-agent failed",
  );
});

test("no bot token leaks through a sub-agent failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = subagentFailedSummary("b54d9778-aaaa", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a sub-agent failure reason slice caps at 180 in the ledger summary, not in the reason", () => {
  const summary = subagentFailedSummary("b54d9778-aaaa", new Error("x".repeat(400)));
  assert.equal(summary, "Sub-agent b54d9778 failed: " + "x".repeat(180));
  assert.equal(subagentFailureReason(new Error("x".repeat(400))).length, 400);
});

test("a child dying on transport carries its cause in the ledger line and the stored result - and never its prompt", async () => {
  const root = scratch();
  try {
    const throwing: SubagentCompleter = async () => { throw dnsErr(); };
    await assert.rejects(
      () => spawnSubagent(root, { profile: "sam", prompt: "the helper's secret prompt wording", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: throwing }),
      /fetch failed/,
    );
    const items = listSubagents(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "failed");
    assert.equal(items[0].result, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    assert.equal((items[0].result ?? "").includes("secret prompt"), false);
    const lines = readActivity(root, 50).filter(a => a.kind === "subagent-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Sub-agent " + items[0].id.slice(0, 8) + " failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    assert.equal(lines[0].summary.includes("secret prompt"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a child dying on a causeless error ledgers exactly its plain message, once", async () => {
  const root = scratch();
  try {
    const throwing: SubagentCompleter = async () => { throw new Error("Unsafe model output"); };
    await assert.rejects(
      () => spawnSubagent(root, { profile: "sam", prompt: "Report in", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: throwing }),
      /Unsafe model output/,
    );
    const items = listSubagents(root);
    assert.equal(items[0].result, "Unsafe model output");
    const lines = readActivity(root, 50).filter(a => a.kind === "subagent-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Sub-agent " + items[0].id.slice(0, 8) + " failed: Unsafe model output");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a child dying on a non-Error throw stores and ledgers the fallback, once", async () => {
  const root = scratch();
  try {
    const throwing: SubagentCompleter = async () => { throw "plain string failure"; };
    await assert.rejects(
      () => spawnSubagent(root, { profile: "sam", prompt: "Report in", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: throwing }),
    );
    const items = listSubagents(root);
    assert.equal(items[0].status, "failed");
    assert.equal(items[0].result, "Sub-agent failed");
    const lines = readActivity(root, 50).filter(a => a.kind === "subagent-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Sub-agent " + items[0].id.slice(0, 8) + " failed: Sub-agent failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

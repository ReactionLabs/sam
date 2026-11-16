import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnRetrySummary } from "./budgets.js";
import { ownToolsChat } from "./own-tools.js";
import { connectorChat } from "./connector-chat.js";
import { addConnector } from "./connectors.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// Turn-retry lines carry their cause (gap found 2026-11-16,
// hourly run 18:04 EST, the candidate the 17:04 run named):
// both chat loops ledgered their turn-retry line from
// (e as Error).message alone, so a triggering error carrying
// its message WITH a cause would ledger the bare message and
// drop the cause. The line's reason now composes through
// errorReason (the 04:04 bridge seam) via the shared
// turnRetrySummary in budgets.ts; the trigger condition, the
// trimmed retry itself, and the line's prefix/suffix are
// untouched.

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

const dnsCause = () => Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" });
const unsafeWithCause = () => new Error("Unsafe model output", { cause: dnsCause() });

const longHistory = (): Array<{ role: "user" | "assistant"; content: string }> => {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < 6; i++) { history.push({ role: "user", content: "old ask " + i }); history.push({ role: "assistant", content: "old answer " + i }); }
  return history;
};

test("a turn-retry summary names the transport cause behind the triggering error", () => {
  assert.equal(
    turnRetrySummary(unsafeWithCause()),
    "Context reset after 'Unsafe model output: getaddrinfo ENOTFOUND api.minimax.io' before any tool ran; history trimmed to the last 6 messages",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new Error("Empty model response", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(
    turnRetrySummary(err),
    "Context reset after 'Empty model response: read (ECONNRESET)' before any tool ran; history trimmed to the last 6 messages",
  );
});

test("causeless triggering errors read exactly as before", () => {
  assert.equal(
    turnRetrySummary(new Error("Unsafe model output")),
    "Context reset after 'Unsafe model output' before any tool ran; history trimmed to the last 6 messages",
  );
  assert.equal(
    turnRetrySummary(new Error("Empty model response")),
    "Context reset after 'Empty model response' before any tool ran; history trimmed to the last 6 messages",
  );
});

test("no bot token leaks through a turn-retry summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new Error("Unsafe model output", { cause: new Error("request to " + url + " failed") });
  const summary = turnRetrySummary(err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("an own-tools turn retrying on a cause-carrying error ledgers one line naming the cause, and no trace of the ask", async () => {
  const root = scratch("sam-retrycause-own-");
  try {
    let calls = 0;
    const fake = {
      completeConnectorTurn: async () => {
        calls++;
        if (calls === 1) throw unsafeWithCause();
        return { content: "Recovered on a trimmed context.", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const history = longHistory();
    history.push({ role: "user", content: "my secret zebra phrase" });
    const answer = await ownToolsChat(root, "sam", fake, "test-model", history);
    assert.equal(answer, "Recovered on a trimmed context.");
    const retries = ledger(root).filter(l => l.kind === "turn-retry");
    assert.equal(retries.length, 1, "exactly one turn-retry line for one reset");
    assert.match(retries[0].summary, /Unsafe model output: getaddrinfo ENOTFOUND api\.minimax\.io/);
    assert.doesNotMatch(retries[0].summary, /zebra/, "the person's message content never enters the retry line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a connector turn retrying on a cause-carrying error ledgers one line naming the cause", async () => {
  const root = scratch("sam-retrycause-conn-");
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "whoami" }] } : { content: [{ type: "text", text: "tenant-scoped identity" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    let calls = 0;
    const fake = {
      completeConnectorTurn: async () => {
        calls++;
        if (calls === 1) throw unsafeWithCause();
        return { content: "Recovered via the connector loop.", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const answer = await connectorChat(root, fake, "test-model", longHistory(), undefined, { actor: "sam" });
    assert.equal(answer, "Recovered via the connector loop.");
    const retries = ledger(root).filter(l => l.kind === "turn-retry");
    assert.equal(retries.length, 1, "exactly one turn-retry line for one reset");
    assert.match(retries[0].summary, /Unsafe model output: getaddrinfo ENOTFOUND api\.minimax\.io/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStackWatchReport, isStackToolParseFailure, readStackTool, unwrapToolResult,
  type StackToolCaller,
} from "./stack-watch.js";
import type { Connector } from "./connectors.js";
import { readActivity } from "./activity.js";

// The stack watch parse-retry (2026-11-26, the 07:19 UTC live
// wobble): one malformed tool reply used to kill a whole tick
// whose facts the next tick read unchanged. A parse failure
// (the reply cannot be read at all) retries the call exactly
// once; a second malformed reply fails by the same name as
// before, and fact failures / transport errors never retry.

const HEALTH = {
  tables: {
    candidates_count: 353351,
    candidates_newest: "2026-11-25T19:01:05Z",
    paper_setups_count: 212,
    paper_setups_newest: "2026-11-25T19:01:05Z",
  },
  candidate_verdicts: [
    { verdict: "PENDING", n: 281818 },
    { verdict: "PASS", n: 1139 },
    { verdict: "ALERT", n: 9 },
  ],
};

function mcpText(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function mcpRawText(text: string) {
  return { content: [{ type: "text", text }] };
}

function page(rows: number) {
  return { count: rows, state_filter: "entered", paper_setups: Array.from({ length: rows }, (_, i) => ({ id: i + 1 })) };
}

const NINES: Connector = {
  id: "nines-1", name: "Nines", url: "http://127.0.0.1:4390/mcp/v1", tokenEnv: "SAM_MCP_TOKEN_NINES",
  enabled: true, allowedTools: ["stack_health", "paper_setups", "list_leads"],
};

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-stack-watch-retry-"));
  const root = join(base, "home");
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "connectors.json"), JSON.stringify([NINES], null, 2));
  return { base, root };
}

test("stack watch retry: the parse-failure class is exactly the unwrap shapes", () => {
  assert.equal(isStackToolParseFailure(new Error("Stack tool returned non-JSON text")), true);
  assert.equal(isStackToolParseFailure(new Error("Stack tool returned no text content")), true);
  assert.equal(isStackToolParseFailure(new Error("Stack tool returned an unexpected shape")), true);
  assert.equal(isStackToolParseFailure(new Error("stack_health is missing a usable candidates_count")), false);
  assert.equal(isStackToolParseFailure(new Error("paper_setups returned no setups array")), false);
  assert.equal(isStackToolParseFailure(new Error("MCP request timed out")), false);
  assert.equal(isStackToolParseFailure("Stack tool returned non-JSON text"), false);
});

test("stack watch retry: one non-JSON health reply is absorbed, the report is unchanged, one ledger line", async () => {
  const f = fixture();
  try {
    const counts: Record<string, number> = {};
    const call: StackToolCaller = async (_c, tool) => {
      counts[tool] = (counts[tool] ?? 0) + 1;
      if (tool === "stack_health") return counts[tool] === 1 ? mcpRawText("<html>bad gateway</html>") : mcpText(HEALTH);
      return mcpText(page(100));
    };
    const report = await buildStackWatchReport(f.root, { call });
    assert.equal(counts.stack_health, 2);
    assert.equal(counts.paper_setups, 1);
    assert.match(report.text, /Candidates total: 353,351/);
    assert.equal(report.frozen, false);
    const lines = readActivity(f.root, 10).filter(a => a.kind === "stack-watch");
    assert.equal(lines.length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch retry: one non-JSON entered page is absorbed the same way", async () => {
  const f = fixture();
  try {
    let enteredCalls = 0;
    const call: StackToolCaller = async (_c, tool) => {
      if (tool === "stack_health") return mcpText(HEALTH);
      enteredCalls += 1;
      return enteredCalls === 1 ? "garbage, not json" : mcpText(page(42));
    };
    const report = await buildStackWatchReport(f.root, { call });
    assert.equal(enteredCalls, 2);
    assert.deepEqual(report.entered, { count: 42, exact: true });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch retry: a second malformed reply fails by the same name, exactly two calls, nothing ledgered", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const call: StackToolCaller = async () => { calls += 1; return mcpRawText("still not json"); };
    await assert.rejects(buildStackWatchReport(f.root, { call }), /Stack tool returned non-JSON text/);
    assert.equal(calls, 2);
    assert.equal(readActivity(f.root, 10).filter(a => a.kind === "stack-watch").length, 0);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch retry: fact failures and transport errors never retry", async () => {
  const f = fixture();
  try {
    let factCalls = 0;
    const factCall: StackToolCaller = async () => { factCalls += 1; return mcpText({ tables: { candidates_newest: "x" }, candidate_verdicts: [{ verdict: "ALERT", n: 9 }] }); };
    await assert.rejects(buildStackWatchReport(f.root, { call: factCall }), /candidates_count/);
    assert.equal(factCalls, 1);
    let transportCalls = 0;
    const transportCall: StackToolCaller = async () => { transportCalls += 1; throw new Error("MCP request timed out"); };
    await assert.rejects(buildStackWatchReport(f.root, { call: transportCall }), /timed out/);
    assert.equal(transportCalls, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch retry: readStackTool retries a bare-string non-JSON reply once and only once", async () => {
  let calls = 0;
  const call: StackToolCaller = async () => { calls += 1; return calls === 1 ? "not json" : mcpText({ ok: true }); };
  const out = await readStackTool(call, NINES, "stack_health", {}, unwrapToolResult);
  assert.equal(calls, 2);
  assert.deepEqual(out, { ok: true });
});

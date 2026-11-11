import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStackWatchReport, countEnteredSetups, findStackConnector, formatCount,
  isFrozenStack, parseStackHealth, secondPrecision, stackWatchStatus,
  ENTERED_PAGE_LIMIT, type StackToolCaller,
} from "./stack-watch.js";
import type { Connector } from "./connectors.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { addScheduledJob, heartbeatJobs } from "./heartbeat.js";
import { readActivity } from "./activity.js";

// The deterministic stack watch: the counts a model used to invent
// from a paged tool are computed in code. Fixtures are the LIVE
// shapes read off the box on 2026-11-10 (candidates 282,966,
// newest 2026-11-04T22:45:59.894Z, ALERT 9 / PASS 1,139 /
// PENDING 281,818, a full 100-row entered page).

const HEALTH = {
  tables: {
    candidates_count: 282966,
    candidates_newest: "2026-11-04T22:45:59.894Z",
    paper_setups_count: 212,
    paper_setups_newest: "2026-11-04T22:41:50.209Z",
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

function page(rows: number, extra: Record<string, unknown> = {}) {
  return { count: rows, state_filter: "entered", paper_setups: Array.from({ length: rows }, (_, i) => ({ id: i + 1 })), ...extra };
}

function fixture(connectorsList: unknown[] | null) {
  const base = mkdtempSync(join(tmpdir(), "sam-stack-watch-"));
  const root = join(base, "home");
  mkdirSync(join(root, ".sam"), { recursive: true });
  if (connectorsList) writeFileSync(join(root, ".sam", "connectors.json"), JSON.stringify(connectorsList, null, 2));
  return { base, root };
}

const NINES: Connector = {
  id: "nines-1", name: "Nines", url: "http://127.0.0.1:4390/mcp/v1", tokenEnv: "SAM_MCP_TOKEN_NINES",
  enabled: true, allowedTools: ["stack_health", "paper_setups", "list_leads"],
};

function stubCall(entered: unknown, health: unknown = HEALTH): StackToolCaller {
  return async (_c, tool) => {
    if (tool === "stack_health") return mcpText(health);
    if (tool === "paper_setups") return mcpText(entered);
    throw new Error("unexpected tool " + tool);
  };
}

test("stack watch: a full entered page reports a floor, never a fake exact count", async () => {
  const f = fixture([NINES]);
  try {
    const report = await buildStackWatchReport(f.root, { call: stubCall(page(ENTERED_PAGE_LIMIT)) });
    assert.equal(report.entered.count, 100);
    assert.equal(report.entered.exact, false);
    assert.match(report.text, /Paper setups in state entered: 100 or more/);
    assert.match(report.text, /pages at 100 and reports no total/);
    assert.match(report.text, /Candidates total: 282,966/);
    assert.match(report.text, /Newest candidate: 2026-11-04T22:45:59\.894Z/);
    assert.match(report.text, /Alert verdicts: PENDING 281,818 \/ PASS 1,139 \/ ALERT 9/);
    assert.equal(report.frozen, true);
    assert.equal(report.text.split("\n").at(-1), "The stack is still frozen.");
    const lines = readActivity(f.root, 10).filter(a => a.kind === "stack-watch");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /entered 100\+ \(page cap\)/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch: a short page is an exact count, and a server total wins over the page", async () => {
  const f = fixture([NINES]);
  try {
    const short = await buildStackWatchReport(f.root, { call: stubCall(page(87)) });
    assert.deepEqual(short.entered, { count: 87, exact: true });
    assert.match(short.text, /Paper setups in state entered: 87$/m);
    assert.deepEqual(countEnteredSetups(mcpText(page(100, { total: 137 }))), { count: 137, exact: true });
    assert.deepEqual(countEnteredSetups(mcpText(page(3, { total: 3 }))), { count: 3, exact: true });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch: the fetch is ONE page at the cap with the entered state filter", async () => {
  const f = fixture([NINES]);
  try {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const call: StackToolCaller = async (_c, tool, args) => {
      seen.push({ tool, args });
      return tool === "stack_health" ? mcpText(HEALTH) : mcpText(page(5));
    };
    await buildStackWatchReport(f.root, { call });
    assert.deepEqual(seen.map(s => s.tool), ["stack_health", "paper_setups"]);
    assert.deepEqual(seen[1].args, { state: "entered", limit: ENTERED_PAGE_LIMIT });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch: determinism - the same tool results give byte-identical text", async () => {
  const f = fixture([NINES]);
  try {
    const a = await buildStackWatchReport(f.root, { call: stubCall(page(100)) });
    const b = await buildStackWatchReport(f.root, { call: stubCall(page(100)) });
    assert.equal(a.text, b.text);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch: frozen is a second-precision comparison against the crash stamp", () => {
  assert.equal(secondPrecision("2026-11-04T22:45:59.894Z"), "2026-11-04T22:45:59Z");
  assert.equal(isFrozenStack("2026-11-04T22:45:59.894Z"), true);
  assert.equal(isFrozenStack("2026-11-04T22:45:59Z"), true);
  assert.equal(isFrozenStack("2026-11-04T22:46:00.000Z"), false);
  assert.equal(isFrozenStack("2026-11-11T00:00:00.000Z"), false);
  assert.equal(formatCount(282966), "282,966");
});

test("stack watch: malformed tool output fails by name instead of printing a guess", async () => {
  const f = fixture([NINES]);
  try {
    assert.throws(() => parseStackHealth(mcpText({ tables: { candidates_newest: "x" }, candidate_verdicts: [{ verdict: "ALERT", n: 9 }] })), /candidates_count/);
    assert.throws(() => countEnteredSetups(mcpText({ count: 2 })), /no setups array/);
    await assert.rejects(
      buildStackWatchReport(f.root, { call: async () => { throw new Error("MCP request timed out"); } }),
      /timed out/,
    );
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("stack watch: no connector offering both stack tools refuses, naming the registry", async () => {
  const f = fixture([{ ...NINES, name: "Other", allowedTools: ["list_leads"] }]);
  try {
    assert.equal(findStackConnector(f.root), null);
    assert.deepEqual(stackWatchStatus(f.root), { connector: null, script: "sam-stack-watch" });
    await assert.rejects(buildStackWatchReport(f.root, { call: stubCall(page(1)) }), /No enabled connector offers the Nines stack tools.*Registered connectors: Other/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture([NINES]);
  try {
    assert.equal(findStackConnector(g.root)?.name, "Nines");
    assert.equal(stackWatchStatus(g.root).connector, "Nines");
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("stack watch: sam-stack-watch is an allowlisted Phase C script riding the watches CLI", () => {
  const f = fixture(null);
  try {
    assert.ok(scriptCommandNames().includes("sam-stack-watch"));
    assert.deepEqual(scriptArgv(f.root, "sam-stack-watch").slice(-2), ["watches", "stack"]);
    const job = addScheduledJob(f.root, { name: "stack watch", profile: "sam", schedule: "every 30 minutes", script: "sam-stack-watch" });
    assert.equal(job.mode, "script");
    assert.equal(job.script, "sam-stack-watch");
    assert.equal(heartbeatJobs(f.root).length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

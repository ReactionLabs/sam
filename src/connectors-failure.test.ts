import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  addConnector, allowlistPairHost, connectorFailureSummary, connectors,
  getConnector, isConnectorLedgered, pairAllowlistedHosts, removeConnector,
  updateConnector,
} from "./connectors.js";
import { classifyDefect } from "./self-work.js";

// Connector store failure visibility (gap found 2026-11-14,
// hourly run 19:04): the connector store is the MCP connector
// registry - URLs, credential names, enabled flags, and the
// allowedTools sets the turn loops authorize from - and every
// touch opened it raw: a dead connectors.db threw into
// whichever catch wrapped the call, none naming the store.
// Each touch now ledgers ONE connector-failed line (phase
// read / lookup / write) and rethrows exactly, tagged; every
// caller's handling is unchanged and authorization still
// fails closed (never folded as no connectors, which would
// strip every pin and tool authorization).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-connectors-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "connector-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "connectors.db"), { force: true });
  mkdirSync(join(root, ".sam", "connectors.db"), { recursive: true });
}

function withHosts(fn: () => void): void {
  const before = process.env.SAM_MCP_ALLOWED_HOSTS;
  process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
  try { fn(); } finally {
    if (before === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = before;
  }
}

const URL_OK = "https://mcp.secondshiftos.com/mcp/v1";

test("connector-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(connectorFailureSummary("read", "unable to open\n  database   file"), "Connector read failed: unable to open database file");
  assert.equal(connectorFailureSummary("lookup", "disk gone"), "Connector lookup failed: disk gone");
  assert.equal(connectorFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "lookup", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "connector-failed", summary: connectorFailureSummary(phase, "boom") }),
      { key: "connector-failed:" + phase, label: "connector store failures (" + phase + " step)" },
    );
  }
});

test("connector-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => withHosts(() => {
  const root = scratch();
  try {
    const added = addConnector(root, "Alpha", URL_OK, "SAM_MCP_TOKEN_ALPHA");
    plantDeadStore(root);

    assert.throws(() => connectors(root), (e: unknown) => isConnectorLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Connector read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "connector-failed:read", label: "connector store failures (read step)" });

    assert.throws(() => getConnector(root, added.id), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Connector lookup failed: "), lines[1].summary);

    assert.throws(() => updateConnector(root, added.id, { enabled: false }), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the update touch ledgers exactly one more line");
    assert.ok(lines[2].summary.startsWith("Connector write failed: "), lines[2].summary);

    assert.throws(() => removeConnector(root, added.id), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the remove touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Connector write failed: "), lines[3].summary);

    assert.throws(() => pairAllowlistedHosts(root), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the pair allowlist read ledgers exactly one more line");
    assert.ok(lines[4].summary.startsWith("Connector read failed: "), lines[4].summary);

    assert.throws(() => allowlistPairHost(root, "127.0.0.1"), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 6, "the pair allowlist write ledgers exactly one more line");
    assert.ok(lines[5].summary.startsWith("Connector write failed: "), lines[5].summary);

    assert.throws(() => addConnector(root, "Beta", URL_OK, "SAM_MCP_TOKEN_BETA"), (e: unknown) => isConnectorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 7, "an add over a dead store ledgers exactly one line total, never a second for the same touch");
    assert.deepEqual(classifyDefect(lines[6])?.key.startsWith("connector-failed:"), true);

    assert.ok(!JSON.stringify(lines).includes("Alpha"), "no connector record ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("SAM_MCP_TOKEN"), "no credential name ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("secondshiftos"), "no connector URL ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connector-failed: an absent store reads as no connectors, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(connectors(root), []);
    assert.deepEqual(pairAllowlistedHosts(root), []);
    assert.equal(updateConnector(root, "nope", { enabled: false }), null);
    assert.equal(removeConnector(root, "nope"), false);
    assert.throws(() => getConnector(root, "nope"), /not found or disabled/);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connector-failed: validation errors are not store failures and ledger nothing", () => withHosts(() => {
  const root = scratch();
  try {
    assert.throws(() => addConnector(root, "bad name!", URL_OK, "SAM_MCP_TOKEN_X"), /Invalid connector name/);
    assert.throws(() => addConnector(root, "Fine", URL_OK, "WRONG_ENV"), /Invalid connector name/);
    assert.throws(() => addConnector(root, "Fine", "https://evil.example.com/mcp", "SAM_MCP_TOKEN_X"), /not allowlisted/);
    assert.throws(() => allowlistPairHost(root, "evil.example.com"), /Only a loopback host/);
    addConnector(root, "Taken", URL_OK, "SAM_MCP_TOKEN_TAKEN");
    assert.throws(() => addConnector(root, "Taken", URL_OK, "SAM_MCP_TOKEN_OTHER"), /duplicate/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connector-failed: a healthy store adds, reads, updates, allowlists, and removes with zero failure lines", () => withHosts(() => {
  const root = scratch();
  try {
    const added = addConnector(root, "Alpha", URL_OK, "SAM_MCP_TOKEN_ALPHA");
    assert.equal(connectors(root).length, 1);
    assert.equal(getConnector(root, added.id).name, "Alpha");
    const narrowed = updateConnector(root, added.id, { allowedTools: ["whoami"] });
    assert.deepEqual(narrowed?.allowedTools, ["whoami"]);
    assert.equal(allowlistPairHost(root, "LOCALHOST"), "localhost");
    assert.deepEqual(pairAllowlistedHosts(root), ["localhost"]);
    assert.equal(removeConnector(root, added.id), true);
    assert.deepEqual(connectors(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connector-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => withHosts(() => {
  const root = scratch();
  try {
    addConnector(root, "Alpha", URL_OK, "SAM_MCP_TOKEN_ALPHA");
    const raw = openDatabase(join(root, ".sam", "connectors.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON connectors BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => addConnector(root, "Beta", URL_OK, "SAM_MCP_TOKEN_BETA"), (e: unknown) => isConnectorLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Connector write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addConnector, connectors, getConnector, removeConnector, updateConnector, type Connector } from "./connectors.js";

// State convergence (UNIFICATION item 4, twelfth store): the
// connector registry migrated from whole-file connectors.json
// rewrites to one-row-per-connector SQLite. These tests pin the
// migration contract: legacy files import in order with every
// field intact, are renamed (never deleted), a malformed file
// imports nothing and stays put, a pure read creates nothing,
// single-row mutations cannot lose each other, and a tool-set
// narrowing over a migrated legacy connector persists through
// the row update alone.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-connectors-store-")); }

function legacyConnector(id: string, name: string, extra: Partial<Connector> = {}): Connector {
  return { id, name, url: "https://mcp.secondshiftos.com/mcp/v1", tokenEnv: "SAM_MCP_TOKEN_TEST", enabled: true, allowedTools: ["whoami", "list_leads"], ...extra };
}

function withHosts(fn: () => void): void {
  const before = process.env.SAM_MCP_ALLOWED_HOSTS;
  process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
  try { fn(); } finally {
    if (before === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = before;
  }
}

test("connectors store: a legacy connectors.json imports in order, fields intact, file renamed not deleted", () => withHosts(() => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyConnector("conn-1", "Second Shift");
    const second = legacyConnector("conn-2", "Nines Mirror", { tokenEnv: "SAM_MCP_TOKEN_NINES", enabled: false, allowedTools: ["stack_health", "paper_setups"] });
    writeFileSync(join(root, ".sam", "connectors.json"), JSON.stringify([first, second], null, 2));
    const items = connectors(root);
    assert.deepEqual(items.map(c => c.id), ["conn-1", "conn-2"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "connectors.db")), true);
    assert.equal(existsSync(join(root, ".sam", "connectors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "connectors.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "connectors.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    const added = addConnector(root, "Third", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_THIRD");
    assert.deepEqual(connectors(root).map(c => c.id), ["conn-1", "conn-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "connectors.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connectors store: a malformed legacy file imports nothing and is left in place", () => withHosts(() => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "connectors.json"), "{ not json");
    assert.deepEqual(connectors(root), []);
    assert.equal(existsSync(join(root, ".sam", "connectors.json")), true);
    assert.equal(existsSync(join(root, ".sam", "connectors.json.migrated")), false);
    // A non-array payload is likewise refused, not imported.
    writeFileSync(join(root, ".sam", "connectors.json"), JSON.stringify({ id: "conn-x" }));
    assert.deepEqual(connectors(root), []);
    assert.equal(existsSync(join(root, ".sam", "connectors.json.migrated")), false);
    // A fresh add over the malformed file lands in the DB only.
    const added = addConnector(root, "Fresh", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_FRESH");
    assert.deepEqual(connectors(root).map(c => c.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "connectors.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connectors store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(connectors(root), []);
    assert.equal(updateConnector(root, "nope", { enabled: false }), null);
    assert.equal(removeConnector(root, "nope"), false);
    assert.throws(() => getConnector(root, "nope"), /not found or disabled/);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connectors store: interleaved adds, an update, and a remove all survive (no whole-file lost update)", () => withHosts(() => {
  const root = fresh();
  try {
    const a = addConnector(root, "Alpha", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_ALPHA");
    const b = addConnector(root, "Beta", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_BETA");
    const patched = updateConnector(root, b.id, { enabled: false });
    assert.equal(patched?.enabled, false);
    assert.equal(updateConnector(root, "ghost", { enabled: false }), null);
    // A disabled connector stays listed but getConnector refuses it.
    assert.throws(() => getConnector(root, b.id), /not found or disabled/);
    assert.equal(removeConnector(root, b.id), true);
    assert.equal(removeConnector(root, b.id), false);
    const items = connectors(root);
    assert.deepEqual(items.map(c => c.id), [a.id]);
    assert.equal(getConnector(root, a.id).name, "Alpha");
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test("connectors store: a tool-set narrowing over a migrated legacy connector persists in the DB (the authorization shape)", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "connectors.json"), JSON.stringify([legacyConnector("conn-9", "Legacy", { allowedTools: ["whoami", "list_leads", "stack_health"] })], null, 2));
    // The operator narrowing shape: shrink allowedTools through the
    // store's update door - now a single-row update, not a snapshot.
    const updated = updateConnector(root, "conn-9", { allowedTools: ["whoami"] });
    assert.deepEqual(updated?.allowedTools, ["whoami"]);
    assert.deepEqual(connectors(root)[0].allowedTools, ["whoami"]);
    assert.deepEqual(getConnector(root, "conn-9").allowedTools, ["whoami"]);
    assert.equal(existsSync(join(root, ".sam", "connectors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "connectors.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addConnector, connectorPinBlocker, connectorPinId } from "./connectors.js";
import { minis, spawnMini } from "./minis.js";

// The connector-pin field gate: every profile door
// read the profile registry before writing, but the
// two doors that pin a CONNECTOR onto a profile read
// nothing for a UUID-shaped value. `minis spawn
// --connector` passed the raw value into spawnMini ->
// ChatStore.createAgent, which checks only that the
// pin is UUID-shaped: a phantom UUID minted a mini
// pinned to a connector that does not exist (its
// every turn routes at a missing connector), and a
// connector name died obscurely on "Invalid agent
// profile". `agents set-connector` checked the
// registry on its name path and took a UUID as-is on
// its id path - two bars for one field. connectorPinBlocker
// in connectors.ts is now the ONE source carrying the
// refusal text, and connectorPinId resolves a passing
// name or id to the id both doors pin. spawnMini /
// createAgent / setAgentConnector stay permissive by
// design (a connector removed after a profile names
// it keeps its stored pin), so they are NOT gated
// here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-connector-pin-gate-")); }

const PHANTOM = "11111111-2222-4333-8444-555555555555";

function registerConnector(root: string): string {
  return addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST").id;
}

test("connector pin gate: no pin, a registered id, and a registered name read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(connectorPinBlocker(root, null), null);
    assert.equal(connectorPinBlocker(root, undefined), null);
    assert.equal(connectorPinBlocker(root, ""), null);
    const id = registerConnector(root);
    assert.equal(connectorPinBlocker(root, id), null);
    assert.equal(connectorPinBlocker(root, "Second Shift"), null);
    assert.equal(connectorPinId(root, id), id);
    assert.equal(connectorPinId(root, "Second Shift"), id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connector pin gate: an unknown pin names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      connectorPinBlocker(root, PHANTOM),
      "Unknown connector \"" + PHANTOM + "\" in connector pin. Valid connectors: none registered",
    );
    const id = registerConnector(root);
    assert.equal(
      connectorPinBlocker(root, PHANTOM),
      "Unknown connector \"" + PHANTOM + "\" in connector pin. Valid connectors: Second Shift (" + id + ")",
    );
    assert.equal(
      connectorPinBlocker(root, "second shift"),
      "Unknown connector \"second shift\" in connector pin. Valid connectors: Second Shift (" + id + "). Did you mean \"Second Shift\" (" + id + ")?",
    );
    assert.equal(connectorPinId(root, PHANTOM), null);
    assert.equal(connectorPinId(root, "second shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connector pin gate: the spawn door's check spawns nothing for a bogus pin", () => {
  const root = fresh();
  try {
    registerConnector(root);
    const blocker = connectorPinBlocker(root, PHANTOM);
    assert.ok(blocker);
    // The door throws this text before calling
    // spawnMini with the resolved id; pin that the
    // check alone leaves no mini and no profile.
    assert.deepEqual(minis(root), []);
    const db = new ChatStore(root);
    try { assert.deepEqual(db.agents(), []); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connector pin gate: a name pin resolved through the source spawns a mini pinned by id", () => {
  const root = fresh();
  try {
    const id = registerConnector(root);
    assert.equal(connectorPinBlocker(root, "Second Shift"), null);
    const mini = spawnMini(root, {
      name: "alex", person: "Alex", instructions: "Help Alex.",
      connectorId: connectorPinId(root, "Second Shift"),
    });
    assert.equal(mini.name, "alex");
    const db = new ChatStore(root);
    try { assert.equal(db.agents().find(a => a.name === "alex")?.connector_id, id); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connector pin gate: spawnMini stays permissive - a spawn may name a connector removed later", () => {
  const root = fresh();
  try {
    const mini = spawnMini(root, {
      name: "trader-j", person: "Johnny", instructions: "Watch the stack.",
      connectorId: PHANTOM,
    });
    assert.equal(mini.name, "trader-j");
    const db = new ChatStore(root);
    try { assert.equal(db.agents().find(a => a.name === "trader-j")?.connector_id, PHANTOM); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

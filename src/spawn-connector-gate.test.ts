import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addConnector, connectors } from "./connectors.js";
import { spawnConnectorBlocker, validateSpawnDetail } from "./minis.js";
import { decideAction, proposeAction } from "./actions.js";

// The spawn-connector gate: a spawn detail's connector pin is
// a registry name (the connector registry, picked by its
// registered name or its id) that a person or the model names
// in a kind "spawn" proposal detail. validateSpawnDetail, the
// ONE seam every gated spawn rides (proposal and execution),
// checked the pin by exact id only and refused with the bare
// "Cannot spawn: no connector with id X exists on this
// install" - no registry named, no fold correction - so a
// spawn naming its connector by name dead-ended, even though
// the CLI spawn door accepts a name or an id through
// connectorPinBlocker. spawnConnectorBlocker in minis.ts is
// now the ONE source carrying this door's refusal text (the
// standing prefix kept): an exact id or exact name reads no
// blocker and a passing name resolves to the id; anything
// else names the registry with a fold correction when
// exactly one registered name matches folded. Stored
// profile connector pins stay permissive by design.

function fixture(): { root: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), "sam-spawn-connector-gate-"));
  const db = new ChatStore(root);
  try { db.createAgent("dip", "Dip's own SAM."); } finally { db.close(); }
  const c = addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
  return { root, id: c.id };
}

const detail = (connectorId: string) => JSON.stringify({ name: "writer", person: "p", instructions: "i", connectorId });

test("spawn connector gate: an exact id, an exact name, and no pin read no blocker", () => {
  const { root, id } = fixture();
  try {
    assert.equal(spawnConnectorBlocker(root, id), null);
    assert.equal(spawnConnectorBlocker(root, "Second Shift"), null);
    assert.equal(spawnConnectorBlocker(root, null), null);
    assert.equal(spawnConnectorBlocker(root, undefined), null);
    assert.equal(spawnConnectorBlocker(root, ""), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn connector gate: an unknown connector echoes the value and names the registry, no correction", () => {
  const { root, id } = fixture();
  try {
    const blocker = spawnConnectorBlocker(root, "nope")!;
    assert.ok(blocker.startsWith("Cannot spawn: no connector with id \"nope\" exists on this install. Valid connectors: Second Shift (" + id + ")"), blocker);
    assert.doesNotMatch(blocker, /Did you mean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn connector gate: a folded name is refused with the correction", () => {
  const { root, id } = fixture();
  try {
    for (const folded of ["second shift", "Second-Shift", "SECOND_SHIFT", "secondshift"]) {
      assert.match(spawnConnectorBlocker(root, folded)!, new RegExp("Did you mean \"Second Shift\" \\(" + id + "\\)\\?$"), folded);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn connector gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-spawn-connector-gate-"));
  try {
    assert.deepEqual(connectors(root), []);
    assert.match(spawnConnectorBlocker(root, "nope")!, /Valid connectors: none registered$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn connector gate: validateSpawnDetail resolves an exact name to the id and refuses a folded name before any spawn", () => {
  const { root, id } = fixture();
  try {
    assert.equal(validateSpawnDetail(root, detail("Second Shift")).connectorId, id);
    assert.equal(validateSpawnDetail(root, detail(id)).connectorId, id);
    assert.throws(() => validateSpawnDetail(root, detail("second shift")), /Did you mean "Second Shift"/);
    assert.throws(() => validateSpawnDetail(root, detail("nope")), /no connector with id "nope" exists on this install\. Valid connectors: Second Shift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn connector gate: the proposal seam refuses a folded connector with no card, and a name-pinned proposal executes pinned to the id", async () => {
  const { root, id } = fixture();
  try {
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: detail("Second-Shift") }), /Did you mean "Second Shift"/);
    const proposal = proposeAction(root, { actor: "dip", kind: "spawn", title: "Create the writer", detail: detail("Second Shift") });
    const done = await decideAction(root, proposal.id, true);
    assert.equal(done.status, "done");
    const db = new ChatStore(root);
    try { assert.equal(db.agents().find(a => a.name === "writer")?.connector_id, id); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

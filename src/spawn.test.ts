import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { decideAction, proposeAction } from "./actions.js";
import { classifyProposal } from "./approval-policy.js";
import { links } from "./links.js";
import { minis } from "./minis.js";
import { executeOwnTool } from "./own-tools.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-spawn-"));
  const db = new ChatStore(root);
  try { db.createAgent("dip", "Dip's own SAM."); } finally { db.close(); }
  return root;
}

const DETAIL = JSON.stringify({ name: "researcher", person: "Dip's research desk", instructions: "Research topics and report back with sources." });

test("spawn: proposal validation refuses what cannot execute", () => {
  const root = fixture();
  try {
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: JSON.stringify({ name: "Researcher", person: "p", instructions: "i" }) }), /Invalid spawn name/);
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: JSON.stringify({ name: "sam", person: "p", instructions: "i" }) }), /core profile/);
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: JSON.stringify({ name: "dip", person: "p", instructions: "i" }) }), /already exists/);
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: JSON.stringify({ name: "writer", person: "p", instructions: " " }) }), /Invalid spawn instructions/);
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "spawn", title: "x", detail: JSON.stringify({ name: "writer", person: "p", instructions: "i", connectorId: "nope" }) }), /no connector with id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn: the kind is consequential - smart mode can never auto it", () => {
  assert.equal(classifyProposal("spawn", null).risk, "consequential");
});

test("spawn: approval creates the agent AND links it to its creator; rejection creates nothing", async () => {
  const root = fixture();
  try {
    const proposal = proposeAction(root, { actor: "dip", kind: "spawn", title: "Create the researcher", detail: DETAIL });
    const done = await decideAction(root, proposal.id, true);
    assert.equal(done.status, "done");
    assert.match(done.result ?? "", /Agent researcher created/);
    assert.match(done.result ?? "", /linked to dip/);
    assert.deepEqual(minis(root).map(m => m.name), ["researcher"]);
    const db = new ChatStore(root);
    try {
      assert.ok(db.agents().some(a => a.name === "researcher"), "the profile exists");
      assert.ok(db.list().some(c => c.agent_name === "researcher"), "its welcome chat exists");
    } finally { db.close(); }
    const group = links(root).find(g => g.members.includes("researcher"));
    assert.ok(group, "a link group exists");
    assert.deepEqual([...group.members].sort(), ["dip", "researcher"]);

    const second = proposeAction(root, { actor: "dip", kind: "spawn", title: "Create the writer", detail: JSON.stringify({ name: "writer", person: "p", instructions: "Write things." }) });
    const rejected = await decideAction(root, second.id, false);
    assert.equal(rejected.status, "rejected");
    assert.ok(!minis(root).some(m => m.name === "writer"), "rejection created no agent");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn: the chat tool proposes pending, and a visitor chat is refused outright", () => {
  const root = fixture();
  try {
    const db = new ChatStore(root);
    let chatId = "", visitorId = "";
    try {
      chatId = db.create("Main chat", "dip").id;
      visitorId = db.create("Web chat", "dip", { visitor: true }).id;
    } finally { db.close(); }
    const proposed = executeOwnTool(root, "dip", "sam_propose_action", { kind: "spawn", title: "Create the researcher", detail: DETAIL }, chatId) as { status?: string; kind?: string };
    assert.equal(proposed.status, "pending_owner_approval");
    assert.equal(proposed.kind, "spawn");
    const refused = executeOwnTool(root, "dip", "sam_propose_action", { kind: "spawn", title: "Create the writer", detail: JSON.stringify({ name: "writer", person: "p", instructions: "Write things." }) }, visitorId) as { error?: string };
    assert.match(refused.error ?? "", /Visitors cannot create agents/);
    assert.equal(minis(root).length, 0, "a proposal alone creates nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

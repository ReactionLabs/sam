import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLoop, dueLoops, listLoops, openLoop, openLoopCount } from "./loops.js";
import { MemoryStore } from "./memory.js";
import { buildRecallBlock } from "./recall.js";
import { executeOwnTool } from "./own-tools.js";
import { ChatStore } from "./chats.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loops-"));
}

test("open loops: open, list, filter, due, close", () => {
  const root = scratch();
  try {
    const a = openLoop(root, { profile: "sam", question: "Is the stack restarted?", answer: "Not yet, frozen since Nov 4.", watchFor: "newest candidate time advancing", dueInHours: 1 });
    const b = openLoop(root, { profile: "trading", question: "Did the verdict mix change?", answer: "No.", watchFor: "ALERT count moving" });
    assert.equal(openLoopCount(root), 2);
    assert.equal(listLoops(root, { profile: "sam" }).length, 1);
    assert.equal(dueLoops(root, new Date(Date.now() + 2 * 3_600_000)).some(l => l.id === a.id), true);
    assert.equal(dueLoops(root).length, 0);
    assert.throws(() => openLoop(root, { profile: "sam", question: "", watchFor: "x" }), /needs the question/);
    assert.throws(() => openLoop(root, { profile: "sam", question: "q", watchFor: "" }), /watchFor/);
    const closed = closeLoop(root, b.id);
    assert.equal(closed?.status, "closed");
    assert.equal(closeLoop(root, b.id), null);
    assert.equal(listLoops(root, { status: "open" }).length, 1);
    assert.equal(listLoops(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("open loops: the owner's next session opens on known ground", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try {
      store.add({ kind: "decision", source: "owner-approved action x", scope: "core", content: "Decision: public pricing stays $360 quarterly, no monthly on the shelf." });
      store.add({ kind: "observation", source: "episode:sam:2026-11-09", scope: "core", content: "Episode 2026-11-09 · profile sam · Main chat happened." });
    } finally { store.close(); }
    openLoop(root, { profile: "sam", question: "Has the first real signup landed?", answer: "Not yet, count is zero.", watchFor: "a tenant appearing that is not test traffic", dueInHours: 12 });
    const start = buildRecallBlock(root, { actor: "sam", message: "morning", sessionStart: true });
    assert.match(start, /Where things stand:/);
    assert.match(start, /Has the first real signup landed\?/);
    assert.match(start, /watching for: a tenant appearing/);
    assert.match(start, /Decision \[.*\$360 quarterly/);
    const mid = buildRecallBlock(root, { actor: "sam", message: "morning again" });
    assert.doesNotMatch(mid, /Where things stand:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("open loops: sam_open_loop records for the acting profile and refuses visitors", () => {
  const root = scratch();
  try {
    const out = executeOwnTool(root, "sam", "sam_open_loop", { question: "Is the key supplied yet?", watchFor: "a Second Shift key appearing in the vault", answer: "No." }) as { status: string; id: string };
    assert.equal(out.status, "open");
    assert.equal(listLoops(root, { profile: "sam", status: "open" })[0].id, out.id);
    const store = new ChatStore(root);
    const visitorChat = store.create("Visitor chat", null, { visitor: true });
    store.close();
    const refused = executeOwnTool(root, "sam", "sam_open_loop", { question: "q", watchFor: "w" }, visitorChat.id) as { error: string };
    assert.match(refused.error, /Visitors cannot open loops/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

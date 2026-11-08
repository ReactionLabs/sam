import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";

test("agent-attributed team events persist in their chat and reject invalid records", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-team-events-"));
  let db: ChatStore | undefined;
  let reopened: ChatStore | undefined;
  try {
    db = new ChatStore(root);
    const a = db.create("Research");
    const b = db.create("Engineering");
    db.addEvent(a.id, "ss-research", "message", "Found three sources");
    db.addEvent(a.id, "ss-qa", "result", "Verified two sources");
    assert.equal(db.events(a.id).length, 2);
    assert.deepEqual(db.events(b.id), []);
    assert.throws(() => db!.addEvent(a.id, "../unsafe", "tool", "No"), /Invalid team event/);
    assert.throws(() => db!.addEvent("missing", "ss-qa", "result", "No"), /Chat not found/);
    db.close();
    db = undefined;
    reopened = new ChatStore(root);
    assert.equal(reopened.events(a.id)[0].agent, "ss-research");
  } finally {
    reopened?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

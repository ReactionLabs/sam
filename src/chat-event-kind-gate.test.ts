import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, teamEventKindBlocker, teamEventKinds } from "./chats.js";

// The chat event kind gate: the kind is a registry name
// (teamEventKinds in chats.ts: message, tool, result,
// assignment) that every team event names into
// ChatStore.addEvent, the ONE seam every kind rides (the
// CLI `chats event --kind` door casts the person's raw
// kind straight into it; the team runtime and
// orchestration writers name theirs there too).
// addEvent refused an unknown kind with the bare
// "Invalid team event" - the same text that also covers
// a bad agent shape and bad content, so the bad value
// was never echoed, none of the kinds named, and no fold
// correction offered. teamEventKindBlocker in chats.ts
// is now the ONE source carrying the refusal text,
// thrown before the remaining validation (which keeps
// the bare text). Stored event kinds are unchanged:
// read back as stored, never re-validated.

test("chat event kind gate: every exact kind reads no blocker", () => {
  for (const kind of teamEventKinds) assert.equal(teamEventKindBlocker(kind), null, kind);
  assert.equal(teamEventKinds.length, 4);
});

test("chat event kind gate: an unknown kind echoes the value and names the kinds, no correction", () => {
  assert.equal(
    teamEventKindBlocker("note"),
    "Invalid team event kind \"note\". Kinds: message, tool, result, assignment",
  );
});

test("chat event kind gate: a folded name is refused with the correction", () => {
  assert.match(teamEventKindBlocker("Message")!, /Did you mean "message"\?$/);
  assert.match(teamEventKindBlocker("Assign-ment")!, /Did you mean "assignment"\?$/);
  assert.match(teamEventKindBlocker("re_sult")!, /Did you mean "result"\?$/);
});

test("chat event kind gate: a non-string or empty value refuses naming the kinds, no correction", () => {
  assert.match(teamEventKindBlocker(42)!, /^Invalid team event kind "42"\. Kinds:/);
  assert.doesNotMatch(teamEventKindBlocker(42)!, /Did you mean/);
  assert.match(teamEventKindBlocker("")!, /^Invalid team event kind ""\. Kinds:/);
  assert.doesNotMatch(teamEventKindBlocker("")!, /Did you mean/);
});

test("chat event kind gate: the addEvent seam refuses a folded kind before recording anything, and an exact kind adds", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-event-kind-gate-"));
  let db: ChatStore | undefined;
  try {
    db = new ChatStore(root);
    const chat = db.create("Gate chat");
    assert.throws(() => db!.addEvent(chat.id, "sam", "Message" as never, "Hello"), /Did you mean "message"\?$/);
    assert.throws(() => db!.addEvent(chat.id, "sam", "note" as never, "Hello"), /^Error: Invalid team event kind "note"\. Kinds:/);
    assert.deepEqual(db.events(chat.id), []);
    const event = db.addEvent(chat.id, "sam", "message", "Hello");
    assert.equal(event.kind, "message");
    assert.equal(db.events(chat.id).length, 1);
    // The other validation failures keep the bare text.
    assert.throws(() => db!.addEvent(chat.id, "../unsafe", "tool", "No"), /^Error: Invalid team event$/);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

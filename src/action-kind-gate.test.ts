import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_KINDS, actionKindBlocker, listActions, proposeAction } from "./actions.js";

// The action-kind gate: the action kind is a registry name
// (KINDS / ACTION_KINDS in actions.ts: note, law, heartbeat,
// say, skill, draft, skill-author, git-push, engine, spawn,
// delegate, pair) that two doors resolved in two improvised
// ways - proposeAction threw the bare "Invalid action kind"
// naming none of the twelve and offering no fold correction,
// and the CLI `actions set-mode --auto` door improvised a
// second "Unknown action kind(s)" text for the same
// registry. actionKindBlocker in actions.ts is now the ONE
// source carrying the refusal text, and proposeAction throws
// it, so the CLI propose door, the ONE gate itself, and the
// set-mode --auto door all refuse in the same words. The
// scorecard bucket parsers and classifyProposal stay
// permissive by design (an unknown stored kind folds to
// "other" or classifies consequential; they never refuse a
// person).

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-action-kind-gate-"));
}

test("action kind gate: every exact kind reads no blocker", () => {
  for (const kind of ACTION_KINDS) assert.equal(actionKindBlocker(kind), null, kind);
  assert.equal(ACTION_KINDS.length, 12);
});

test("action kind gate: an unknown kind names the kinds, no correction", () => {
  assert.equal(
    actionKindBlocker("teleport"),
    "Invalid action kind \"teleport\". Kinds: note, law, heartbeat, say, skill, draft, skill-author, git-push, engine, spawn, delegate, pair",
  );
});

test("action kind gate: a folded name is refused with the correction", () => {
  assert.match(actionKindBlocker("Git Push")!, /Did you mean "git-push"\?$/);
  assert.match(actionKindBlocker("git_push")!, /Did you mean "git-push"\?$/);
  assert.match(actionKindBlocker("Skill Author")!, /Did you mean "skill-author"\?$/);
  assert.match(actionKindBlocker("NOTE")!, /Did you mean "note"\?$/);
});

test("action kind gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(actionKindBlocker(42), "Invalid action kind \"42\". Kinds: note, law, heartbeat, say, skill, draft, skill-author, git-push, engine, spawn, delegate, pair");
  assert.equal(actionKindBlocker(""), "Invalid action kind \"\". Kinds: note, law, heartbeat, say, skill, draft, skill-author, git-push, engine, spawn, delegate, pair");
});

test("action kind gate: proposeAction throws the ONE source and proposes nothing; an exact kind still proposes", () => {
  const root = fresh();
  try {
    assert.throws(
      () => proposeAction(root, { actor: "sam", kind: "Git Push", title: "T", detail: "D" }),
      (e: unknown) => e instanceof Error && e.message === actionKindBlocker("Git Push"),
    );
    assert.throws(
      () => proposeAction(root, { actor: "sam", kind: "teleport", title: "T", detail: "D" }),
      (e: unknown) => e instanceof Error && e.message === actionKindBlocker("teleport"),
    );
    assert.deepEqual(listActions(root), []);
    const ok = proposeAction(root, { actor: "sam", kind: "note", title: "T", detail: "D" });
    assert.equal(ok.kind, "note");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

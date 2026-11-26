import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft, draftChannelBlocker, draftShapeBlocker, listDrafts } from "./drafts.js";

// The draft-channel gate: the draft channel is a registry
// name (CHANNELS in drafts.ts: email, text, message,
// letter, other) that a person types at the CLI
// `drafts create --channel` door and the model names in a
// draft proposal detail. draftShapeBlocker was already the
// ONE source for draft shape, but its channel refusal was
// bare - "Invalid draft channel" named none of the five
// and offered no fold correction, so a separator fold
// ("e-mail", "e mail") dead-ended with nothing to act on.
// draftChannelBlocker in drafts.ts is now the ONE source
// carrying the channel refusal text, and draftShapeBlocker
// returns it for the channel field, so the CLI door,
// createDraft at write time, and the ONE gate's
// validateDraftDetail at proposal time all refuse in the
// same words. CHANNELS and parseDraftSummary stay
// permissive by design (the scorecard's bucket parser
// reads stored ledger text raw).

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-draft-channel-gate-"));
}

test("draft channel gate: an exact or absent channel reads no blocker", () => {
  assert.equal(draftChannelBlocker(undefined), null);
  assert.equal(draftChannelBlocker(null), null);
  assert.equal(draftChannelBlocker("email"), null);
  assert.equal(draftChannelBlocker("text"), null);
  assert.equal(draftChannelBlocker("message"), null);
  assert.equal(draftChannelBlocker("letter"), null);
  assert.equal(draftChannelBlocker("other"), null);
  // Measured exactly as draftShapeBlocker measures: trimmed
  // and lowercased, so case and padding are not folds here.
  assert.equal(draftChannelBlocker(" Email "), null);
  assert.equal(draftShapeBlocker({ to: "A", channel: "email", body: "hi" }), null);
  assert.equal(draftShapeBlocker({ to: "A", body: "hi" }), null);
});

test("draft channel gate: an unknown channel names the channels, no correction", () => {
  const blocker = draftChannelBlocker("pigeon")!;
  assert.equal(blocker, "Invalid draft channel \"pigeon\". Channels: email, text, message, letter, other");
  assert.equal(draftShapeBlocker({ to: "A", channel: "pigeon", body: "hi" }), blocker);
  const root = fresh();
  try {
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", channel: "pigeon", body: "hi" }), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft channel gate: a folded name is refused with the correction", () => {
  assert.match(draftChannelBlocker("e-mail")!, /Did you mean "email"\?$/);
  assert.match(draftChannelBlocker("e mail")!, /Did you mean "email"\?$/);
  assert.match(draftChannelBlocker("E-Mail")!, /Did you mean "email"\?$/);
  const root = fresh();
  try {
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", channel: "e-mail", body: "hi" }), (e: unknown) => e instanceof Error && e.message === draftChannelBlocker("e-mail"));
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft channel gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(draftChannelBlocker(42), "Invalid draft channel \"42\". Channels: email, text, message, letter, other");
  assert.equal(draftChannelBlocker(""), "Invalid draft channel \"\". Channels: email, text, message, letter, other");
  assert.equal(draftShapeBlocker({ to: "A", channel: 42 as never, body: "hi" }), draftChannelBlocker(42));
});

test("draft channel gate: an exact channel still creates through createDraft", () => {
  const root = fresh();
  try {
    const draft = createDraft(root, { actor: "sam", to: "A", channel: "email", body: "hi" });
    assert.equal(draft.channel, "email");
    assert.equal(listDrafts(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

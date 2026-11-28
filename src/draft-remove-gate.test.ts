import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft, draftRemoveBlocker, findDraft, listDrafts, removeDraft, type Draft } from "./drafts.js";

// The draft gate for the drafts remove door: drafts are
// listed by their UUID id, but `sam drafts remove <id>`
// rode removeDraft alone, so an unknown id - or a real id
// typed folded (upper-case, or without its hyphens, the two
// ways a UUID gets copied out of a listing) - silently
// returned {removed:false}, naming nothing, at the door
// that discards a draft (the only way a draft ends besides
// the owner copying it out). Drafts carry no human name:
// the id IS the key, so the registry the blocker names is
// the drafts themselves, each described ONLY by id,
// channel, actor, and created stamp - a draft's recipient,
// subject, and body are the owner's outbound words and
// never enter a refusal. The CLI remove door now resolves
// through findDraft (throwing draftRemoveBlocker, the ONE
// source over the drafts registry alone, before anything
// is removed) and removes by the resolved id; removeDraft
// keeps its boolean contract (false on a miss) for
// internal callers - the store seam stays permissive by
// design.

function fresh(): { root: string; first: Draft; second: Draft } {
  const root = mkdtempSync(join(tmpdir(), "sam-draft-remove-gate-"));
  const first = createDraft(root, { actor: "sam", to: "Johnny Davis", channel: "email", subject: "Pickup Thursday", body: "Hey Johnny, confirming Thursday." });
  const second = createDraft(root, { actor: "sam", to: "Rick Ruiz", channel: "text", body: "Thanks for the referral, Rick." });
  return { root, first, second };
}

function describe(d: Draft): string {
  return d.id + " (channel " + d.channel + ", actor " + d.actor + ", created " + d.createdAt + ")";
}

test("draft remove gate: an exact id reads no blocker and removes by the resolved id", () => {
  const { root, first } = fresh();
  try {
    assert.equal(draftRemoveBlocker(root, first.id), null);
    const resolved = findDraft(root, first.id);
    assert.equal(resolved.id, first.id);
    assert.equal(removeDraft(root, resolved.id), true);
    assert.equal(listDrafts(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: an upper-case folded id is refused with the correction, removes nothing, and leaks no draft content", () => {
  const { root, first, second } = fresh();
  try {
    const folded = first.id.toUpperCase();
    const blocker = draftRemoveBlocker(root, folded)!;
    assert.equal(
      blocker,
      "Draft not found: \"" + folded + "\". Drafts: "
        + describe(first) + ", " + describe(second)
        + ". Did you mean \"" + first.id + "\"?",
    );
    assert.doesNotMatch(blocker, /Johnny|Rick|Pickup|referral/);
    assert.throws(() => findDraft(root, folded), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.equal(listDrafts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: a hyphenless folded id corrects the same way", () => {
  const { root, second } = fresh();
  try {
    const folded = second.id.replace(/-/g, "");
    const blocker = draftRemoveBlocker(root, folded)!;
    assert.match(blocker, new RegExp("\\. Did you mean \"" + second.id + "\"\\?$"));
    assert.equal(listDrafts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: an unknown id names the registry with no correction", () => {
  const { root, first, second } = fresh();
  try {
    const blocker = draftRemoveBlocker(root, "ghost")!;
    assert.equal(
      blocker,
      "Draft not found: \"ghost\". Drafts: " + describe(first) + ", " + describe(second),
    );
    assert.throws(() => findDraft(root, "ghost"));
    assert.equal(listDrafts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-draft-remove-gate-"));
  try {
    assert.equal(draftRemoveBlocker(root, "ghost"), "Draft not found: \"ghost\". Drafts: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-draft-remove-gate-"));
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first: Draft = { id: "a-bc", actor: "sam", to: "A", channel: "email", subject: null, body: "one", status: "draft", createdAt: "2026-11-10T13:16:00.000Z", via: "cli" };
    const second: Draft = { id: "ab-c", actor: "sam", to: "B", channel: "text", subject: null, body: "two", status: "draft", createdAt: "2026-11-10T13:16:00.000Z", via: "cli" };
    writeFileSync(join(root, ".sam", "drafts.json"), JSON.stringify([first, second], null, 2));
    const blocker = draftRemoveBlocker(root, "ABC")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(listDrafts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft remove gate: the store seam keeps its boolean contract", () => {
  const { root, first } = fresh();
  try {
    assert.equal(removeDraft(root, "nope"), false);
    assert.equal(removeDraft(root, first.id), true);
    assert.equal(removeDraft(root, first.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

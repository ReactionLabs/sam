import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel } from "./channels.js";
import { bindingRemoveBlocker, findBinding, listBindings, removeBinding, setBinding, type Binding } from "./bindings.js";

// The binding gate for the channel unbind door: bindings
// are created as (channel, peer) -> profile routing rules
// and listed by their UUID id, but `sam channels unbind
// <id>` rode removeBinding alone, so an unknown id - or a
// real id typed folded (upper-case, or without its
// hyphens, the two ways a UUID gets copied out of a
// listing) - silently returned {removed:false}, naming
// nothing, at the door that deletes a routing rule.
// Bindings carry no human name: the id IS the key, so the
// registry the blocker names is the bindings themselves,
// each described by channel, peer (or channel-wide), and
// profile. The CLI unbind door now resolves through
// findBinding (throwing bindingRemoveBlocker, the ONE
// source over the bindings registry alone, before
// anything is removed) and removes by the resolved id;
// removeBinding keeps its boolean contract (false on a
// miss) for internal callers - the store seam stays
// permissive by design.

function fresh(): { root: string; wideId: string; peerId: string } {
  const root = mkdtempSync(join(tmpdir(), "sam-binding-remove-gate-"));
  const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111, 222]);
  const wide = setBinding(root, { channelId: channel.id, peer: null, profile: "researcher" });
  const peer = setBinding(root, { channelId: channel.id, peer: "111", profile: "second-shift" });
  return { root, wideId: wide.id, peerId: peer.id };
}

test("binding remove gate: an exact id reads no blocker and removes by the resolved id", () => {
  const { root, wideId } = fresh();
  try {
    assert.equal(bindingRemoveBlocker(root, wideId), null);
    const resolved = findBinding(root, wideId);
    assert.equal(resolved.id, wideId);
    assert.equal(removeBinding(root, resolved.id), true);
    assert.deepEqual(listBindings(root).map(b => b.id), [findBinding(root, listBindings(root)[0].id).id]);
    assert.equal(listBindings(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: an upper-case folded id is refused with the correction and removes nothing", () => {
  const { root, wideId, peerId } = fresh();
  try {
    const folded = wideId.toUpperCase();
    const blocker = bindingRemoveBlocker(root, folded)!;
    assert.equal(
      blocker,
      "Binding not found: \"" + folded + "\". Bindings: "
        + wideId + " (channel Dip Telegram, peer channel-wide, profile researcher), "
        + peerId + " (channel Dip Telegram, peer 111, profile second-shift)"
        + ". Did you mean \"" + wideId + "\"?",
    );
    assert.throws(() => findBinding(root, folded), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.equal(listBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: a hyphenless folded id corrects the same way", () => {
  const { root, peerId } = fresh();
  try {
    const folded = peerId.replace(/-/g, "");
    const blocker = bindingRemoveBlocker(root, folded)!;
    assert.match(blocker, new RegExp("\\. Did you mean \"" + peerId + "\"\\?$"));
    assert.equal(listBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: an unknown id names the registry with no correction", () => {
  const { root, wideId, peerId } = fresh();
  try {
    const blocker = bindingRemoveBlocker(root, "ghost")!;
    assert.equal(
      blocker,
      "Binding not found: \"ghost\". Bindings: "
        + wideId + " (channel Dip Telegram, peer channel-wide, profile researcher), "
        + peerId + " (channel Dip Telegram, peer 111, profile second-shift)",
    );
    assert.throws(() => findBinding(root, "ghost"));
    assert.equal(listBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-binding-remove-gate-"));
  try {
    assert.equal(bindingRemoveBlocker(root, "ghost"), "Binding not found: \"ghost\". Bindings: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-binding-remove-gate-"));
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", []);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first: Binding = { id: "a-bc", channelId: channel.id, peer: null, profile: "researcher", createdAt: "2026-11-10T13:16:00.000Z" };
    const second: Binding = { id: "ab-c", channelId: channel.id, peer: "111", profile: "trading", createdAt: "2026-11-10T13:16:00.000Z" };
    writeFileSync(join(root, ".sam", "bindings.json"), JSON.stringify([first, second], null, 2));
    const blocker = bindingRemoveBlocker(root, "ABC")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(listBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding remove gate: the store seam keeps its boolean contract", () => {
  const { root, wideId } = fresh();
  try {
    assert.equal(removeBinding(root, "nope"), false);
    assert.equal(removeBinding(root, wideId), true);
    assert.equal(removeBinding(root, wideId), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addLinkMember, createLink, linkProfileBlocker, links } from "./links.js";

// The profile gate for the link door: every profile-naming
// door reads the profile registry through a ONE source in
// its owning module carrying the refusal text with a fold
// correction - but createLink and addLinkMember checked
// members through a boolean helper and refused with the
// bare "Unknown profile: X", naming no registry and offering
// no correction, while every sibling door names both.
// linkProfileBlocker in links.ts is now the ONE source
// carrying the refusal text, and both member checks throw
// it, so the operator CLI links doors and the ONE gate
// executor's spawn-link path (which rides createLink) all
// refuse in the same words before anything is linked.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-link-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("link profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(linkProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(linkProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      linkProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in link detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      linkProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in link detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      linkProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in link detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      linkProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in link detail. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link profile gate: createLink throws the ONE source's words and links nothing", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.throws(
      () => createLink(root, "bridge", ["sam", "Second Shift"]),
      (e: unknown) => e instanceof Error && e.message === "Unknown profile \"Second Shift\" in link detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.deepEqual(links(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link profile gate: addLinkMember throws the ONE source's words; a registered member adds cleanly", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "trading");
    const group = createLink(root, "bridge", ["sam", "second-shift"]);
    assert.throws(
      () => addLinkMember(root, group.id, "Second Shift"),
      (e: unknown) => e instanceof Error && e.message === "Unknown profile \"Second Shift\" in link detail. Valid profiles: sam, second-shift, trading. Did you mean \"second-shift\"?",
    );
    assert.deepEqual(links(root)[0]?.members, ["sam", "second-shift"]);
    const grown = addLinkMember(root, group.id, "trading");
    assert.deepEqual(grown.members, ["sam", "second-shift", "trading"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

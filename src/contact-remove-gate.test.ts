import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contactRemoveBlocker, findContact, listContacts, removeContact, upsertContact } from "./contacts.js";

// The contact gate for the remove door: contacts are
// added by display name, listed and ledgered by slug, and
// every sibling registry's remove door (channels,
// heartbeats, vault, minis, team members) reads its
// registry through a fold-corrected ONE source, but
// `sam contacts remove <name>` rode removeContact alone -
// no description at all - so an unknown name, or one
// typed without its separator ("JohnnyDavis" for the
// slug johnny-davis), silently returned {removed:false},
// naming nothing, and at the door that deletes a person's
// Address Book entry the owner could not tell a fold or a
// typo from a genuinely absent person. Contacts are keyed
// by slug, so a value whose slug names a registered
// contact is an exact match. The CLI remove door now
// resolves through findContact (throwing
// contactRemoveBlocker, the ONE source naming the
// registry with a fold correction, before anything is
// removed) and removes by the resolved slug;
// removeContact keeps its boolean contract (false on a
// miss) for internal callers - the store seam stays
// permissive by design.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-contact-remove-gate-"));
  upsertContact(root, { name: "Johnny Davis", note: "Texts are fine" });
  upsertContact(root, { name: "Cy B", note: "Reviewer" });
  return root;
}

test("contact remove gate: a name the door's slug rule resolves reads no blocker and removes by the resolved slug", () => {
  const root = fresh();
  try {
    assert.equal(contactRemoveBlocker(root, "Johnny Davis"), null);
    assert.equal(contactRemoveBlocker(root, "johnny-davis"), null);
    assert.equal(contactRemoveBlocker(root, "JOHNNY DAVIS"), null);
    const resolved = findContact(root, "Johnny Davis");
    assert.equal(resolved.name, "johnny-davis");
    assert.equal(removeContact(root, resolved.name), true);
    assert.deepEqual(listContacts(root).map(c => c.name), ["cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: a separator-folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const blocker = contactRemoveBlocker(root, "JohnnyDavis")!;
    assert.equal(
      blocker,
      "Contact not found: \"JohnnyDavis\". Contacts: johnny-davis, cy-b. Did you mean \"johnny-davis\"?",
    );
    assert.throws(() => findContact(root, "JohnnyDavis"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // contact is still registered afterwards.
    assert.deepEqual(listContacts(root).map(c => c.name), ["johnny-davis", "cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: a missing-separator name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = contactRemoveBlocker(root, "CYB")!;
    assert.match(blocker, /Did you mean "cy-b"\?$/);
    assert.deepEqual(listContacts(root).map(c => c.name), ["johnny-davis", "cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: an unknown name names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = contactRemoveBlocker(root, "ghost")!;
    assert.equal(blocker, "Contact not found: \"ghost\". Contacts: johnny-davis, cy-b");
    assert.throws(() => findContact(root, "ghost"));
    assert.equal(listContacts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-contact-remove-gate-"));
  try {
    assert.equal(contactRemoveBlocker(root, "ghost"), "Contact not found: \"ghost\". Contacts: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-contact-remove-gate-"));
  try {
    upsertContact(root, { name: "A Bc", note: "one" });
    upsertContact(root, { name: "Ab C", note: "two" });
    const blocker = contactRemoveBlocker(root, "A B C")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(listContacts(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeContact(root, "nope"), false);
    assert.equal(removeContact(root, "Johnny Davis"), true);
    assert.equal(removeContact(root, "Johnny Davis"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listContacts, getContact, upsertContact, removeContact, draftBlockedFor, contactSlug } from "./contacts.js";

test("contacts: a permission note is stored per person and updates in place", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-contacts-"));
  try {
    assert.deepEqual(listContacts(root), []);
    const c = upsertContact(root, { name: "Johnny Davis", note: "Texts are fine, keep them short" });
    assert.equal(c.name, "johnny-davis");
    assert.equal(c.display, "Johnny Davis");
    assert.equal(c.noDraft, false);
    const again = upsertContact(root, { name: "Johnny Davis", note: "Text only, never email" });
    assert.equal(again.note, "Text only, never email");
    assert.equal(listContacts(root).length, 1);
    // A partial update leaves the note alone.
    const flagged = upsertContact(root, { name: "Johnny Davis", noDraft: true });
    assert.equal(flagged.note, "Text only, never email");
    assert.equal(flagged.noDraft, true);
    assert.equal(getContact(root, "johnny davis")?.noDraft, true);
    assert.equal(removeContact(root, "Johnny Davis"), true);
    assert.equal(removeContact(root, "Johnny Davis"), false);
    assert.deepEqual(listContacts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts: draftBlockedFor fires only on an explicit no-drafts mark", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-contacts2-"));
  try {
    assert.equal(draftBlockedFor(root, "Anyone"), null); // no record, no restriction
    upsertContact(root, { name: "Open Person", note: "Draft freely" });
    assert.equal(draftBlockedFor(root, "Open Person"), null);
    upsertContact(root, { name: "Closed Person", note: "Never write to her", noDraft: true });
    assert.equal(draftBlockedFor(root, "Closed Person")?.display, "Closed Person");
    upsertContact(root, { name: "Closed Person", noDraft: false });
    assert.equal(draftBlockedFor(root, "Closed Person"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts: slugs are forgiving, junk is refused", () => {
  assert.equal(contactSlug("  Mary Jane Watson "), "mary-jane-watson");
  assert.equal(contactSlug("!!!"), "");
  const root = mkdtempSync(join(tmpdir(), "sam-contacts3-"));
  try {
    assert.throws(() => upsertContact(root, { name: "!!!" }), /Invalid contact name/);
    assert.throws(() => upsertContact(root, { name: "Ok Name", note: "x".repeat(2001) }), /Invalid contact note/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

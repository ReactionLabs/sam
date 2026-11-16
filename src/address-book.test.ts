import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressBookDir, contactOfferState, draftBlockedFor, getContact, listContacts,
  recordContactOffer, removeContact, upsertContact, writeAddressBook,
} from "./contacts.js";
import { describeToolSources } from "./source-citations.js";

// The Address Book (Dip, 2026-11-16): the contacts store is SAM's
// people file. These pins: people fields ride the same record as
// the permission note (one store, no competing registry); every
// write re-renders the people directory in the same act; unknown
// fields stay absent (nothing is invented); the offer bookkeeping
// makes "never offer again after a no" a checkable fact; and the
// noDraft hard rule is untouched by the people fields.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-address-book-"));
}

test("address book: people fields round-trip on the same record as the permission note", () => {
  const root = scratch();
  try {
    const saved = upsertContact(root, {
      name: "Maria Testcase", relationship: "cousin", email: "maria@example.test",
      phone: "555-0100", handles: ["@maria on X"], notes: ["Lives in Tampa"],
      special: true, sourceChat: "chat-aaa",
    });
    assert.equal(saved.relationship, "cousin");
    assert.equal(saved.email, "maria@example.test");
    assert.equal(saved.special, true);
    assert.deepEqual(saved.sourceChats, ["chat-aaa"]);
    assert.ok(saved.firstMentionedAt && saved.lastMentionedAt);
    // A later fact lands as an append and a new source, nothing else moves.
    const updated = upsertContact(root, { name: "Maria Testcase", notes: ["Getting married in June"], sourceChat: "chat-bbb" });
    assert.deepEqual(updated.notes, ["Lives in Tampa", "Getting married in June"]);
    assert.equal(updated.relationship, "cousin", "a partial update never clears a stated field");
    assert.deepEqual(updated.sourceChats, ["chat-aaa", "chat-bbb"]);
    // The permission note still lives on the same record, separately.
    const noted = upsertContact(root, { name: "Maria Testcase", note: "Text first, never call early" });
    assert.equal(noted.note, "Text first, never call early");
    assert.equal(noted.relationship, "cousin");
    assert.equal(listContacts(root).length, 1, "one person, one record");
    assert.equal(getContact(root, "maria testcase")?.email, "maria@example.test");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("address book: every write re-renders the people directory; special sit on top of the index; remove deletes the page", () => {
  const root = scratch();
  try {
    upsertContact(root, { name: "Zed Plain", relationship: "neighbor" });
    upsertContact(root, { name: "Maria Testcase", relationship: "cousin", email: "maria@example.test", special: true, notes: ["Lives in Tampa"] });
    const dir = addressBookDir(root);
    const maria = readFileSync(join(dir, "maria-testcase.md"), "utf8");
    assert.match(maria, /^# Maria Testcase ★/);
    assert.match(maria, /Relationship: cousin/);
    assert.match(maria, /Email: maria@example\.test/);
    assert.match(maria, /- Lives in Tampa/);
    const zed = readFileSync(join(dir, "zed-plain.md"), "utf8");
    assert.doesNotMatch(zed, /Email:/, "unknown fields stay blank - no invented detail lines");
    assert.doesNotMatch(zed, /★/, "no special mark without the flag");
    const index = readFileSync(join(dir, "INDEX.md"), "utf8");
    const mariaAt = index.indexOf("Maria Testcase");
    const zedAt = index.indexOf("Zed Plain");
    assert.ok(mariaAt >= 0 && zedAt >= 0 && mariaAt < zedAt, "the special person is listed first");
    // An update re-renders in the same act.
    upsertContact(root, { name: "Zed Plain", email: "zed@example.test" });
    assert.match(readFileSync(join(dir, "zed-plain.md"), "utf8"), /Email: zed@example\.test/);
    // A remove deletes the page and the index line.
    assert.equal(removeContact(root, "Zed Plain"), true);
    assert.equal(existsSync(join(dir, "zed-plain.md")), false);
    assert.doesNotMatch(readFileSync(join(dir, "INDEX.md"), "utf8"), /Zed Plain/);
    // The export door regenerates from the store on demand.
    const written = writeAddressBook(root);
    assert.equal(written.people, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("address book: a permission-only record renders honestly and noDraft still refuses drafts", () => {
  const root = scratch();
  try {
    upsertContact(root, { name: "Closed Person", note: "Never write to her", noDraft: true });
    const page = readFileSync(join(addressBookDir(root), "closed-person.md"), "utf8");
    assert.match(page, /Never write to her/);
    assert.match(page, /NO DRAFTS/);
    assert.doesNotMatch(page, /Relationship:/, "no relationship was ever stated, so none is shown");
    assert.equal(draftBlockedFor(root, "Closed Person")?.display, "Closed Person", "the hard rule is intact");
    upsertContact(root, { name: "Closed Person", relationship: "aunt" });
    assert.equal(draftBlockedFor(root, "Closed Person")?.display, "Closed Person", "people fields never weaken the mark");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("address book: offer bookkeeping is once-only and a pure read creates nothing", () => {
  const root = scratch();
  try {
    assert.equal(contactOfferState(root, "New Person"), null);
    assert.equal(existsSync(join(root, ".sam", "contacts.db")), false, "reading offer state on an empty install creates no store");
    recordContactOffer(root, "New Person", "offered");
    assert.equal(contactOfferState(root, "New Person"), "offered");
    recordContactOffer(root, "New Person", "declined");
    assert.equal(contactOfferState(root, "new person"), "declined", "the no is recorded and readable by slug");
    assert.deepEqual(listContacts(root), [], "an offer never creates a person record");
    assert.equal(existsSync(join(addressBookDir(root), "new-person.md")), false, "and never a people page");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("address book: junk people fields are refused like junk names always were", () => {
  const root = scratch();
  try {
    assert.throws(() => upsertContact(root, { name: "Ok Name", relationship: "x".repeat(201) }), /Invalid contact relationship/);
    assert.throws(() => upsertContact(root, { name: "Ok Name", notes: ["x".repeat(1001)] }), /Invalid contact fact note/);
    assert.deepEqual(listContacts(root), [], "a refused write saves nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("address book: a recall grounds its citation in the people file", () => {
  const shown = describeToolSources("sam_address_book", { action: "show", name: "Maria Testcase" },
    { found: true, slug: "maria-testcase", display: "Maria Testcase", contact: { name: "Maria Testcase" } });
  assert.equal(shown.length, 1);
  assert.match(shown[0].descriptor, /Address Book entry: Maria Testcase/);
  assert.match(shown[0].descriptor, /maria-testcase\.md/);
  const saved = describeToolSources("sam_address_book", { action: "save", name: "Maria Testcase" },
    { status: "saved", slug: "maria-testcase", display: "Maria Testcase" });
  assert.deepEqual(saved, [], "a save is an action: it grounds nothing, like every other write");
  const missing = describeToolSources("sam_address_book", { action: "show", name: "Ghost" }, { found: false, name: "Ghost" });
  assert.deepEqual(missing, [], "a miss grounds nothing");
});

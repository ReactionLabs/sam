import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  contactFailureSummary, draftBlockedFor, getContact, isContactLedgered,
  listContacts, removeContact, updateContact, upsertContact,
} from "./contacts.js";
import { classifyDefect } from "./self-work.js";

// Contact store failure visibility (gap found 2026-11-14,
// hourly run 15:04): the contact store holds the per-person
// permission notes and the noDraft hard rule - listContacts
// rides the dashboard status build, draftBlockedFor rides
// every draft creation, and the CLI writes ride upsert /
// update / remove - and every touch opened the store raw: a
// dead contacts.db threw into whichever catch wrapped the
// call, none naming the store. Each touch now ledgers ONE
// contact-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// the permission check still fails closed (never folded as
// no contacts, which would drop a noDraft mark).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-contacts-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "contact-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "contacts.db"), { force: true });
  mkdirSync(join(root, ".sam", "contacts.db"), { recursive: true });
}

test("contact-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(contactFailureSummary("read", "unable to open\n  database   file"), "Contact read failed: unable to open database file");
  assert.equal(contactFailureSummary("write", "disk gone"), "Contact write failed: disk gone");
  assert.equal(contactFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "contact-failed", summary: contactFailureSummary(phase, "boom") }),
      { key: "contact-failed:" + phase, label: "contact store failures (" + phase + " step)" },
    );
  }
});

test("contact-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    upsertContact(root, { name: "Closed Person", note: "Owner handles her personally", noDraft: true });
    plantDeadStore(root);

    assert.throws(() => listContacts(root), (e: unknown) => isContactLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Contact read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "contact-failed:read", label: "contact store failures (read step)" });

    assert.throws(() => getContact(root, "Closed Person"), (e: unknown) => isContactLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the get touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Contact read failed: "), lines[1].summary);

    assert.throws(() => draftBlockedFor(root, "Closed Person"), (e: unknown) => isContactLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the draft block check rides the read door: exactly one line, never a second for the same touch");
    assert.ok(lines[2].summary.startsWith("Contact read failed: "), lines[2].summary);

    assert.throws(() => upsertContact(root, { name: "New Person", note: "ok" }), (e: unknown) => isContactLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the upsert touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Contact write failed: "), lines[3].summary);
    assert.deepEqual(classifyDefect(lines[3]), { key: "contact-failed:write", label: "contact store failures (write step)" });

    assert.throws(() => updateContact(root, "Closed Person", { note: "changed" }), (e: unknown) => isContactLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the update touch ledgers exactly one more line");
    assert.ok(lines[4].summary.startsWith("Contact write failed: "), lines[4].summary);

    assert.throws(() => removeContact(root, "Closed Person"), (e: unknown) => isContactLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 6, "the remove touch ledgers exactly one more line");
    assert.ok(lines[5].summary.startsWith("Contact write failed: "), lines[5].summary);

    assert.ok(!JSON.stringify(lines).includes("Closed Person"), "no contact record ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Owner handles"), "no note text ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact-failed: an absent store reads as no contacts, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(listContacts(root), []);
    assert.equal(getContact(root, "Anyone"), null);
    assert.equal(draftBlockedFor(root, "Anyone"), null);
    assert.equal(updateContact(root, "Anyone", { note: "x" }), null);
    assert.equal(removeContact(root, "Anyone"), false);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "contacts.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => upsertContact(root, { name: "   " }), /Invalid contact name/);
    assert.throws(() => upsertContact(root, { name: "Fine Name", note: "x".repeat(2001) }), /Invalid contact note/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contact-failed: a healthy store upserts, blocks, updates, and removes with zero failure lines", () => {
  const root = scratch();
  try {
    const added = upsertContact(root, { name: "Closed Person", note: "Owner handles her personally", noDraft: true });
    assert.equal(added.noDraft, true);
    assert.equal(listContacts(root).length, 1);
    assert.equal(getContact(root, "Closed Person")?.name, "closed-person");
    assert.equal(draftBlockedFor(root, "Closed Person")?.display, "Closed Person");
    const updated = updateContact(root, "Closed Person", { noDraft: false });
    assert.equal(updated?.noDraft, false);
    assert.equal(draftBlockedFor(root, "Closed Person"), null);
    assert.equal(removeContact(root, "Closed Person"), true);
    assert.deepEqual(listContacts(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

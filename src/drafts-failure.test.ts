import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { upsertContact } from "./contacts.js";
import {
  createDraft, draftFailureSummary, getDraft, isDraftLedgered,
  listDrafts, removeDraft, updateDraft,
} from "./drafts.js";
import { classifyDefect } from "./self-work.js";

// Draft store failure visibility (gap found 2026-11-14,
// hourly run 16:04): the draft store holds SAM's outbound
// drafts (P12: stored text, no send surface) - listDrafts
// rides the dashboard status build, createDraft rides the
// CLI and the ONE gate's draft executor, and update /
// remove are the update and discard doors - and every
// touch opened the store raw: a dead drafts.db threw into
// whichever catch wrapped the call, none naming the store.
// Each touch now ledgers ONE draft-failed line (phase
// read / write) and rethrows exactly, tagged; every
// caller's handling is unchanged and reads still fail
// closed (never folded as no drafts, which would hide
// drafts the owner still means to send).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-drafts-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "draft-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "drafts.db"), { force: true });
  mkdirSync(join(root, ".sam", "drafts.db"), { recursive: true });
}

test("draft-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(draftFailureSummary("read", "unable to open\n  database   file"), "Draft read failed: unable to open database file");
  assert.equal(draftFailureSummary("write", "disk gone"), "Draft write failed: disk gone");
  assert.equal(draftFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "draft-failed", summary: draftFailureSummary(phase, "boom") }),
      { key: "draft-failed:" + phase, label: "draft store failures (" + phase + " step)" },
    );
  }
});

test("draft-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    const healthy = createDraft(root, { actor: "sam", to: "Rick Ruiz", channel: "email", subject: "Pickup Thursday", body: "Secret outbound body" });
    plantDeadStore(root);

    assert.throws(() => listDrafts(root), (e: unknown) => isDraftLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Draft read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "draft-failed:read", label: "draft store failures (read step)" });

    assert.throws(() => getDraft(root, healthy.id), (e: unknown) => isDraftLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the get touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Draft read failed: "), lines[1].summary);

    assert.throws(() => createDraft(root, { actor: "sam", to: "Blair", body: "Another secret body" }), (e: unknown) => isDraftLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the create touch ledgers exactly one more line");
    assert.ok(lines[2].summary.startsWith("Draft write failed: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "draft-failed:write", label: "draft store failures (write step)" });

    assert.throws(() => updateDraft(root, healthy.id, { body: "Patched secret" }), (e: unknown) => isDraftLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the update touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Draft write failed: "), lines[3].summary);

    assert.throws(() => removeDraft(root, healthy.id), (e: unknown) => isDraftLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the remove touch ledgers exactly one more line");
    assert.ok(lines[4].summary.startsWith("Draft write failed: "), lines[4].summary);

    assert.ok(!JSON.stringify(lines).includes("Rick Ruiz"), "no draft recipient ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Pickup Thursday"), "no draft subject ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Secret outbound body"), "no draft body ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft-failed: an absent store reads as no drafts, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(listDrafts(root), []);
    assert.equal(getDraft(root, "nope"), null);
    assert.equal(updateDraft(root, "nope", { body: "x" }), null);
    assert.equal(removeDraft(root, "nope"), false);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "drafts.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft-failed: validation errors and the noDraft refusal are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", body: "  " }), /Invalid draft body/);
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", channel: "pigeon", body: "hi" }), /Invalid draft channel/);
    assert.throws(() => createDraft(root, { actor: "sam", to: "", body: "hi" }), /Invalid draft recipient/);
    upsertContact(root, { name: "Do Not Write", note: "Owner handles her personally", noDraft: true });
    assert.throws(() => createDraft(root, { actor: "sam", to: "Do Not Write", body: "hello" }), /no-drafts/);
    assert.equal(failedLines(root).length, 0);
    assert.equal(readActivity(root, 100, { kind: "contact-failed" }).length, 0, "a healthy contact check ledgers nothing either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft-failed: a healthy store creates, updates, and discards with zero failure lines", () => {
  const root = scratch();
  try {
    const d = createDraft(root, { actor: "sam", to: "Johnny Davis", channel: "email", subject: "Pickup Thursday", body: "Hey Johnny, confirming Thursday." });
    assert.equal(listDrafts(root).length, 1);
    assert.equal(getDraft(root, d.id)?.subject, "Pickup Thursday");
    const patched = updateDraft(root, d.id, { body: "Patched body" });
    assert.equal(patched?.body, "Patched body");
    assert.equal(removeDraft(root, d.id), true);
    assert.deepEqual(listDrafts(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

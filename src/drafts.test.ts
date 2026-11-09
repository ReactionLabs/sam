import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDrafts, getDraft, createDraft, removeDraft } from "./drafts.js";
import * as draftsModule from "./drafts.js";
import { upsertContact } from "./contacts.js";
import { proposeAction, decideAction, listActions } from "./actions.js";

test("drafts: a draft is stored text and nothing else - there is no send surface", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-drafts-"));
  try {
    const d = createDraft(root, { actor: "sam", to: "Johnny Davis", channel: "email", subject: "Pickup Thursday", body: "Hey Johnny, confirming Thursday." });
    assert.equal(d.status, "draft");
    assert.equal(d.via, "cli");
    assert.equal(getDraft(root, d.id)?.subject, "Pickup Thursday");
    assert.equal(listDrafts(root).length, 1);
    // The fence is structural: the module that owns drafts exports no way
    // to send one. If a send function ever appears here, this test fails.
    assert.equal(Object.keys(draftsModule).filter(k => /send|deliver|transmit/i.test(k)).length, 0);
    assert.equal(removeDraft(root, d.id), true);
    assert.equal(removeDraft(root, d.id), false);
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts: validation refuses empty bodies and unknown channels", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-drafts2-"));
  try {
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", body: "  " }), /Invalid draft body/);
    assert.throws(() => createDraft(root, { actor: "sam", to: "A", channel: "pigeon", body: "hi" }), /Invalid draft channel/);
    assert.throws(() => createDraft(root, { actor: "sam", to: "", body: "hi" }), /Invalid draft recipient/);
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts: a no-drafts contact refuses at creation, on the CLI path and through the approval gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-drafts3-"));
  try {
    upsertContact(root, { name: "Do Not Write", note: "Owner handles her personally", noDraft: true });
    assert.throws(() => createDraft(root, { actor: "sam", to: "Do Not Write", body: "hello" }), /no-drafts/);
    // Through P1: the owner can approve the proposal, but execution still
    // refuses and the proposal lands failed - a draft never slips past a
    // permission note just because it rode the gate.
    const p = proposeAction(root, { actor: "sam", kind: "draft", title: "Note to Do Not Write", detail: JSON.stringify({ to: "Do Not Write", channel: "email", body: "hello" }) });
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "failed");
    assert.match(decided.result ?? "", /no-drafts/);
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts: an approved draft proposal saves the draft - and sends nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-drafts4-"));
  try {
    const p = proposeAction(root, { actor: "sam", kind: "draft", title: "Thank-you to Rick", detail: JSON.stringify({ to: "Rick Ruiz", channel: "text", body: "Thanks for the referral, Rick." }) });
    assert.equal(listDrafts(root).length, 0); // a proposal alone creates nothing
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    const drafts = listDrafts(root);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].to, "Rick Ruiz");
    assert.equal(drafts[0].channel, "text");
    assert.equal(drafts[0].via, "proposal");
    assert.equal(drafts[0].status, "draft"); // still a draft after approval: the owner sends it
    // Rejection creates nothing either.
    const p2 = proposeAction(root, { actor: "sam", kind: "draft", title: "Nope", detail: JSON.stringify({ to: "Rick Ruiz", body: "never stored" }) });
    await decideAction(root, p2.id, false);
    assert.equal(listDrafts(root).length, 1);
    assert.equal(listActions(root).filter(a => a.kind === "draft").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { PREFERENCE_STATEMENT_MAX, PreferenceStore, preferenceStatementBlocker } from "./preferences.js";

// The proposal-time execution gate for kind law:
// validateLawDetail did not exist - proposeAction checked only
// the gate's own loose bounds (detail up to 4000 chars), while
// the approved execution writes the statement through
// PreferenceStore.note, which refuses anything empty or over
// 200 chars once normalized. An over-long law was therefore a
// dead card: shown to the owner, approvable, guaranteed to fail
// at execution. preferenceStatementBlocker is now the ONE
// source: note() throws it at write time, the gate throws the
// identical text at proposal, before any card or ledger line.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-law-gate-")); }

const OVER = "Always " + "x".repeat(PREFERENCE_STATEMENT_MAX); // normalized length > cap

test("law gate: an over-limit statement refuses at proposal in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    const blocker = preferenceStatementBlocker(OVER);
    assert.ok(blocker);
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "law", title: "Too long", detail: OVER }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("law gate: the refusal is byte-identical at proposal and at the store write", () => {
  const root = fresh();
  try {
    let proposed = "";
    try { proposeAction(root, { actor: "sam", kind: "law", title: "Too long", detail: OVER }); } catch (e) { proposed = e instanceof Error ? e.message : String(e); }
    const store = new PreferenceStore(root);
    let direct = "";
    try { store.note("sam", OVER, "rule", "test"); } catch (e) { direct = e instanceof Error ? e.message : String(e); } finally { store.close(); }
    assert.ok(direct.length > 0);
    assert.equal(proposed, direct);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("law gate: a statement at exactly the cap proposes and executes to standing law", async () => {
  const root = fresh();
  try {
    const atCap = "Always " + "y".repeat(PREFERENCE_STATEMENT_MAX - "Always ".length);
    assert.equal(preferenceStatementBlocker(atCap), null);
    const a = proposeAction(root, { actor: "sam", kind: "law", title: "At cap", detail: atCap });
    assert.equal(a.status, "pending");
    const decided = await decideAction(root, a.id, true);
    assert.equal(decided.status, "done");
    const store = new PreferenceStore(root);
    try { assert.equal(store.lawsFor("sam").length, 1); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("law gate: the gate measures the normalized form, exactly as the store does", () => {
  const root = fresh();
  try {
    // Raw text over the cap that normalizes under it: runs of
    // whitespace collapse and trailing punctuation is stripped.
    const padded = "Always   confirm   before   spending" + " ".repeat(220) + "...";
    assert.ok(padded.length > PREFERENCE_STATEMENT_MAX);
    assert.equal(preferenceStatementBlocker(padded), null);
    const a = proposeAction(root, { actor: "sam", kind: "law", title: "Padded", detail: padded });
    assert.equal(a.status, "pending");
    // And the mirror image: text that normalizes to nothing is
    // refused even though the raw detail is non-empty.
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "law", title: "Punctuation only", detail: "!!!" }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, preferenceStatementBlocker("!!!"));
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("law gate: other kinds are untouched by the law check", () => {
  const root = fresh();
  try {
    const long = "Note body " + "z".repeat(500);
    const a = proposeAction(root, { actor: "sam", kind: "note", title: "Long note", detail: long });
    assert.equal(a.status, "pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { PreferenceStore, preferenceStoreFailureSummary, isPreferenceStoreLedgered } from "./preferences.js";
import { classifyDefect } from "./self-work.js";

// Preference store failure visibility (gap found
// 2026-11-15, hourly run 02:04): preferences.db holds
// every profile's noted preferences and standing law
// behind the one PreferenceStore class, and every touch
// opened it raw - the constructor's open plus note /
// promote / list / lawsFor / get / revoke threw into
// whichever catch wrapped the call with the seam unnamed.
// Each touch now ledgers ONE preference-store-failed line
// (constructor open at phase write, reads at phase read,
// mutations at phase write) and rethrows exactly, tagged;
// every caller's handling is unchanged and reads still
// fail closed (never folded as no preferences, which would
// silently drop every profile's standing law dressed as an
// empty store).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-prefs-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "preference-store-failed" });
}

test("preference-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(preferenceStoreFailureSummary("read", "unable to open\n  database   file"), "Preference store read failed: unable to open database file");
  assert.equal(preferenceStoreFailureSummary("write", "disk gone"), "Preference store write failed: disk gone");
  assert.equal(preferenceStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "preference-store-failed", summary: preferenceStoreFailureSummary(phase, "boom") }),
      { key: "preference-store-failed:" + phase, label: "preference store failures (" + phase + " step)" },
    );
  }
});

test("preference-store-failed: a dead store at open ledgers exactly one write line, tagged, and rethrows", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "preferences.db"), { recursive: true });
    assert.throws(() => new PreferenceStore(root), (e: unknown) => isPreferenceStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Preference store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "preference-store-failed:write", label: "preference store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference-store-failed: a dead read on a live handle ledgers one read line per touch", () => {
  const root = scratch();
  try {
    const store = new PreferenceStore(root);
    store.note("trading", "A Law That Must Not Leak", "rule", "chat-1");
    const raw = openDatabase(join(root, ".sam", "preferences.db"));
    try { raw.exec("ALTER TABLE preferences RENAME TO preferences_gone"); } finally { raw.close(); }

    assert.throws(() => store.lawsFor("trading"), (e: unknown) => isPreferenceStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Preference store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "preference-store-failed:read", label: "preference store failures (read step)" });

    assert.throws(() => store.list(), (e: unknown) => isPreferenceStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line per failed touch");

    store.close();
    assert.ok(!JSON.stringify(lines).includes("A Law That Must Not Leak"), "no preference statement ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    const store = new PreferenceStore(root);
    const raw = openDatabase(join(root, ".sam", "preferences.db"));
    try { raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON preferences BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;"); } finally { raw.close(); }
    assert.throws(() => store.note("trading", "a statement that must not leak", "like", "chat-1"), (e: unknown) => isPreferenceStoreLedgered(e));
    store.close();
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Preference store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes("a statement that must not leak"), "no preference statement ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference-store-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    const store = new PreferenceStore(root);
    const plain = (re: RegExp) => (e: unknown) => re.test((e as Error).message) && !isPreferenceStoreLedgered(e);
    assert.throws(() => store.note("trading", "", "like", "chat-1"), plain(/^Invalid preference statement$/));
    assert.throws(() => store.note("trading", "x".repeat(201), "like", "chat-1"), plain(/^Invalid preference statement$/));
    assert.throws(() => store.note("Bad Profile", "short answers", "like", "chat-1"), plain(/^Invalid profile$/));
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference-store-failed: a healthy store exercises every surface with zero failure lines", () => {
  const root = scratch();
  try {
    const store = new PreferenceStore(root);
    assert.deepEqual(store.list(), [], "a fresh store reads as no preferences");
    const rule = store.note("trading", "Never trade on Fridays", "rule", "chat-1");
    assert.equal(rule.status, "law");
    store.note("trading", "short answers", "like", "chat-1");
    store.note("trading", "short answers", "like", "chat-2");
    store.note("trading", "short answers", "like", "chat-3");
    assert.equal(store.promote().length, 1);
    assert.equal(store.lawsFor("trading").length, 2);
    assert.equal(store.list("trading").length, 2);
    assert.equal(store.get(rule.id)?.statement, "Never trade on Fridays");
    assert.equal(store.get("00000000-0000-0000-0000-000000000000"), undefined);
    assert.equal(store.revoke(rule.id), true);
    assert.equal(store.lawsFor("trading").length, 1);
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

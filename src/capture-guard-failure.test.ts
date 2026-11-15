import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  CaptureGuardStore, captureGuardFailureSummary, isCaptureGuardLedgered,
  findSuppressionHitInDb, activeSuppressions,
} from "./capture-guard.js";
import { classifyDefect } from "./self-work.js";

// Capture guard store failure visibility (gap found
// 2026-11-15, hourly run 04:04): CaptureGuardStore rides
// preferences.db under its own class and table, so the
// preference-store guard never named it - the constructor's
// open plus add / list / activeFor / revoke, and the
// direct-DB backstop findSuppressionHitInDb that
// MemoryStore.add consults on every write, all touched the
// file raw. Each touch now ledgers ONE capture-guard-failed
// line (constructor open at phase write, reads at phase
// read, mutations at phase write) and rethrows exactly,
// tagged; every caller's handling is unchanged and reads
// still fail closed (never folded as no suppressions, which
// would silently unbind the owner's standing do-not-store
// instruction dressed as an empty list).
const NEEDLE = "zorblax quindle forty seven";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-guard-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "capture-guard-failed" });
}

test("capture-guard-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(captureGuardFailureSummary("read", "unable to open\n  database   file"), "Capture guard store read failed: unable to open database file");
  assert.equal(captureGuardFailureSummary("write", "disk gone"), "Capture guard store write failed: disk gone");
  assert.equal(captureGuardFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "capture-guard-failed", summary: captureGuardFailureSummary(phase, "boom") }),
      { key: "capture-guard-failed:" + phase, label: "capture guard store failures (" + phase + " step)" },
    );
  }
});

test("capture-guard-failed: a dead store at open ledgers exactly one write line, tagged, and rethrows", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "preferences.db"), { recursive: true });
    assert.throws(() => new CaptureGuardStore(root), (e: unknown) => isCaptureGuardLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Capture guard store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "capture-guard-failed:write", label: "capture guard store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture-guard-failed: a dead read on a live handle ledgers one read line per touch, with no second line from activeFor", () => {
  const root = scratch();
  try {
    const store = new CaptureGuardStore(root);
    store.add("dip", NEEDLE, "test");
    const raw = openDatabase(join(root, ".sam", "preferences.db"));
    try { raw.exec("ALTER TABLE capture_suppressions RENAME TO capture_suppressions_gone"); } finally { raw.close(); }

    assert.throws(() => store.list("dip"), (e: unknown) => isCaptureGuardLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Capture guard store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "capture-guard-failed:read", label: "capture guard store failures (read step)" });

    assert.throws(() => store.activeFor("dip"), (e: unknown) => isCaptureGuardLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line per failed touch, and activeFor adds no second line over list");

    store.close();
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no needle ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture-guard-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    const store = new CaptureGuardStore(root);
    const raw = openDatabase(join(root, ".sam", "preferences.db"));
    try { raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON capture_suppressions BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;"); } finally { raw.close(); }
    assert.throws(() => store.add("dip", NEEDLE, "test"), (e: unknown) => isCaptureGuardLedgered(e));
    store.close();
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Capture guard store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no needle ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture-guard-failed: the backstop door ledgers a dead read, and its absent shapes stay silent", () => {
  const root = scratch();
  try {
    const dbPath = join(root, ".sam", "preferences.db");
    // Absent file: no suppressions, no line, nothing created.
    assert.equal(findSuppressionHitInDb(dbPath, ["dip"], "anything at all"), null);
    assert.equal(failedLines(root).length, 0);
    // A healthy file with no guard table yet: no suppressions, no line.
    mkdirSync(join(root, ".sam"), { recursive: true });
    const raw = openDatabase(dbPath);
    try { raw.exec("CREATE TABLE other (id TEXT)"); } finally { raw.close(); }
    assert.equal(findSuppressionHitInDb(dbPath, ["dip"], "anything at all"), null);
    assert.equal(failedLines(root).length, 0);
    // A corrupt file: one tagged read line in the install's ledger, rethrown.
    writeFileSync(dbPath, "this is not a sqlite database at all, just planted text");
    assert.throws(() => findSuppressionHitInDb(dbPath, ["dip"], "anything at all"), (e: unknown) => isCaptureGuardLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Capture guard store read failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture-guard-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    const store = new CaptureGuardStore(root);
    const plain = (re: RegExp) => (e: unknown) => re.test((e as Error).message) && !isCaptureGuardLedgered(e);
    assert.throws(() => store.add("Bad Profile", NEEDLE, "test"), plain(/^Invalid profile$/));
    assert.throws(() => store.add("dip", "ab", "test"), plain(/^Invalid suppression phrase/));
    assert.throws(() => store.add("dip", "x".repeat(201), "test"), plain(/^Invalid suppression phrase/));
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture-guard-failed: a healthy store exercises every surface with zero failure lines", () => {
  const root = scratch();
  try {
    const store = new CaptureGuardStore(root);
    assert.deepEqual(store.list(), [], "a fresh store reads as no suppressions");
    const added = store.add("dip", NEEDLE, "test");
    assert.equal(added.created, true);
    assert.equal(store.add("dip", NEEDLE, "test").created, false, "dedupe still reads without a line");
    assert.equal(store.activeFor("dip").length, 1);
    assert.equal(store.list("dip", true).length, 1);
    const dbPath = join(root, ".sam", "preferences.db");
    assert.equal(findSuppressionHitInDb(dbPath, ["dip"], "earlier the owner said " + NEEDLE)?.profile, "dip");
    assert.equal(findSuppressionHitInDb(dbPath, ["sam"], "earlier the owner said " + NEEDLE), null, "another profile's suppression does not bind this scope");
    assert.equal(activeSuppressions(root, "dip").length, 1);
    assert.equal(store.revoke(added.record.id), true);
    assert.equal(store.activeFor("dip").length, 0);
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

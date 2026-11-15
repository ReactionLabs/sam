import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  isMiniStoreLedgered, miniStoreFailureSummary, minis, removeMini,
  spawnMini, updateMini,
} from "./minis.js";
import { classifyDefect } from "./self-work.js";

// Mini store failure visibility (gap found 2026-11-14,
// hourly run 23:04): the minis registry (.sam/minis.db) is
// read by the status payload, the door handler, self-audit,
// spawn validation, and the CLI, and written by spawn /
// update / remove - and every touch opened it raw: a dead
// minis.db threw into whichever catch wrapped the call,
// none naming the store. Each touch now ledgers ONE
// mini-store-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// reads still fail closed (never folded as no minis, which
// would silently drop every scoped SAM dressed as an empty
// registry).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-minis-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "mini-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "minis.db"), { force: true });
  mkdirSync(join(root, ".sam", "minis.db"), { recursive: true });
}

test("mini-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(miniStoreFailureSummary("read", "unable to open\n  database   file"), "Mini store read failed: unable to open database file");
  assert.equal(miniStoreFailureSummary("write", "disk gone"), "Mini store write failed: disk gone");
  assert.equal(miniStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "mini-store-failed", summary: miniStoreFailureSummary(phase, "boom") }),
      { key: "mini-store-failed:" + phase, label: "mini store failures (" + phase + " step)" },
    );
  }
});

test("mini-store-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    const healthy = spawnMini(root, { name: "alex", person: "Alexandra Secretperson", instructions: "Help Alex." });
    plantDeadStore(root);

    assert.throws(() => minis(root), (e: unknown) => isMiniStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Mini store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "mini-store-failed:read", label: "mini store failures (read step)" });

    assert.throws(() => updateMini(root, healthy.id, { person: "Renamed" }), (e: unknown) => isMiniStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the update door's inner lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Mini store read failed: "), lines[1].summary);

    assert.throws(() => removeMini(root, "alex"), (e: unknown) => isMiniStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "remove's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Mini store read failed: "), lines[2].summary);

    assert.throws(() => spawnMini(root, { name: "bea", person: "Bea", instructions: "Help Bea." }), (e: unknown) => isMiniStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "spawn's registry read touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Mini store read failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("Alexandra"), "no mini person ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Secretperson"), "no mini person ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: an absent store reads as no minis, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(minis(root), []);
    assert.equal(updateMini(root, "nope", { person: "x" }), null);
    assert.equal(removeMini(root, "nope"), false);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "minis.db")), false, "a pure read creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => spawnMini(root, { name: "Bad Name", person: "Alex", instructions: "Help." }), (e: unknown) => /Invalid mini name/.test((e as Error).message) && !isMiniStoreLedgered(e));
    assert.throws(() => spawnMini(root, { name: "alex", person: "  ", instructions: "Help." }), (e: unknown) => /Invalid person/.test((e as Error).message) && !isMiniStoreLedgered(e));
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    assert.throws(() => spawnMini(root, { name: "alex", person: "Alex", instructions: "Again" }), (e: unknown) => /Mini already exists/.test((e as Error).message) && !isMiniStoreLedgered(e));
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: a healthy store spawns, updates, and removes with zero failure lines", () => {
  const root = scratch();
  try {
    const a = spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const b = spawnMini(root, { name: "blair", person: "Blair", instructions: "Help Blair." });
    assert.equal(minis(root).length, 2);
    const patched = updateMini(root, a.id, { person: "Alexandra" });
    assert.equal(patched?.person, "Alexandra");
    assert.equal(removeMini(root, "blair"), true);
    assert.equal(removeMini(root, "blair"), false);
    assert.deepEqual(minis(root).map(m => m.id), [a.id]);
    void b;
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const raw = openDatabase(join(root, ".sam", "minis.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON minis BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => spawnMini(root, { name: "bea", person: "Bea", instructions: "Help Bea." }), (e: unknown) => isMiniStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Mini store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "mini-store-failed:write", label: "mini store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    const a = spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const raw = openDatabase(join(root, ".sam", "minis.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON minis BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateMini(root, a.id, { person: "Renamed" }), (e: unknown) => isMiniStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Mini store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-store-failed: a failing delete ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const raw = openDatabase(join(root, ".sam", "minis.db"));
    try {
      raw.exec("CREATE TRIGGER planted_delete_fail BEFORE DELETE ON minis BEGIN SELECT RAISE(ABORT, 'planted delete failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => removeMini(root, "alex"), (e: unknown) => isMiniStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the delete touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Mini store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted delete failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

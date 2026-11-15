import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  auditStoreFailureSummary, auditStoreTouch, isAuditStoreLedgered,
} from "./audit-store-failure.js";
import { readPromptAudit, runPromptAudit } from "./prompt-audit.js";
import { readContextAudit } from "./context-audit.js";
import { readEvalBattery } from "./eval-battery.js";
import { classifyDefect } from "./self-work.js";

// Singleton audit store failure visibility (gap found
// 2026-11-15, hourly run 10:04): the five singleton audit
// stores (self / prompt / context / loop audits and the
// eval battery) each carry one copy of the same
// openAuditStore shape - one row, id = 1 - and every touch
// opened the file raw, so a dead store threw with the seam
// unnamed and a reader folding it as "no audit recorded"
// would silently empty a measuring instrument's history.
// Each touch now ledgers ONE audit-store-failed line naming
// the store and the phase (reads at read, the save inside
// each run at write) through the shared audit-store-failure
// seam and rethrows exactly, tagged; absent still reads as
// no audit creating nothing.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-audit-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "audit-store-failed" });
}

test("audit-store-failed: summary shapes collapse and cap the reason, and self-work classifies by store and phase", () => {
  assert.equal(auditStoreFailureSummary("prompt-audit", "read", "unable to open\n  database   file"), "Audit store prompt-audit read failed: unable to open database file");
  assert.equal(auditStoreFailureSummary("eval-battery", "write", "disk gone"), "Audit store eval-battery write failed: disk gone");
  assert.equal(auditStoreFailureSummary("self-audit", "write", "x".repeat(500)).length, 200);
  for (const store of ["self-audit", "prompt-audit", "context-audit", "loop-audit", "eval-battery"] as const) {
    for (const phase of ["read", "write"] as const) {
      assert.deepEqual(
        classifyDefect({ at: "", actor: "sam", kind: "audit-store-failed", summary: auditStoreFailureSummary(store, phase, "boom") }),
        { key: "audit-store-failed:" + store + ":" + phase, label: "audit store failures (" + store + ", " + phase + " step)" },
      );
    }
  }
});

test("audit-store-failed: an absent store reads as no audit, creates nothing, and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.equal(readPromptAudit(root), null);
    assert.equal(readContextAudit(root), null);
    assert.equal(readEvalBattery(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-store-failed: a healthy run and read-back ledger no failure lines", () => {
  const root = scratch();
  try {
    const audit = runPromptAudit(root);
    const back = readPromptAudit(root);
    assert.equal(back?.at, audit.at);
    assert.equal(back?.overall.total, audit.overall.total);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-store-failed: a dead store at save ledgers exactly one write line, tagged, and rethrows", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "prompt-audit.db"), { recursive: true });
    assert.throws(() => runPromptAudit(root), (e: unknown) => isAuditStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Audit store prompt-audit write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "audit-store-failed:prompt-audit:write", label: "audit store failures (prompt-audit, write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-store-failed: a dead read ledgers one read line naming its own store, with no audit record in it", () => {
  const root = scratch();
  try {
    const audit = runPromptAudit(root);
    assert.ok(audit.dimensions.length > 0);
    rmSync(join(root, ".sam", "prompt-audit.db"), { force: true });
    mkdirSync(join(root, ".sam", "prompt-audit.db"));
    assert.throws(() => readPromptAudit(root), (e: unknown) => isAuditStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Audit store prompt-audit read failed: "), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes(audit.dimensions[0].label), "no audit record ever enters a failure line");

    mkdirSync(join(root, ".sam", "eval-battery.db"), { recursive: true });
    assert.throws(() => readEvalBattery(root), (e: unknown) => isAuditStoreLedgered(e));
    const all = failedLines(root);
    assert.equal(all.length, 2);
    assert.ok(all.some(l => l.summary.startsWith("Audit store eval-battery read failed: ")), JSON.stringify(all));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-store-failed: a touch already ledgered by an inner door gains no second line", () => {
  const root = scratch();
  try {
    assert.throws(
      () => auditStoreTouch(root, "loop-audit", "write", () =>
        auditStoreTouch(root, "loop-audit", "read", () => { throw new Error("inner seam dead"); })),
      (e: unknown) => isAuditStoreLedgered(e),
    );
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Audit store loop-audit read failed: inner seam dead"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

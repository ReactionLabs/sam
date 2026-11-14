import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { buildLoopAudit, loopAuditText, measureLoopLive, readLoopAudit, runLoopAudit } from "./loop-audit.js";
import { openLoop } from "./loops.js";
import { recordChange } from "./verification.js";

// HARNESS INTELLIGENCE item 3: the loop audit. The machinery
// checks run the REAL loop functions (the verification gate
// over a synthetic ledger, the open-loop store coming due,
// tiered budgets, the honest endings), the live state is read
// from the install's own stores, a run persists to the one-row
// SQLite store with one counts-only ledger line, a pure read
// creates nothing, and a legacy JSON record imports once and
// is renamed, never deleted.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-loop-audit-")); }

test("loop-audit: the live loop machinery passes every check on a fresh install", () => {
  const root = fresh();
  try {
    const audit = buildLoopAudit(root);
    assert.equal(audit.findings.length, 0, JSON.stringify(audit.findings));
    assert.equal(audit.overall.passed, audit.overall.total);
    assert.equal(audit.dimensions.length, 4);
    assert.equal(audit.live.verification, "clean");
    assert.equal(audit.live.openLoops, 0);
    assert.equal(audit.live.dueLoops, 0);
    assert.ok(audit.budgets.background.maxCalls > audit.budgets.chat.maxCalls);
    assert.ok(audit.budgets.chat.maxCalls >= audit.budgets.heartbeat.maxCalls);
    const text = loopAuditText(audit);
    assert.match(text, /Findings: none/);
    assert.match(text, /verification clean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-audit: the live state names unverified changes and open loops as they are", () => {
  const root = fresh();
  try {
    recordChange(root, { path: "src/x.ts", replacementHash: "h1", source: "code-write" });
    openLoop(root, { profile: "sam", question: "Did it ship?", watchFor: "the release", dueInHours: 1 });
    const live = measureLoopLive(root);
    assert.equal(live.verification, "unverified");
    assert.equal(live.pendingChanges, 1);
    assert.equal(live.openLoops, 1);
    assert.equal(live.dueLoops, 0);
    const audit = buildLoopAudit(root);
    assert.equal(audit.findings.length, 0, "live state is measured, not a finding: " + JSON.stringify(audit.findings));
    assert.match(loopAuditText(audit), /verification unverified, open loops 1 \(0 due\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-audit: a run records to SQLite with one counts-only ledger line; a pure read creates nothing", () => {
  const root = fresh();
  try {
    assert.equal(readLoopAudit(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    const audit = runLoopAudit(root);
    assert.equal(readLoopAudit(root)?.overall.passed, audit.overall.passed);
    assert.equal(existsSync(join(root, ".sam", "loop-audit.db")), true);
    assert.equal(existsSync(join(root, ".sam", "loop-audit.json")), false);
    const lines = readActivity(root, 50).filter(l => l.kind === "loop-audit");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Loop audit recorded: \d+\/\d+ checks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-audit: a legacy JSON record imports once and is renamed, never deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = buildLoopAudit(root);
    writeFileSync(join(root, ".sam", "loop-audit.json"), JSON.stringify(legacy));
    const read = readLoopAudit(root);
    assert.equal(read?.at, legacy.at);
    assert.equal(existsSync(join(root, ".sam", "loop-audit.json")), false);
    assert.equal(existsSync(join(root, ".sam", "loop-audit.json.migrated")), true);
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "loop-audit.json"), "{nope");
      assert.equal(readLoopAudit(root2), null);
      assert.equal(existsSync(join(root2, ".sam", "loop-audit.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

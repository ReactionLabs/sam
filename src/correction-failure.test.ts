import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  correctionFailureSummary, proposeCorrection, recordCorrectionFailure, tryRouteCorrection,
} from "./corrections.js";
import { classifyDefect } from "./self-work.js";

// Correction routing failure visibility (gap found 2026-11-14,
// hourly run 06:04): the live turn's correction catch was bare -
// proposeCorrection throwing (a dead actions.db or
// preferences.db) was swallowed, the turn continued with no
// correction note, and SAM neither followed the correction in
// that reply nor acknowledged a proposal, with no
// correction-failed kind anywhere. The guarded wrapper now
// ledgers ONE correction-failed line and returns null exactly
// as the swallowed catch did; proposeCorrection itself still
// throws for its direct callers.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-correction-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "correction-failed" });
}

test("correction-failed: summary shape collapses and caps the reason, and self-work classifies by phase", () => {
  const summary = correctionFailureSummary("dip", "unable to open\n  database   file");
  assert.equal(summary, "Correction propose failed for dip: unable to open database file");
  const long = correctionFailureSummary("sam", "x".repeat(500));
  assert.equal(long.length, 200);
  const root = scratch();
  try {
    recordCorrectionFailure(root, "dip", new Error("actions store is a directory"));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "dip");
    assert.deepEqual(classifyDefect(lines[0]), { key: "correction-failed:propose", label: "correction failures (propose step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction-failed: a dead gate store returns null with exactly one line, and a direct propose still throws ledgering nothing", () => {
  const root = scratch();
  try {
    // Plant a directory where the actions database belongs:
    // every open of that path throws, the dead-store shape.
    mkdirSync(join(root, ".sam", "actions.db"), { recursive: true });
    const routed = tryRouteCorrection(root, { actor: "dip", chatId: null, text: "don't call them leads, call them inquiries" });
    assert.equal(routed, null, "a failed routing reads exactly as the swallowed catch did");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed routing");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Correction propose failed for dip: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("inquiries"), "the correction statement never enters the failure line");
    assert.ok(!lines[0].summary.includes("leads"), "the owner's message text never enters the failure line");
    // proposeCorrection itself still throws for direct callers
    // (the CLI surfaces it; consolidation aggregates its own
    // consolidate-failed line) and ledgers no second line here.
    assert.throws(() => proposeCorrection(root, { actor: "dip", text: "don't call them leads, call them inquiries" }));
    assert.equal(failedLines(root).length, 1, "the direct call adds no correction-failed line");
    assert.equal(readActivity(root, 100, { kind: "consolidate-failed" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correction-failed: a healthy routing and a non-correction both ledger nothing", () => {
  const root = scratch();
  try {
    const routed = tryRouteCorrection(root, { actor: "dip", text: "stop calling it a mini" });
    assert.ok(routed?.created, "the healthy routing still produces its proposal");
    assert.equal(routed?.proposal.detail, "Never call it a mini");
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    const none = tryRouteCorrection(root, { actor: "dip", text: "what is on my calendar today?" });
    assert.equal(none, null, "no correction in the text, nothing to route");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

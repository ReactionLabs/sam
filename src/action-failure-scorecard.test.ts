import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { actionFailureBucket, actionFailureKind, actionFailureReasonPart, actionFailureScorecardText } from "./actions.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The action-failure daily-measurement wiring (2026-11-18,
// the measured-proof series): when an approved action's
// execution throws, the decision seam ledgers one "failed"
// line ("<kind>: <title> - <reason>") - but no daily surface
// ever counted the class, so an install source failing for
// every skill was invisible until the owner watched an
// install die. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it carries counts only:
// no stamp, no title, no detail, no actor, no URL, no
// verbatim reason - the kind folds from the summary's prefix
// validated against the fixed ACTION_KINDS enum, the bucket
// from the reason half, and an unmatched kind or reason is
// "other", never printed as free text. The scorecard path is
// a pure read - it creates nothing, spends no model call,
// and retries nothing; every state here is built through
// the ledger's own public door (recordActivity) with lines
// in the decision seam's own summary shape, never around it.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-action-failure-scorecard-"));
}

test("action failure scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = actionFailureScorecardText(dir);
    assert.match(text, /^Action failures: clear$/m);
    assert.match(text, /^Failed actions: 0$/m);
    assert.match(text, /^By kind: none$/m);
    assert.match(text, /^By reason: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = actionFailureScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held action-failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("action failure scorecard: failed actions flip the verdict, fold kinds and buckets, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = actionFailureScorecardText(dir);
    recordActivity(dir, "sam", "failed", "skill: Install smart-summarizer skill - Fetch failed (HTTP 404) for https://api.github.com/repos/skills.volces.com/smart-summarizer/git/trees/HEAD");
    recordActivity(dir, "sam", "failed", "skill: Install summarize skill - No SKILL.md found in elizaos/eliza");
    recordActivity(dir, "sam", "failed", "heartbeat: Morning job - Something entirely unmatched happened");
    recordActivity(dir, "sam", "failed", "mystery: Unknown kind line - Fetch failed (HTTP 500)");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = actionFailureScorecardText(dir);
    assert.match(text, /^Action failures: attention$/m);
    assert.match(text, /^Failed actions: 4$/m);
    assert.match(text, /^By kind: heartbeat 1, other 1, skill 2$/m);
    assert.match(text, /^By reason: http 2, not-found 1, other 1$/m);
    assert.equal(text.includes("smart-summarizer"), false, "no title surfaces");
    assert.equal(text.includes("api.github.com"), false, "no URL surfaces");
    assert.equal(text.includes("elizaos"), false, "no detail surfaces");
    assert.notEqual(text, clean, "the first failed action changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("action failure parsing: kind validates against the enum, reason splits on the first separator, buckets are fixed", () => {
  assert.equal(actionFailureKind("skill: Install x - boom"), "skill");
  assert.equal(actionFailureKind("git-push: Push branch - boom"), "git-push");
  assert.equal(actionFailureKind("mystery: Nope - boom"), "other");
  assert.equal(actionFailureKind("no separator at all"), "other");
  assert.equal(actionFailureKind(""), "other");
  assert.equal(actionFailureReasonPart("skill: Install x - Fetch failed (HTTP 404) for https://example.com"), "Fetch failed (HTTP 404) for https://example.com");
  assert.equal(actionFailureReasonPart("skill: Install x"), "");
  assert.equal(actionFailureBucket("Fetch failed (HTTP 404) for https://example.com"), "http");
  assert.equal(actionFailureBucket("No SKILL.md found in a/b"), "not-found");
  assert.equal(actionFailureBucket("Something entirely unmatched happened"), "other");
  assert.equal(actionFailureBucket(""), "other");
});

test("action failure scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-action-failures"), "sam-action-failures is allowlisted");
  const argv = scriptArgv("/some/root", "sam-action-failures");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "failure-scorecard"], "the argv rides actions failure-scorecard");
});

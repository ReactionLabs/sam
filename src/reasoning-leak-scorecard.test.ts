import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseReasoningLeakBlocked, reasoningBlockedLedgerSummary, reasoningLeakScorecardText, reasoningNarrationSignals } from "./reply-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The reasoning-leak daily-measurement wiring (2026-11-18,
// the measured-proof series): the reply guard withholds
// every reply that reads as the model's own process
// narration and ledgers one blocked line per reply, but no
// daily surface ever counted the class, so a model that
// kept narrating its process was invisible until the owner
// read a reply closely. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no actor, no verbatim summary -
// blocks fold into the fixed seam buckets and signal names
// the guard writes and an unmatched shape counts as a
// block with no seam or signal counts, never printed. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and retries nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the guard's own summary writer
// (reasoningBlockedLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-reasoning-leak-scorecard-"));
}

test("reasoning leak scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = reasoningLeakScorecardText(dir);
    assert.match(text, /^Reasoning leaks: clear$/m);
    assert.match(text, /^Blocked replies: 0$/m);
    assert.match(text, /^By seam: none$/m);
    assert.match(text, /^By signal: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = reasoningLeakScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held reasoning-leak scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning leak scorecard: blocks flip the verdict, fold to fixed seams and signals, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = reasoningLeakScorecardText(dir);
    recordActivity(dir, "sam", "reasoning-leak-blocked", reasoningBlockedLedgerSummary([{ name: "process-verb", weight: 2 }, { name: "machinery", weight: 1 }], "connector loop"));
    recordActivity(dir, "dip", "reasoning-leak-blocked", reasoningBlockedLedgerSummary([{ name: "process-verb", weight: 2 }, { name: "fragment-ending", weight: 1 }], "own-tools loop"));
    recordActivity(dir, "sam", "reasoning-leak-blocked", "Some wholly novel block shape mentioning sekrit-narration");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = reasoningLeakScorecardText(dir);
    assert.match(text, /^Reasoning leaks: attention$/m);
    assert.match(text, /^Blocked replies: 3$/m);
    assert.match(text, /^By seam: connector 1, own-tools 1, other 1$/m);
    assert.match(text, /^By signal: process-verb 2, machinery 1, fragment-ending 1$/m);
    assert.equal(text.includes("sekrit"), false, "no narration surfaces");
    assert.equal(text.includes("novel block"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first blocked reply changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning leak parse: the guard's own line parses, and only the fixed shape parses", () => {
  const dir = scratch();
  try {
    const signals = reasoningNarrationSignals("Let me check the code root for the tool implementation");
    assert.ok(signals.length > 0, "the narration fixture carries signals");
    recordActivity(dir, "sam", "reasoning-leak-blocked", reasoningBlockedLedgerSummary(signals, "save"));
    const text = reasoningLeakScorecardText(dir);
    assert.match(text, /^Blocked replies: 1$/m);
    assert.match(text, /^By seam: save 1$/m);
    assert.deepEqual(parseReasoningLeakBlocked(reasoningBlockedLedgerSummary([{ name: "meta-ask", weight: 2 }], "connector loop")), { seam: "connector", signals: ["meta-ask"] });
    assert.deepEqual(parseReasoningLeakBlocked(reasoningBlockedLedgerSummary([], "somewhere else")), { seam: "other", signals: [] });
    assert.equal(parseReasoningLeakBlocked(""), null);
    assert.equal(parseReasoningLeakBlocked("Some wholly novel block shape"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning leak scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-reasoning-leaks"), "sam-reasoning-leaks is allowlisted");
  const argv = scriptArgv("/some/root", "sam-reasoning-leaks");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "reasoning-scorecard"], "the argv rides observe reasoning-scorecard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parsePromptAuditSummary,
  promptAuditHistoryScorecardText,
  promptAuditLedgerSummary,
} from "./prompt-audit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The prompt audit history daily-measurement wiring (2026-11-20,
// the measured-proof series): every recorded prompt audit has
// ledgered as a prompt-audit line since the audit landed - one
// line per run, in the fixed shape the seam writes, carrying the
// run's passed/total counts, its finding count, and its audited
// tool-description count - but the class was never folded, so
// how many runs ever recorded, whether any run ever carried a
// finding, and how the tool surface has moved as the shipped
// prompts changed was invisible in aggregate (the audit's own
// surfaces execute a run or read the last one from a singleton
// store; neither trends the history). The verdict is attention
// only when any finding was ever recorded or a line is
// unparseable: clean runs are the audit doing its job, a finding
// is the news, and the tool-count trend rides the counts so
// surface growth is visible without alarming on it. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no stamp,
// no actor, no finding text - a fold that printed findings
// would leak which shipped line is missing. The scorecard path
// is a pure read - it creates nothing and runs no audit; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-prompt-audit-history-"));
}

test("prompt audit history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = promptAuditHistoryScorecardText(dir);
    assert.equal(text, "Prompt audit history: clear, 0 runs, 0 findings, latest 0/0 checks, latest 0 tool descriptions, peak 0 tool descriptions, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = promptAuditHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held prompt audit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt audit history scorecard: the history folds to counts with the latest score and the tool-count growth", () => {
  const dir = scratch();
  try {
    const clean = promptAuditHistoryScorecardText(dir);
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 23));
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 23));
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 27));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = promptAuditHistoryScorecardText(dir);
    assert.equal(text, "Prompt audit history: clear, 3 runs, 0 findings, latest 19/19 checks, latest 27 tool descriptions, peak 27 tool descriptions, 3 total");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt audit history scorecard: the peak tool count outlives a later smaller surface", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 27));
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 24));
    const text = promptAuditHistoryScorecardText(dir);
    assert.equal(text, "Prompt audit history: clear, 2 runs, 0 findings, latest 19/19 checks, latest 24 tool descriptions, peak 27 tool descriptions, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt audit history scorecard: findings alone are attention, with no other signal needed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(17, 19, 2, 27));
    const text = promptAuditHistoryScorecardText(dir);
    assert.equal(text, "Prompt audit history: attention, 1 runs, 2 findings, latest 17/19 checks, latest 27 tool descriptions, peak 27 tool descriptions, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt audit history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "prompt-audit", promptAuditLedgerSummary(19, 19, 0, 23));
    recordActivity(dir, "sam", "prompt-audit", "Some wholly novel audit shape mentioning sekrit gaps");
    const text = promptAuditHistoryScorecardText(dir);
    assert.equal(text, "Prompt audit history: attention, 1 runs, 0 findings, latest 19/19 checks, latest 23 tool descriptions, peak 23 tool descriptions, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel audit"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt audit parse: the seam's own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    promptAuditLedgerSummary(19, 19, 0, 23),
    "Prompt audit recorded: 19/19 checks, 0 finding(s), 23 tool descriptions",
  );
  assert.equal(
    promptAuditLedgerSummary(17, 19, 2, 27),
    "Prompt audit recorded: 17/19 checks, 2 finding(s), 27 tool descriptions",
  );
  assert.deepEqual(parsePromptAuditSummary(promptAuditLedgerSummary(19, 19, 0, 23)), { passed: 19, total: 19, findings: 0, tools: 23 });
  assert.equal(parsePromptAuditSummary(""), null);
  assert.equal(parsePromptAuditSummary("Prompt audit recorded: 20/19 checks, 0 finding(s), 23 tool descriptions"), null, "a passed count above its total does not parse");
  assert.equal(parsePromptAuditSummary("Prompt audit recorded: 0/0 checks, 0 finding(s), 23 tool descriptions"), null, "a zero total does not parse");
  assert.equal(parsePromptAuditSummary("Prompt audit recorded: 19/19 checks, 0 finding(s)"), null, "a truncated line does not parse");
});

test("prompt audit history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-prompt-audit-history"), "sam-prompt-audit-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-prompt-audit-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["prompt-audit", "scorecard"], "the argv rides prompt-audit scorecard");
});

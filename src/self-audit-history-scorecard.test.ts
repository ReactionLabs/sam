import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseSelfAuditSummary,
  selfAuditHistoryScorecardText,
  selfAuditLedgerSummary,
} from "./self-audit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The self audit history daily-measurement wiring (2026-11-20,
// the measured-proof series): every recorded self audit has
// ledgered as a self-audit line since the audit landed - one
// line per run, in the fixed shape the seam writes, carrying
// the run's can and cannot counts, its own-tool count, and
// its code root - but the class was never folded, so how
// many runs ever recorded and how the capability map has
// moved was invisible in aggregate (the audit's own surfaces
// execute a run or read the last one from a singleton store;
// neither trends the history). The verdict is attention only
// when a line is unparseable: the can and cannot counts are
// inventory, and the cannot list carries standing fences by
// design, so a nonzero cannot count is permanent and can
// never be the news. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no capability
// text - and the code-root PATH the summary carries is
// counted as present or absent and never printed. The
// scorecard path is a pure read - it creates nothing and
// runs no audit; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-self-audit-history-"));
}

test("self audit history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = selfAuditHistoryScorecardText(dir);
    assert.equal(text, "Self audit history: clear, 0 runs, latest 0 can, latest 0 cannot, peak 0 can, latest 0 own tools, peak 0 own tools, code root present 0 / absent 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = selfAuditHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held self audit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self audit history scorecard: the history folds to counts with the latest map and the peaks", () => {
  const dir = scratch();
  try {
    const clean = selfAuditHistoryScorecardText(dir);
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(6, 7, 22, "/opt/sam/code"));
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(8, 5, 22, "/opt/sam/code"));
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(9, 4, 27, "/opt/sam/code"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = selfAuditHistoryScorecardText(dir);
    assert.equal(text, "Self audit history: clear, 3 runs, latest 9 can, latest 4 cannot, peak 9 can, latest 27 own tools, peak 27 own tools, code root present 3 / absent 0, 3 total");
    assert.equal(text.includes("/opt/sam/code"), false, "the code-root path never surfaces");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self audit history scorecard: the peaks outlive a later smaller map", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(9, 4, 27, "/opt/sam/code"));
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(7, 6, 24, "/opt/sam/code"));
    const text = selfAuditHistoryScorecardText(dir);
    assert.equal(text, "Self audit history: clear, 2 runs, latest 7 can, latest 6 cannot, peak 9 can, latest 24 own tools, peak 27 own tools, code root present 2 / absent 0, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self audit history scorecard: a run with no code root counts absent, and a standing-fence cannot count stays clear", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(5, 8, 27, null));
    const text = selfAuditHistoryScorecardText(dir);
    assert.equal(text, "Self audit history: clear, 1 runs, latest 5 can, latest 8 cannot, peak 5 can, latest 27 own tools, peak 27 own tools, code root present 0 / absent 1, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self audit history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "self-audit", selfAuditLedgerSummary(9, 4, 27, "/opt/sam/code"));
    recordActivity(dir, "sam", "self-audit", "Some wholly novel audit shape mentioning /sekrit/root");
    const text = selfAuditHistoryScorecardText(dir);
    assert.equal(text, "Self audit history: attention, 1 runs, latest 9 can, latest 4 cannot, peak 9 can, latest 27 own tools, peak 27 own tools, code root present 1 / absent 0, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel audit"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self audit parse: the seam's own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    selfAuditLedgerSummary(6, 7, 22, "/opt/sam/code"),
    "Capability self-audit recorded: 6 can, 7 cannot, 22 own tools, code root /opt/sam/code",
  );
  assert.equal(
    selfAuditLedgerSummary(9, 4, 27, null),
    "Capability self-audit recorded: 9 can, 4 cannot, 27 own tools, code root none",
  );
  assert.deepEqual(parseSelfAuditSummary(selfAuditLedgerSummary(9, 4, 27, "/opt/sam/code")), { can: 9, cannot: 4, ownCount: 27, hasCodeRoot: true });
  assert.deepEqual(parseSelfAuditSummary(selfAuditLedgerSummary(9, 4, 27, null)), { can: 9, cannot: 4, ownCount: 27, hasCodeRoot: false });
  assert.equal(parseSelfAuditSummary(""), null);
  assert.equal(parseSelfAuditSummary("Capability self-audit recorded: 9 can, 4 cannot, 27 own tools"), null, "a truncated line does not parse");
  assert.equal(parseSelfAuditSummary("Capability self-audit recorded: nine can, 4 cannot, 27 own tools, code root none"), null, "a non-numeric count does not parse");
});

test("self audit history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-self-audit-history"), "sam-self-audit-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-self-audit-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["self-audit", "scorecard"], "the argv rides self-audit scorecard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { largeTurnLedgerSummary, largeTurnScorecardText, largeTurnSummary, parseLargeTurnSummary } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-cost daily-measurement wiring (2026-11-19, the
// measured-proof series): a single turn whose spend is
// actually large has ledgered as a "turn-cost" line since
// the owner-budget ruling landed - one line per large turn
// from both chat loops, in the one fixed shape the
// large-turn seams write - but the class was never folded,
// so how many turns ran large, how many calls and rounds
// they burned in aggregate, and what the largest single
// turn cost were invisible in aggregate. Every turn-cost
// line is by construction one of the owner's most expensive
// turns, so the verdict is attention when any line exists.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and never a tool name - the
// distinct-tool count rides each line's tool list
// internally and surfaces as a number only. The stored
// shapes are two - the writer's full shape and the ledger's
// 300-char capped shape (every live line is capped, cut
// mid-name) - and the parser reads both, counting only a
// capped list's complete entries. The scorecard path is a
// pure read - it creates nothing, spends no model call, and
// retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-cost-scorecard-"));
}

test("turn-cost scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = largeTurnScorecardText(dir);
    assert.equal(text, "Turn costs: clear, 0 large turns, 0 tool calls, 0 rounds, largest 0 calls, 0 distinct tools, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = largeTurnScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn-cost scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-cost scorecard: large turns fold to counts, tool names collapse in the distinct count, and no tool name surfaces", () => {
  const dir = scratch();
  try {
    const clean = largeTurnScorecardText(dir);
    recordActivity(dir, "sam", "turn-cost", largeTurnLedgerSummary(["sam_code", "sam_code", "sam_reach"], 2));
    recordActivity(dir, "sam", "turn-cost", largeTurnLedgerSummary(["sam_code"], 1));
    recordActivity(dir, "sam", "turn", "Answered in chat dffe3075");
    const text = largeTurnScorecardText(dir);
    assert.equal(text, "Turn costs: attention, 2 large turns, 4 tool calls, 3 rounds, largest 3 calls, 2 distinct tools, 2 total");
    assert.equal(text.includes("sam_code"), false, "no tool name surfaces");
    assert.equal(text.includes("sam_reach"), false, "no tool name surfaces");
    assert.notEqual(text, clean, "the first large turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-cost scorecard: a capped stored line keeps its exact header counts and counts only its complete tool entries", () => {
  const dir = scratch();
  try {
    const executed = Array.from({ length: 50 }, (_, i) => "tool_" + String(i).padStart(2, "0"));
    recordActivity(dir, "sam", "turn-cost", largeTurnLedgerSummary(executed, 30));
    const stored = readActivity(dir, Number.MAX_SAFE_INTEGER, { kind: "turn-cost" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].summary.length, 300, "the ledger capped the long line, the live shape");
    assert.equal(stored[0].summary.endsWith(")"), false, "a capped line has no closing paren");
    const parsed = parseLargeTurnSummary(stored[0].summary);
    assert.ok(parsed, "the capped shape parses");
    assert.equal(parsed.calls, 50, "the header call count survives the cap exactly");
    assert.equal(parsed.rounds, 30, "the header round count survives the cap exactly");
    assert.equal(parsed.complete, false, "a capped list is marked incomplete");
    assert.ok(parsed.tools.length < 50, "the trailing fragment is not counted as a tool");
    assert.ok(parsed.tools.length > 0, "the complete entries are counted");
    assert.equal(new Set(parsed.tools).size, parsed.tools.length, "the complete entries are the list's own prefix");
    const text = largeTurnScorecardText(dir);
    assert.equal(text, "Turn costs: attention, 1 large turns, 50 tool calls, 30 rounds, largest 50 calls, " + String(parsed.tools.length) + " distinct tools, 1 total");
    assert.equal(text.includes("tool_"), false, "no tool name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-cost scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "turn-cost", largeTurnLedgerSummary(["sam_code"], 1));
    recordActivity(dir, "sam", "turn-cost", "Some wholly novel cost shape mentioning sekrit tools");
    const text = largeTurnScorecardText(dir);
    assert.equal(text, "Turn costs: attention, 1 large turns, 1 tool calls, 1 rounds, largest 1 calls, 1 distinct tools, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel cost"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn-cost parse: the seam's own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(
    largeTurnLedgerSummary(["sam_code", "sam_reach"], 3),
    "Large owner turn: 2 tool calls over 3 rounds in one answer (sam_code, sam_reach)",
    "the writer is byte-identical to the shape the large-turn seams have always ledgered",
  );
  assert.equal(largeTurnSummary(["sam_code"], 1), largeTurnLedgerSummary(["sam_code"], 1), "the seams' writer delegates to the ONE writer");
  assert.deepEqual(parseLargeTurnSummary(largeTurnLedgerSummary(["sam_code", "sam_reach"], 3)), { calls: 2, rounds: 3, tools: ["sam_code", "sam_reach"], complete: true });
  assert.deepEqual(
    parseLargeTurnSummary("Large owner turn: 41 tool calls over 27 rounds in one answer (sam_code, sam_code)"),
    { calls: 41, rounds: 27, tools: ["sam_code", "sam_code"], complete: true },
    "a live-shaped full line parses",
  );
  assert.deepEqual(parseLargeTurnSummary(largeTurnLedgerSummary([], 5)), { calls: 0, rounds: 5, tools: [], complete: true }, "the none list parses to no tools");
  assert.equal(parseLargeTurnSummary(""), null);
  assert.equal(parseLargeTurnSummary("Large owner turn: many tool calls over some rounds"), null, "a header with no numbers does not parse");
  assert.equal(parseLargeTurnSummary("Some wholly novel cost shape"), null);
});

test("turn-cost scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-costs"), "sam-turn-costs is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-costs");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "turn-cost-scorecard"], "the argv rides observe turn-cost-scorecard");
});

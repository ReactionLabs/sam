import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTeamRunSummary, teamRunHistoryScorecardText, teamRunLedgerSummary } from "./team-runtime.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The team run history measurement (2026-11-22, the
// measured-proof series): a standing team run closes
// exactly once, and its closing ledgers one line under a
// kind built from the run's own status - "team-done",
// "team-blocked", or "team-failed" - at the single
// terminal seam of runStandingTeam, but the shape was an
// inline string with no writer, no parser, and no fold,
// so how many runs ever finished, were stopped
// unapproved, or died - and how many review rounds they
// spent - was invisible in aggregate. The run store holds
// the runs, but teamStatus reads back only the last 10,
// so a closing survives as a count nowhere except these
// ledger lines. A blocked or failed closing is itself
// the signal, so the verdict is attention when any run
// ever blocked or failed or any line is unparseable, else
// clear - a done run is counted, not alarmed. The
// scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no run id, no member
// name, no reason, and no verbatim summary. The scorecard
// path is a pure read - it creates nothing, runs no team,
// and opens no store; every state here is built through
// the ledger's own public door (recordActivity) with the
// seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-team-run-history-"));
}

const BARE = "Team run history: clear, 0 done, 0 blocked, 0 failed, 0 review rounds, 0 distinct runs, 0 total";
const ID_A = "abcd1234-5678-90ab-cdef-1234567890ab";
const ID_B = "11112222-3333-4444-5555-666677778888";
const ID_C = "99998888-7777-6666-5555-444433332222";

test("team run history: a bare install reads clear, stable, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = teamRunHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = teamRunHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held team run scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team run history: the writer is byte-identical to the historical inline shape", () => {
  assert.equal(
    teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", "the finished product"),
    "Team run abcd1234 done after 2 review round(s) (ada -> cy)",
    "a done closing carries no result text",
  );
  assert.equal(
    teamRunLedgerSummary(ID_B, "blocked", 3, "ada", "cy", "Review did not approve"),
    "Team run 11112222 blocked after 3 review round(s) (ada -> cy)",
    "a blocked closing carries no result text",
  );
  assert.equal(
    teamRunLedgerSummary(ID_C, "failed", 1, "ada", "cy", "fetch  failed:\nread ETIMEDOUT"),
    "Team run 99998888 failed after 1 review round(s) (ada -> cy): fetch failed: read ETIMEDOUT",
    "a failed closing collapses the reason's whitespace",
  );
  assert.equal(
    teamRunLedgerSummary(ID_C, "failed", 0, "ada", "cy", null),
    "Team run 99998888 failed after 0 review round(s) (ada -> cy): Team run failed",
    "a null result keeps the historical fallback",
  );
  assert.equal(
    teamRunLedgerSummary(ID_C, "failed", 0, "ada", "cy", "x".repeat(200)).length,
    "Team run 99998888 failed after 0 review round(s) (ada -> cy): ".length + 160,
    "the reason is capped at 160 chars",
  );
});

test("team run history: the parser learns the fixed shapes exactly and cross-kind lines never parse", () => {
  assert.deepEqual(
    parseTeamRunSummary("team-done", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null)),
    { status: "done", run: "abcd1234", rounds: 2 },
  );
  assert.deepEqual(
    parseTeamRunSummary("team-failed", teamRunLedgerSummary(ID_C, "failed", 1, "ada", "cy", "boom")),
    { status: "failed", run: "99998888", rounds: 1 },
  );
  assert.equal(parseTeamRunSummary("team-done", teamRunLedgerSummary(ID_A, "blocked", 2, "ada", "cy", null)), null, "a blocked line never parses as done");
  assert.equal(parseTeamRunSummary("team-blocked", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null)), null, "a done line never parses as blocked");
  assert.equal(parseTeamRunSummary("team-failed", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null)), null, "a done line never parses as failed");
  assert.equal(parseTeamRunSummary("team-done", teamRunLedgerSummary(ID_C, "failed", 1, "ada", "cy", "boom")), null, "a failed line never parses as done");
  assert.equal(parseTeamRunSummary("team-done", "Team run abcd123 done after 2 review round(s) (ada -> cy)"), null, "a 7-char run id does not parse");
  assert.equal(parseTeamRunSummary("team-done", "Team run abcd12345 done after 2 review round(s) (ada -> cy)"), null, "a 9-char run id does not parse");
  assert.equal(parseTeamRunSummary("team-done", "Team run abcd1234 done after 2 review round(s) (ada -> cy): extra"), null, "a reason on a done line does not parse");
  assert.equal(parseTeamRunSummary("team-failed", "Team run 99998888 failed after 1 review round(s) (ada -> cy)"), null, "a failed line with no reason does not parse");
  assert.equal(parseTeamRunSummary("team-failed", "Team run 99998888 failed after 1 review round(s) (ada -> cy): " + "x".repeat(161)), null, "a reason longer than the writer's cap does not parse");
  assert.equal(parseTeamRunSummary("team-member", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null)), null, "an unrelated kind never parses");
});

test("team run history: done closings fold to counts, sum their rounds, and stay clear", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "team-done", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null));
    recordActivity(dir, "sam", "team-done", teamRunLedgerSummary(ID_B, "done", 1, "ada", "cy", null));
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = teamRunHistoryScorecardText(dir);
    assert.equal(text, "Team run history: clear, 2 done, 0 blocked, 0 failed, 3 review rounds, 2 distinct runs, 2 total");
    assert.equal(text.includes("abcd1234"), false, "no run id surfaces");
    assert.equal(text.includes("ada"), false, "no member name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team run history: a blocked or failed closing flips the verdict to attention and folds beside done", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "team-done", teamRunLedgerSummary(ID_A, "done", 2, "ada", "cy", null));
    recordActivity(dir, "sam", "team-blocked", teamRunLedgerSummary(ID_B, "blocked", 3, "ada", "cy", "Review did not approve"));
    recordActivity(dir, "sam", "team-failed", teamRunLedgerSummary(ID_C, "failed", 1, "ada", "cy", "fetch failed"));
    const text = teamRunHistoryScorecardText(dir);
    assert.equal(text, "Team run history: attention, 1 done, 1 blocked, 1 failed, 6 review rounds, 3 distinct runs, 3 total");
    assert.equal(text.includes("fetch failed"), false, "no reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team run history: an unparseable closing counts under the total and flips the verdict to attention", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "team-done", "Team run closed somehow");
    const text = teamRunHistoryScorecardText(dir);
    assert.equal(text, "Team run history: attention, 0 done, 0 blocked, 0 failed, 0 review rounds, 0 distinct runs, 1 total, 1 unparseable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team run history: the sam-team-run-history script job rides the scorecard text", () => {
  assert.ok(scriptCommandNames().includes("sam-team-run-history"));
  const argv = scriptArgv("/some/root", "sam-team-run-history");
  assert.ok(argv.some(a => a === "team") && argv.some(a => a === "run-history"), "the allowlist entry rides the team run-history CLI");
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "team-done", teamRunLedgerSummary(ID_A, "done", 1, "ada", "cy", null));
    assert.match(teamRunHistoryScorecardText(dir), /^Team run history: clear, 1 done/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

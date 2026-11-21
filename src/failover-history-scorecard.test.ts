import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { failoverSummary } from "./agent-turn.js";
import { failoverFailureSummary, failoverHistoryScorecardText, failoverRouteLedgerSummary, parseFailoverFailureSummary, parseFailoverRouteSummary, parseFailoverSummary } from "./failover.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The failover history daily-measurement wiring (2026-11-21,
// the measured-proof series): the failover family ledgers
// three classes - a turn's hop ("failover"), a route added
// through the CLI ("failover-route"), and a dead fallbacks
// store touch ("failover-failed") - but none was ever
// folded, so how many turns were ever rescued, how many
// routes were ever configured, and how many store touches
// ever died fail-closed was invisible in aggregate; the
// fallbacks store holds only current routes, so a removed
// route and every past hop leave no surface but these
// lines. A hop is failover working as designed, not an
// alarm, so the verdict is attention only when a store
// failure was ever recorded or a line is unparseable, else
// clear (the heartbeat-deliveries precedent). The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it is ONE line carrying counts only: no stamp,
// no actor, no chat id, no provider or model name, and no
// reason. The scorecard path is a pure read - it creates
// nothing, routes nothing, and opens no store; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-failover-history-"));
}

const BARE = "Failover history: clear, 0 hops, 0 routes added, 0 failed, read 0 / write 0, 0 distinct chats, 0 total";

test("failover history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = failoverHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = failoverHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held failover scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failover history scorecard: recorded hops and route adds fold to counts with distinct chats as a number only", () => {
  const dir = scratch();
  try {
    const clean = failoverHistoryScorecardText(dir);
    recordActivity(dir, "trading", "failover", failoverSummary("12345678abcdef", "sekritprovider/SekritModel", "otherprovider/OtherModel", new Error("sekrit reason")));
    recordActivity(dir, "trading", "failover", failoverSummary("12345678abcdef", "sekritprovider/SekritModel", "otherprovider/OtherModel", new Error("sekrit reason")));
    recordActivity(dir, "sam", "failover", failoverSummary("87654321abcdef", "sekritprovider/SekritModel", "otherprovider/OtherModel", new Error("sekrit reason")));
    recordActivity(dir, "trading", "failover-route", failoverRouteLedgerSummary("sekritprovider", "SekritModel"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = failoverHistoryScorecardText(dir);
    assert.equal(text, "Failover history: clear, 3 hops, 1 routes added, 0 failed, read 0 / write 0, 2 distinct chats, 4 total");
    assert.equal(text.includes("sekrit"), false, "no provider, model, or reason surfaces");
    assert.equal(text.includes("12345678"), false, "no chat id surfaces");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded hop changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failover history scorecard: a recorded store failure is attention with its phase split, and an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "failover-failed", failoverFailureSummary("read", "sekrit store reason"));
    recordActivity(dir, "sam", "failover-failed", failoverFailureSummary("write", "sekrit store reason"));
    recordActivity(dir, "sam", "failover-failed", failoverFailureSummary("write", "sekrit store reason"));
    recordActivity(dir, "sam", "failover", "Failover happened quietly in a sekrit chat");
    const text = failoverHistoryScorecardText(dir);
    assert.equal(text, "Failover history: attention, 0 hops, 0 routes added, 3 failed, read 1 / write 2, 0 distinct chats, 4 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failover parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(failoverRouteLedgerSummary("minimax", "MiniMax-M2.5"), "Fallback route added: minimax/MiniMax-M2.5");
  assert.deepEqual(parseFailoverRouteSummary(failoverRouteLedgerSummary("minimax", "MiniMax-M2.5")), { provider: "minimax", model: "MiniMax-M2.5" });
  assert.equal(parseFailoverRouteSummary(""), null);
  assert.equal(parseFailoverRouteSummary("Fallback route added: minimax"), null, "a route line with no model does not parse");
  assert.equal(parseFailoverRouteSummary("Fallback route added: minimax/MiniMax-M2.5 tonight"), null, "a line with trailing text does not parse");
  assert.equal(failoverFailureSummary("read", "disk gone"), "Failover read failed: disk gone");
  assert.deepEqual(parseFailoverFailureSummary(failoverFailureSummary("write", "disk gone")), { phase: "write" });
  assert.equal(parseFailoverFailureSummary("Failover resolve failed: disk gone"), null, "an unknown phase does not parse");
  assert.equal(parseFailoverFailureSummary("Failover read failed: "), null, "an empty reason does not parse");
  const hop = failoverSummary("12345678abcdef", "minimax/MiniMax-M2.5", "openai/gpt-4.1", new Error("boom"));
  assert.equal(hop, "Failover in chat 12345678: minimax/MiniMax-M2.5 -> openai/gpt-4.1 (boom)");
  assert.deepEqual(parseFailoverSummary(hop), { chat: "12345678", from: "minimax/MiniMax-M2.5", to: "openai/gpt-4.1" });
  assert.equal(parseFailoverSummary(""), null);
  assert.equal(parseFailoverSummary("Failover in chat 12345678: minimax/MiniMax-M2.5 -> openai/gpt-4.1"), null, "a hop line with no reason does not parse");
});

test("failover history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-failover-history"), "sam-failover-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-failover-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["agents", "failover-history"], "the argv rides agents failover-history");
});

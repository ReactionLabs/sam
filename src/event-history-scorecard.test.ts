import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { eventBindLedgerSummary, eventFailureSummary, eventHistoryScorecardText, eventUnbindLedgerSummary, eventWokeLedgerSummary, parseEventBindSummary, parseEventFailedSummary, parseEventUnbindSummary, parseEventWokeSummary } from "./events.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The event door history daily-measurement wiring (2026-11-21,
// the measured-proof series): every event door lifecycle act
// has ledgered as an event-bind / event / event-failed line
// since the signed webhook door landed - the bind and woke
// lines as inline concatenation with no ONE writer and no
// fold, and the unbind act ledgering nothing at all, so how
// many doors were ever bound or closed, how many signed
// events ever woke a profile, across how many profiles, and
// whether an event-store touch ever failed was invisible in
// aggregate (eventBindings reads only the current store). A
// store failure is the family's signal - the door fails
// closed dressed as a generic 502 on the webhook leg - so
// the verdict is attention only when any failure was ever
// recorded or a line is unparseable. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// binding name, no event type, no event id, no profile name,
// no secret env name, no reason - the summaries carry
// binding names, event ids, secret env NAMES, and failure
// reasons, which the fold consumes and never prints. The
// scorecard path is a pure read - it creates nothing, binds
// nothing, unbinds nothing, and accepts nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-event-history-"));
}

test("event history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = eventHistoryScorecardText(dir);
    assert.equal(text, "Event history: clear, 0 bound, 0 woke, 0 with id, 0 unbound, 0 failed, 0 read, 0 write, 0 distinct names, 0 distinct types, 0 distinct profiles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = eventHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held event scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("event history scorecard: the history folds to counts and distinct names, types, and profiles, and no name, type, id, profile, or secret env surfaces", () => {
  const dir = scratch();
  try {
    const clean = eventHistoryScorecardText(dir);
    recordActivity(dir, "owner", "event-bind", eventBindLedgerSummary("sekrit-door", "sekrit-profile", "SEKRIT_ENV"));
    recordActivity(dir, "sekrit-profile", "event", eventWokeLedgerSummary("sekrit.type", "evt-sekrit-123", "sekrit-profile"));
    recordActivity(dir, "sekrit-profile", "event", eventWokeLedgerSummary("sekrit.type", null, "sekrit-profile"));
    recordActivity(dir, "other-profile", "event", eventWokeLedgerSummary("other.type", null, "other-profile"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = eventHistoryScorecardText(dir);
    assert.equal(text, "Event history: clear, 1 bound, 3 woke, 1 with id, 0 unbound, 0 failed, 0 read, 0 write, 1 distinct names, 2 distinct types, 2 distinct profiles, 4 total");
    assert.equal(text.includes("sekrit-door"), false, "no binding name surfaces");
    assert.equal(text.includes("sekrit.type"), false, "no event type surfaces");
    assert.equal(text.includes("evt-sekrit-123"), false, "no event id surfaces");
    assert.equal(text.includes("sekrit-profile"), false, "no profile name surfaces");
    assert.equal(text.includes("SEKRIT_ENV"), false, "no secret env name surfaces");
    assert.notEqual(text, clean, "the first recorded door changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("event history scorecard: an unbind counts toward the total and its name joins the distinct-name count, and no name surfaces", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "event-bind", eventBindLedgerSummary("sekrit-door", "sekrit-profile", "SEKRIT_ENV"));
    recordActivity(dir, "sekrit-profile", "event-unbind", eventUnbindLedgerSummary("sekrit-door"));
    const text = eventHistoryScorecardText(dir);
    assert.equal(text, "Event history: clear, 1 bound, 0 woke, 0 with id, 1 unbound, 0 failed, 0 read, 0 write, 1 distinct names, 0 distinct types, 1 distinct profiles, 2 total");
    assert.equal(text.includes("sekrit-door"), false, "no binding name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("event history scorecard: a failure is attention, split read and write, with no reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "event-failed", eventFailureSummary("read", "sekrit db path gone"));
    recordActivity(dir, "sam", "event-failed", eventFailureSummary("write", "sekrit db path gone"));
    const text = eventHistoryScorecardText(dir);
    assert.equal(text, "Event history: attention, 0 bound, 0 woke, 0 with id, 0 unbound, 2 failed, 1 read, 1 write, 0 distinct names, 0 distinct types, 0 distinct profiles, 2 total");
    assert.equal(text.includes("sekrit db path"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("event history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "event-bind", eventBindLedgerSummary("dip-door", "trading", "DIP_ENV"));
    recordActivity(dir, "trading", "event", "Some wholly novel event shape naming sekrit_evidence");
    recordActivity(dir, "owner", "event-bind", "Event Bad Door bound to trading (secret env DIP_ENV)");
    const text = eventHistoryScorecardText(dir);
    assert.equal(text, "Event history: attention, 1 bound, 0 woke, 0 with id, 0 unbound, 0 failed, 0 read, 0 write, 1 distinct names, 0 distinct types, 1 distinct profiles, 3 total, 2 unparseable");
    assert.equal(text.includes("novel event"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("Bad Door"), false, "no unrecognized name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("event parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(eventBindLedgerSummary("lead-arrived", "trading", "LEAD_SECRET"), "Event lead-arrived bound to trading (secret env LEAD_SECRET)");
  assert.equal(eventWokeLedgerSummary("lead.arrived", null, "trading"), "Event lead.arrived woke profile trading");
  assert.equal(eventWokeLedgerSummary("lead.arrived", "evt-1", "trading"), "Event lead.arrived evt-1 woke profile trading");
  assert.equal(eventUnbindLedgerSummary("lead-arrived"), "Event lead-arrived unbound");
  assert.equal(eventFailureSummary("read", "boom"), "Event read failed: boom");
  assert.deepEqual(parseEventBindSummary(eventBindLedgerSummary("lead-arrived", "trading", "LEAD_SECRET")), { name: "lead-arrived", profile: "trading", secretEnv: "LEAD_SECRET" });
  assert.deepEqual(parseEventWokeSummary(eventWokeLedgerSummary("lead.arrived", null, "trading")), { type: "lead.arrived", id: null, profile: "trading" });
  assert.deepEqual(parseEventWokeSummary(eventWokeLedgerSummary("lead.arrived", "evt-1", "trading")), { type: "lead.arrived", id: "evt-1", profile: "trading" });
  assert.deepEqual(parseEventUnbindSummary(eventUnbindLedgerSummary("lead-arrived")), { name: "lead-arrived" });
  assert.deepEqual(parseEventFailedSummary(eventFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseEventBindSummary(""), null);
  assert.equal(parseEventBindSummary("Event lead-arrived bound to trading"), null, "a bind line with no secret env segment does not parse");
  assert.equal(parseEventBindSummary("Event Bad Door bound to trading (secret env LEAD_SECRET)"), null, "a name the door pattern refuses does not parse");
  assert.equal(parseEventBindSummary("Event lead-arrived bound to trading (secret env lead_secret)"), null, "a secret env name the door pattern refuses does not parse");
  assert.equal(parseEventWokeSummary("Event lead.arrived woke profile Bad Profile"), null, "a profile the door pattern refuses does not parse");
  assert.equal(parseEventWokeSummary("Event lead.arrived evt-1 woke profile trading extra"), null, "a trailing token does not parse");
  assert.equal(parseEventUnbindSummary("Event lead-arrived unbound now"), null, "a trailing token does not parse");
  assert.equal(parseEventFailedSummary("Event read failed:"), null, "a truncated line does not parse");
  assert.equal(parseEventFailedSummary("Event resolve failed: boom"), null, "a phase the writer never uses does not parse");
});

test("event history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-event-history"), "sam-event-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-event-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["events", "history"], "the argv rides events history");
});

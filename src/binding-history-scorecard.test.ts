import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { bindingFailureSummary, bindingHistoryScorecardText, bindingRemovedLedgerSummary, bindingSetLedgerSummary, parseBindingFailedSummary, parseBindingRemovedSummary, parseBindingSetSummary } from "./bindings.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The binding history daily-measurement wiring (2026-11-21,
// the measured-proof series): every binding lifecycle event
// has ledgered as a binding-set / binding-removed /
// binding-failed line since deterministic bindings landed -
// the set and removed lines as inline concatenation with no
// ONE writer and no fold, so how many bindings were ever set,
// moved, or removed, across how many channels and profiles,
// and whether a binding resolve ever failed was invisible in
// aggregate (listBindings reads only the current store). A
// resolve failure means a person bound to their own scoped
// SAM silently landed on the channel default, so the verdict
// is attention only when any failure was ever recorded or a
// line is unparseable. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no channel name
// or id, no peer id, no profile name, no reason - the
// summaries carry channel names, peer sender ids, and
// failure reasons, which the fold consumes and never prints.
// The scorecard path is a pure read - it creates nothing,
// sets nothing, removes nothing, and resolves nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-binding-history-"));
}

test("binding history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = bindingHistoryScorecardText(dir);
    assert.equal(text, "Binding history: clear, 0 set, 0 updated, 0 removed, 0 failed, 0 read, 0 resolve, 0 distinct channels, 0 distinct profiles, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = bindingHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held binding scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binding history scorecard: the history folds to counts and distinct channels and profiles, and no channel, peer, or profile surfaces", () => {
  const dir = scratch();
  try {
    const clean = bindingHistoryScorecardText(dir);
    recordActivity(dir, "sekrit-profile", "binding-set", bindingSetLedgerSummary(false, "Sekrit Channel", "424242", "sekrit-profile"));
    recordActivity(dir, "sekrit-profile", "binding-set", bindingSetLedgerSummary(true, "Sekrit Channel", null, "sekrit-profile"));
    recordActivity(dir, "other-profile", "binding-set", bindingSetLedgerSummary(false, "Other Sekrit", null, "other-profile"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = bindingHistoryScorecardText(dir);
    assert.equal(text, "Binding history: clear, 2 set, 1 updated, 0 removed, 0 failed, 0 read, 0 resolve, 2 distinct channels, 2 distinct profiles, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("424242"), false, "no peer id surfaces");
    assert.equal(text.includes("sekrit-profile"), false, "no profile name surfaces");
    assert.notEqual(text, clean, "the first recorded binding changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binding history scorecard: a removed line counts its profile but its channel id never enters the distinct-channel count, and no id or reason surfaces", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekrit-profile", "binding-set", bindingSetLedgerSummary(false, "Sekrit Channel", null, "sekrit-profile"));
    recordActivity(dir, "sekrit-profile", "binding-removed", bindingRemovedLedgerSummary("sekrit-channel-id-123", "424242", "sekrit-profile"));
    const text = bindingHistoryScorecardText(dir);
    assert.equal(text, "Binding history: clear, 1 set, 0 updated, 1 removed, 0 failed, 0 read, 0 resolve, 1 distinct channels, 1 distinct profiles, 2 total");
    assert.equal(text.includes("sekrit-channel-id-123"), false, "no channel id surfaces");
    assert.equal(text.includes("424242"), false, "no peer id surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binding history scorecard: a failure is attention, split read and resolve, with no channel name or reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "binding-failed", bindingFailureSummary("read", "sekrit db path gone"));
    recordActivity(dir, "trading", "binding-failed", bindingFailureSummary("resolve", "sekrit db path gone", "Sekrit Channel"));
    const text = bindingHistoryScorecardText(dir);
    assert.equal(text, "Binding history: attention, 0 set, 0 updated, 0 removed, 2 failed, 1 read, 1 resolve, 1 distinct channels, 0 distinct profiles, 2 total");
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("sekrit db path"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binding history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekrit-profile", "binding-set", bindingSetLedgerSummary(false, "Dip Telegram", null, "sekrit-profile"));
    recordActivity(dir, "sekrit-profile", "binding-removed", "Some wholly novel binding shape naming sekrit_evidence");
    recordActivity(dir, "sekrit-profile", "binding-set", "Binding set: channel Dip Telegram (all peers) -> profile Bad Profile");
    const text = bindingHistoryScorecardText(dir);
    assert.equal(text, "Binding history: attention, 1 set, 0 updated, 0 removed, 0 failed, 0 read, 0 resolve, 1 distinct channels, 1 distinct profiles, 3 total, 2 unparseable");
    assert.equal(text.includes("novel binding"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("Bad Profile"), false, "no unrecognized profile surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binding parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(bindingSetLedgerSummary(false, "Dip Telegram", null, "trading"), "Binding set: channel Dip Telegram (all peers) -> profile trading");
  assert.equal(bindingSetLedgerSummary(false, "Dip Telegram", "424242", "trading"), "Binding set: channel Dip Telegram, peer 424242 -> profile trading");
  assert.equal(bindingSetLedgerSummary(true, "Dip Telegram", null, "trading"), "Binding updated: channel Dip Telegram (all peers) -> profile trading");
  assert.equal(bindingRemovedLedgerSummary("chan-123", null, "trading"), "Binding removed: channel chan-123 (all peers) -> profile trading");
  assert.equal(bindingFailureSummary("read", "boom"), "Binding read failed: boom");
  assert.equal(bindingFailureSummary("resolve", "boom", "Dip Telegram"), "Binding resolve failed for channel Dip Telegram: boom");
  assert.deepEqual(parseBindingSetSummary(bindingSetLedgerSummary(false, "Dip Telegram", "424242", "trading")), { action: "set", channel: "Dip Telegram", peer: "424242", profile: "trading" });
  assert.deepEqual(parseBindingSetSummary(bindingSetLedgerSummary(true, "Dip Telegram", null, "trading")), { action: "updated", channel: "Dip Telegram", peer: null, profile: "trading" });
  assert.deepEqual(parseBindingRemovedSummary(bindingRemovedLedgerSummary("chan-123", null, "trading")), { channel: "chan-123", peer: null, profile: "trading" });
  assert.deepEqual(parseBindingFailedSummary(bindingFailureSummary("read", "boom")), { phase: "read", channel: null });
  assert.deepEqual(parseBindingFailedSummary(bindingFailureSummary("resolve", "boom", "Dip Telegram")), { phase: "resolve", channel: "Dip Telegram" });
  assert.equal(parseBindingSetSummary(""), null);
  assert.equal(parseBindingSetSummary("Binding set: channel Dip Telegram -> profile trading"), null, "a set line with no peer segment does not parse");
  assert.equal(parseBindingSetSummary("Binding set: channel Dip Telegram (all peers) -> profile Bad Profile"), null, "a profile the registry pattern refuses does not parse");
  assert.equal(parseBindingRemovedSummary("Binding removed: channel chan-123 (all peers) -> profile trading extra"), null, "a trailing token does not parse");
  assert.equal(parseBindingFailedSummary("Binding read failed:"), null, "a truncated line does not parse");
  assert.equal(parseBindingFailedSummary("Binding resolve failed for channel Dip Telegram"), null, "a truncated resolve line does not parse");
});

test("binding history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-binding-history"), "sam-binding-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-binding-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["channels", "binding-history"], "the argv rides channels binding-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { doorBlockedLedgerSummary, doorHistoryScorecardText, doorLockoutLedgerSummary, parseDoorBlockedSummary, parseDoorLockoutSummary } from "./door-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The door history daily-measurement wiring (2026-11-21,
// the measured-proof series): the P10 door guard ledgers
// exactly one line per act - a "door-blocked" line for an
// injection-shaped message refused at a mini's web door
// and a "door-lockout" line when invalid-key probing locks
// every door - but neither class was ever folded, so how
// many attacks were ever refused, which of the five
// injection families they belonged to, and how many probe
// lockouts ever fired was invisible; the guard's own stats
// are in-memory and reset on every dashboard restart. A
// recorded refusal or lockout is itself the signal, so the
// verdict is attention when any was ever recorded or any
// line is unparseable, else clear (the never-list
// precedent). The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no mini name - the
// blocked line's actor is the mini's name and never
// surfaces. The scorecard path is a pure read - it creates
// nothing and screens, blocks, probes, and locks nothing;
// every state here is built through the ledger's own
// public door (recordActivity) with the seams' own summary
// writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-door-history-"));
}

const BARE = "Door history: clear, 0 blocked, 0 lockouts, categories none, 0 total";

test("door history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = doorHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = doorHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held door scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door history scorecard: recorded acts fold to counts with categories in the fixed vocabulary order", () => {
  const dir = scratch();
  try {
    const clean = doorHistoryScorecardText(dir);
    recordActivity(dir, "dip", "door-blocked", doorBlockedLedgerSummary("tool-coercion"));
    recordActivity(dir, "sekrit-mini", "door-blocked", doorBlockedLedgerSummary("prompt-extraction"));
    recordActivity(dir, "dip", "door-blocked", doorBlockedLedgerSummary("tool-coercion"));
    recordActivity(dir, "sam", "door-lockout", doorLockoutLedgerSummary());
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = doorHistoryScorecardText(dir);
    assert.equal(text, "Door history: attention, 3 blocked, 1 lockouts, categories prompt-extraction 1 / tool-coercion 2, 4 total");
    assert.equal(text.includes("sekrit-mini"), false, "no mini name surfaces");
    assert.equal(text.includes("dip"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded refusal changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "door-blocked", doorBlockedLedgerSummary("memory-poisoning"));
    recordActivity(dir, "dip", "door-blocked", "Refused a made-up-category message at the door");
    recordActivity(dir, "sam", "door-lockout", "Doors locked for some other sekrit reason");
    const text = doorHistoryScorecardText(dir);
    assert.equal(text, "Door history: attention, 1 blocked, 0 lockouts, categories memory-poisoning 1, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("made-up-category"), false, "no drifted category surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(doorBlockedLedgerSummary("instruction-override"), "Refused a instruction-override message at the door");
  assert.equal(doorLockoutLedgerSummary(), "Invalid door keys locked the doors for 5 minutes");
  assert.deepEqual(parseDoorBlockedSummary(doorBlockedLedgerSummary("role-impersonation")), { category: "role-impersonation" });
  assert.equal(parseDoorLockoutSummary(doorLockoutLedgerSummary()), true);
  assert.equal(parseDoorBlockedSummary(""), null);
  assert.equal(parseDoorBlockedSummary("Refused a unknown-category message at the door"), null, "a category outside the five-class vocabulary does not parse");
  assert.equal(parseDoorBlockedSummary("Refused a tool-coercion message at the door tonight"), null, "a line with trailing text does not parse");
  assert.equal(parseDoorLockoutSummary("Invalid door keys locked the doors for 6 minutes"), false, "a drifted lockout line does not parse");
});

test("door history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-door-history"), "sam-door-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-door-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["minis", "door-history"], "the argv rides minis door-history");
});

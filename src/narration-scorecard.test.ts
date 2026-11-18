import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { narrationChannelLedgerSummary, narrationScorecardText, parseNarrationChannel } from "./reply-guard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The narration-channel daily-measurement wiring (2026-11-18,
// the measured-proof series): the narration channel withholds
// every tool-round's process narration from the message path
// and agent-turn ledgers one line per affected turn, by size
// only, but no daily surface ever counted the class, so a
// model that kept narrating in its tool rounds was invisible
// in aggregate. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it carries counts only:
// no stamp, no actor, no chat id, no verbatim summary - the
// withheld turns, the summed withheld rounds, and the summed
// withheld chars, and an unmatched shape counts as a turn
// with no rounds or chars, never printed. The scorecard path
// is a pure read - it creates nothing, spends no model call,
// and retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the
// channel's own summary writer
// (narrationChannelLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-narration-scorecard-"));
}

test("narration scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = narrationScorecardText(dir);
    assert.match(text, /^Narration withheld: clear$/m);
    assert.match(text, /^Withheld turns: 0$/m);
    assert.match(text, /^Withheld rounds: 0$/m);
    assert.match(text, /^Withheld chars: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = narrationScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held narration scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("narration scorecard: withholdings flip the verdict, sum rounds and chars, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = narrationScorecardText(dir);
    recordActivity(dir, "sam", "narration-channel", narrationChannelLedgerSummary(822, 9, "afb0f1ef-0000-0000-0000-000000000000"));
    recordActivity(dir, "dip", "narration-channel", narrationChannelLedgerSummary(49, 1, "b0875bc9-0000-0000-0000-000000000000"));
    recordActivity(dir, "sam", "narration-channel", "Some wholly novel withholding shape mentioning sekrit-narration");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = narrationScorecardText(dir);
    assert.match(text, /^Narration withheld: attention$/m);
    assert.match(text, /^Withheld turns: 3$/m);
    assert.match(text, /^Withheld rounds: 10$/m);
    assert.match(text, /^Withheld chars: 871$/m);
    assert.equal(text.includes("sekrit"), false, "no narration surfaces");
    assert.equal(text.includes("afb0f1ef"), false, "no chat id surfaces");
    assert.equal(text.includes("novel withholding"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first withholding changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("narration parse: the channel's own line parses, and only the fixed shape parses", () => {
  assert.deepEqual(parseNarrationChannel(narrationChannelLedgerSummary(281, 3, "afb0f1ef-0000-0000-0000-000000000000")), { chars: 281, rounds: 3 });
  assert.equal(parseNarrationChannel(""), null);
  assert.equal(parseNarrationChannel("Some wholly novel withholding shape"), null);
  assert.equal(parseNarrationChannel("Withheld some chars of tool-round narration across a few round(s) from the message path in chat afb0f1ef"), null);
});

test("narration scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-narration"), "sam-narration is allowlisted");
  const argv = scriptArgv("/some/root", "sam-narration");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "narration-scorecard"], "the argv rides observe narration-scorecard");
});

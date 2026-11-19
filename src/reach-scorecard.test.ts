import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseReachSummary, reachLedgerSummary, reachScorecardText } from "./reach.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The reach daily-measurement wiring (2026-11-18, the
// measured-proof series): every sam_reach call ledgers one
// reach line carrying the channel, the action, and the raw
// query text, but no daily surface ever counted the calls,
// so reach going silent or a channel mix shift was
// invisible in aggregate. The line carries no outcome, so
// the scorecard folds volume and mix only and claims
// nothing about success. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no actor, no channel name, no
// action token beyond the fixed buckets, and no part of a
// query - read queries are URLs and search queries are the
// owner's own words, and neither belongs in a trending
// surface; an unmatched shape counts as a call under other,
// never printed. The scorecard path is a pure read - it
// creates nothing, spends no model call, and reaches for
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-reach-scorecard-"));
}

test("reach scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = reachScorecardText(dir);
    assert.match(text, /^Reach calls: clear$/m);
    assert.match(text, /^Calls: 0$/m);
    assert.match(text, /^By action: none$/m);
    assert.match(text, /^Distinct channels: 0$/m);
    assert.match(text, /^Distinct actions: 0$/m);
    assert.match(text, /^Calls with no query: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = reachScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held reach scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reach scorecard: calls fold to fixed buckets and counts, a malformed line flips the verdict, and no channel or query leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "reach", reachLedgerSummary("web", "search", "sekrit search phrase"));
    recordActivity(dir, "sam", "reach", reachLedgerSummary("web", "read", "https://sekrit.example/page"));
    recordActivity(dir, "sam", "reach", reachLedgerSummary("github", "read", "ReactionLabs/sekrit-repo"));
    recordActivity(dir, "sam", "reach", reachLedgerSummary("v2ex", "hot", ""));
    const clean = reachScorecardText(dir);
    assert.match(clean, /^Reach calls: clear$/m);
    assert.match(clean, /^Calls: 4$/m);
    assert.match(clean, /^By action: search 1, read 2, other 1$/m);
    assert.match(clean, /^Distinct channels: 3$/m);
    assert.match(clean, /^Distinct actions: 3$/m);
    assert.match(clean, /^Calls with no query: 1$/m);
    recordActivity(dir, "sam", "reach", "Some wholly novel reach shape mentioning sekritchannel");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = reachScorecardText(dir);
    assert.match(text, /^Reach calls: attention$/m);
    assert.match(text, /^Calls: 5$/m);
    assert.match(text, /^By action: search 1, read 2, other 2$/m);
    assert.equal(text.includes("sekrit"), false, "no query surfaces");
    assert.equal(text.includes("web"), false, "no channel name surfaces");
    assert.equal(text.includes("github"), false, "no channel name surfaces");
    assert.equal(text.includes("v2ex"), false, "no channel name surfaces");
    assert.equal(text.includes("hot"), false, "no action token beyond the fixed buckets surfaces");
    assert.equal(text.includes("novel reach"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reach parse: the seam's own lines parse, and only the fixed shape parses", () => {
  assert.deepEqual(parseReachSummary(reachLedgerSummary("web", "search", "headlines today")), { action: "search", bucket: "search", channel: "web", hasQuery: true });
  assert.deepEqual(parseReachSummary(reachLedgerSummary("youtube", "subtitle", "https://youtu.be/x")), { action: "subtitle", bucket: "other", channel: "youtube", hasQuery: true });
  assert.deepEqual(parseReachSummary(reachLedgerSummary("v2ex", "hot", "")), { action: "hot", bucket: "other", channel: "v2ex", hasQuery: false });
  assert.equal(reachLedgerSummary("web", "search", "headlines"), "Reach web search headlines", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseReachSummary(""), null);
  assert.equal(parseReachSummary("Some wholly novel reach shape"), null);
  assert.equal(parseReachSummary("Reach web"), null);
});

test("reach scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-reach"), "sam-reach is allowlisted");
  const argv = scriptArgv("/some/root", "sam-reach");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["reach", "scorecard"], "the argv rides reach scorecard");
});

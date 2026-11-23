import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorthinessFailedSummary, worthinessFailedHistoryScorecardText, worthinessFailureSummary, worthinessReadFailureSummary } from "./worthiness.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The worthiness failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the worthiness
// gate's ledger touches ledger every failure as a
// worthiness-failed line through the TWO writers
// (worthinessFailureSummary for a failed assessed touch,
// fixed shape: "Worthiness <phase> failed for profile
// <profile> (<kind>[, verdict deliver|held]): <reason>",
// phases read / append, ridden by recordWorthinessFailure
// from the assessed read, which fails closed, and the
// append, which never eats the verdict;
// worthinessReadFailureSummary for a failed direct read,
// fixed shape: "Worthiness read failed: <reason>", ridden
// by recordWorthinessReadFailure, actor sam, no profile or
// kind) - but the class was never folded, so how often the
// gate judged with a dead memory (its duplicate and rate
// memory frozen while status folded the same ledger as
// truth) was invisible in aggregate. Every failure line is
// by construction a worthiness touch that did not complete
// its ledgering, so the verdict is attention when any
// failure was ever recorded or any line is unparseable,
// else clear. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no profile name, no kind name, no
// verdict, and no verbatim reason - the summaries carry
// profiles, kinds, and reasons, and the fold consumes and
// never prints them, and no delivery content ever surfaces
// (none enters the writer's line either). The scorecard
// path is a pure read - it creates nothing, sends nothing,
// and writes nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-worthiness-failed-history-"));
}

const BARE = "Worthiness failed history: clear, 0 failed, 0 read, 0 append, 0 distinct profiles, 0 distinct kinds, 0 total";

test("worthiness failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = worthinessFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = worthinessFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held worthiness scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worthiness failed history scorecard: both writers' failures fold to counts with distinct profiles and kinds as numbers only, and no profile, kind, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = worthinessFailedHistoryScorecardText(dir);
    recordActivity(dir, "trading", "worthiness-failed", worthinessFailureSummary("read", "trading", "heartbeat", null, "EISDIR: illegal operation sekrit"));
    recordActivity(dir, "trading", "worthiness-failed", worthinessFailureSummary("read", "trading", "heartbeat", null, "disk full"));
    recordActivity(dir, "trading", "worthiness-failed", worthinessFailureSummary("append", "trading", "heartbeat", { deliver: true, reason: "worthy" }, "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "worthiness-failed", worthinessFailureSummary("append", "sam", "second-answer", { deliver: false, reason: "duplicate" }, "EACCES: permission denied"));
    recordActivity(dir, "sam", "worthiness-failed", worthinessReadFailureSummary("ENOSPC: no space left sekrit"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = worthinessFailedHistoryScorecardText(dir);
    assert.equal(text, "Worthiness failed history: attention, 5 failed, 3 read, 2 append, 2 distinct profiles, 2 distinct kinds, 5 total");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.equal(text.includes("heartbeat"), false, "no kind name surfaces");
    assert.equal(text.includes("second-answer"), false, "no kind name surfaces");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worthiness failed history scorecard: the writers' own line caps still fold from the fixed heads", () => {
  const dir = scratch();
  try {
    const capped = worthinessFailureSummary("append", "sam", "heartbeat", { deliver: true, reason: "worthy" }, "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseWorthinessFailedSummary(capped), { phase: "append", profile: "sam", kind: "heartbeat", verdict: "deliver" });
    const cappedRead = worthinessReadFailureSummary("x".repeat(500));
    assert.equal(cappedRead.length, 200, "the read writer caps its line at 200");
    assert.deepEqual(parseWorthinessFailedSummary(cappedRead), { phase: "read", profile: null, kind: null, verdict: null });
    recordActivity(dir, "sam", "worthiness-failed", capped);
    recordActivity(dir, "sam", "worthiness-failed", cappedRead);
    const text = worthinessFailedHistoryScorecardText(dir);
    assert.equal(text, "Worthiness failed history: attention, 2 failed, 1 read, 1 append, 1 distinct profiles, 1 distinct kinds, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worthiness failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, a spaced-profile shape, an unknown-phase shape, and a bad-verdict shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "worthiness-failed", worthinessReadFailureSummary("EPERM: operation not permitted"));
    recordActivity(dir, "sam", "worthiness-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "worthiness-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "worthiness-failed", "Worthiness read failed:   ");
    recordActivity(dir, "sam", "worthiness-failed", "Worthiness read failed for profile two words (heartbeat): boom");
    recordActivity(dir, "sam", "worthiness-failed", "Worthiness delete failed for profile sam (heartbeat): boom");
    recordActivity(dir, "sam", "worthiness-failed", "Worthiness append failed for profile sam (heartbeat, verdict maybe): boom");
    const text = worthinessFailedHistoryScorecardText(dir);
    assert.equal(text, "Worthiness failed history: attention, 1 failed, 1 read, 0 append, 0 distinct profiles, 0 distinct kinds, 7 total, 6 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worthiness failed parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(worthinessFailureSummary("read", "sam", "heartbeat", null, "database is locked"), "Worthiness read failed for profile sam (heartbeat): database is locked");
  assert.equal(worthinessFailureSummary("append", "sam", "heartbeat", { deliver: false, reason: "duplicate" }, "database is locked"), "Worthiness append failed for profile sam (heartbeat, verdict held): database is locked");
  assert.equal(worthinessReadFailureSummary("database is locked"), "Worthiness read failed: database is locked");
  assert.deepEqual(parseWorthinessFailedSummary(worthinessFailureSummary("read", "sam", "heartbeat", null, "boom")), { phase: "read", profile: "sam", kind: "heartbeat", verdict: null });
  assert.deepEqual(parseWorthinessFailedSummary(worthinessFailureSummary("append", "sam", "heartbeat", { deliver: true, reason: "worthy" }, "boom")), { phase: "append", profile: "sam", kind: "heartbeat", verdict: "deliver" });
  assert.deepEqual(parseWorthinessFailedSummary(worthinessReadFailureSummary("boom")), { phase: "read", profile: null, kind: null, verdict: null });
  assert.equal(parseWorthinessFailedSummary(""), null);
  assert.equal(parseWorthinessFailedSummary("Worthiness read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseWorthinessFailedSummary("Worthiness read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseWorthinessFailedSummary("Worthiness read failed for profile sam (heartbeat):"), null, "an assessed line with no reason does not parse");
  assert.equal(parseWorthinessFailedSummary("Worthiness read failed for profile two words (heartbeat): boom"), null, "a profile the writer never writes (it is a single token) does not parse");
  assert.equal(parseWorthinessFailedSummary("Worthiness delete failed for profile sam (heartbeat): boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseWorthinessFailedSummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as a worthiness-failed line");
  assert.deepEqual(parseWorthinessFailedSummary("Worthiness read failed: boom: with colon"), { phase: "read", profile: null, kind: null, verdict: null }, "a reason carrying a colon still parses from the fixed head");
});

test("worthiness failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-worthiness-failed-history"), "sam-worthiness-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-worthiness-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["deliveries", "failed-history"], "the argv rides deliveries failed-history");
});

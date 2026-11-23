import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLinkFailedSummary, linkFailedHistoryScorecardText, linkFailureSummary } from "./links.js";
import { recordActivity } from "./activity.js";
import { skillUseFailureSummary } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The link failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the link registry
// ledgers every failed read door touch as a link-failed line
// through the ONE writer linkFailureSummary (two fixed shapes:
// read, whose ledger actor is sam by the writer's own rule, and
// resolve, naming the requesting actor), ridden by
// recordLinkFailure from the readLinks door that visibleScopes
// rides on every memory read - but the class was never folded,
// so how often the scope decision itself died was invisible in
// aggregate. Every failure line is by construction a link read
// that did not complete, so the verdict is attention when any
// failure was ever recorded or any line is unparseable, else
// clear. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and no verbatim reason - the
// summaries carry actors and reasons, and the fold consumes
// and never prints them. The scorecard path is a pure read -
// it creates nothing, sends nothing, and retries nothing;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-link-failed-history-"));
}

const BARE = "Link failed history: clear, 0 failed, 0 read, 0 resolve, 0 distinct actors, 0 total";

test("link failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = linkFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = linkFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held link scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("link failed history scorecard: the writer's failures fold to counts with distinct actors as a number only, and no actor or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = linkFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "link-failed", linkFailureSummary("read", "sam", "database is locked sekrit"));
    recordActivity(dir, "sam", "link-failed", linkFailureSummary("read", "sam", "disk full"));
    recordActivity(dir, "dip", "link-failed", linkFailureSummary("resolve", "dip", "EPERM: operation not permitted"));
    recordActivity(dir, "trading", "link-failed", linkFailureSummary("resolve", "trading", "EACCES: permission denied"));
    recordActivity(dir, "trading", "link-failed", linkFailureSummary("resolve", "trading", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = linkFailedHistoryScorecardText(dir);
    assert.equal(text, "Link failed history: attention, 5 failed, 2 read, 3 resolve, 3 distinct actors, 5 total");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
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

test("link failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = linkFailureSummary("resolve", "trading", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseLinkFailedSummary(capped), { phase: "resolve", actor: "trading" });
    recordActivity(dir, "trading", "link-failed", capped);
    const text = linkFailedHistoryScorecardText(dir);
    assert.equal(text, "Link failed history: attention, 1 failed, 0 read, 1 resolve, 1 distinct actors, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("link failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and a multi-token actor shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "link-failed", linkFailureSummary("read", "sam", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "link-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "link-failed", skillUseFailureSummary("agent-reach", null, "boom sekrit"));
    recordActivity(dir, "sam", "link-failed", "Link read failed:   ");
    recordActivity(dir, "sam", "link-failed", "Link resolve failed for sam:   ");
    recordActivity(dir, "sam", "link-failed", "Link resolve failed for two words: boom");
    const text = linkFailedHistoryScorecardText(dir);
    assert.equal(text, "Link failed history: attention, 1 failed, 1 read, 0 resolve, 1 distinct actors, 6 total, 5 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("link failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(linkFailureSummary("read", "sam", "database is locked"), "Link read failed: database is locked");
  assert.equal(linkFailureSummary("resolve", "dip", "database is locked"), "Link resolve failed for dip: database is locked");
  assert.deepEqual(parseLinkFailedSummary(linkFailureSummary("read", "sam", "boom")), { phase: "read", actor: "sam" });
  assert.deepEqual(parseLinkFailedSummary(linkFailureSummary("resolve", "dip", "boom")), { phase: "resolve", actor: "dip" });
  assert.deepEqual(parseLinkFailedSummary(linkFailureSummary("resolve", "trading", "boom")), { phase: "resolve", actor: "trading" });
  assert.equal(parseLinkFailedSummary(""), null);
  assert.equal(parseLinkFailedSummary("Link read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseLinkFailedSummary("Link read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseLinkFailedSummary("Link resolve failed for dip:"), null, "a resolve line with no reason does not parse");
  assert.equal(parseLinkFailedSummary("Link write failed: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseLinkFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), null, "a skill-use-failed line never parses as a link-failed line");
  assert.deepEqual(parseLinkFailedSummary("Link resolve failed for dip: boom: with colon"), { phase: "resolve", actor: "dip" }, "a reason carrying a colon still parses from the fixed head");
});

test("link failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-link-failed-history"), "sam-link-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-link-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["links", "failed-history"], "the argv rides links failed-history");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { briefLedgerSummary, briefScorecardText, parseBriefSummary, type BriefSection } from "./brief.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The brief-assembly daily-measurement wiring (2026-11-20, the
// measured-proof series): buildBrief has ledgered a brief line
// whenever a morning brief is assembled - until now as inline
// concatenation at the seam, with no ONE writer and no fold, so
// how often a brief has ever been assembled, and whether its
// five sections read ok, empty, or unavailable in aggregate,
// was invisible in aggregate even though the section states
// are the brief's whole honesty signal. An assembled brief is
// the brief working as designed, so the verdict is attention
// only when a line is unparseable. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no section
// content - the summaries carry the states, which the fold
// consumes into per-state counts and never prints beyond the
// fixed vocabulary. The scorecard path is a pure read - it
// creates nothing and assembles nothing; every state here is
// built through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-brief-scorecard-"));
}

function sections(states: BriefSection["state"][]): BriefSection[] {
  const names = ["Today", "Mail", "Needs you", "Watches", "Work queues"];
  return names.map((name, i) => ({ name, state: states[i] ?? "ok", lines: [] }));
}

test("brief scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = briefScorecardText(dir);
    assert.equal(text, "Brief assemblies: clear, 0 briefs, 0 ok sections, 0 empty sections, 0 unavailable sections, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = briefScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held brief scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("brief scorecard: the class folds to counts, per-state sections are summed, and no content surfaces", () => {
  const dir = scratch();
  try {
    const clean = briefScorecardText(dir);
    recordActivity(dir, "sam", "brief", briefLedgerSummary(sections(["unavailable", "unavailable", "ok", "ok", "empty"])));
    recordActivity(dir, "sam", "brief", briefLedgerSummary(sections(["ok", "empty", "ok", "ok", "ok"])));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = briefScorecardText(dir);
    assert.equal(text, "Brief assemblies: clear, 2 briefs, 6 ok sections, 2 empty sections, 2 unavailable sections, 2 total");
    assert.notEqual(text, clean, "the first recorded brief changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("brief scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "brief", briefLedgerSummary(sections(["ok", "ok", "ok", "ok", "ok"])));
    recordActivity(dir, "sam", "brief", "Some wholly novel brief shape naming sekrit_content");
    const text = briefScorecardText(dir);
    assert.equal(text, "Brief assemblies: attention, 1 briefs, 5 ok sections, 0 empty sections, 0 unavailable sections, 2 total, 1 unparseable");
    assert.equal(text.includes("novel brief"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_content"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("brief parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(briefLedgerSummary(sections(["unavailable", "unavailable", "ok", "ok", "empty"])), "Morning brief assembled: today=unavailable, mail=unavailable, needs you=ok, watches=ok, work queues=empty");
  assert.deepEqual(parseBriefSummary(briefLedgerSummary(sections(["ok", "empty", "ok", "ok", "ok"]))), {
    sections: [
      { name: "today", state: "ok" },
      { name: "mail", state: "empty" },
      { name: "needs you", state: "ok" },
      { name: "watches", state: "ok" },
      { name: "work queues", state: "ok" },
    ],
  });
  assert.equal(parseBriefSummary(""), null);
  assert.equal(parseBriefSummary("Morning brief assembled: today=ok, mail=ok, needs you=ok, watches=ok"), null, "a missing section does not parse");
  assert.equal(parseBriefSummary("Morning brief assembled: mail=ok, today=ok, needs you=ok, watches=ok, work queues=ok"), null, "a reordered section does not parse");
  assert.equal(parseBriefSummary("Morning brief assembled: today=great, mail=ok, needs you=ok, watches=ok, work queues=ok"), null, "an unknown state does not parse");
  assert.equal(parseBriefSummary("Morning brief assembled: today=ok, mail=ok, needs you=ok, watches=ok, work queues=ok extra"), null, "trailing text does not parse");
});

test("brief scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-brief-history"), "sam-brief-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-brief-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["brief", "scorecard"], "the argv rides brief scorecard");
});

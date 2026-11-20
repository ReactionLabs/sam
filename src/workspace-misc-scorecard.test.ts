import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { chatCitationLedgerSummary } from "./agent-turn.js";
import { briefLedgerSummary, type BriefSection } from "./brief.js";
import {
  codeRootClearedLedgerSummary,
  codeRootDesignatedLedgerSummary,
  parseBriefSummary,
  parseChatCitationSummary,
  parseCodeRootClearedSummary,
  parseCodeRootDesignatedSummary,
  parseStandingFileClearedSummary,
  parseStandingFileSetSummary,
  workspaceMiscScorecardText,
} from "./code.js";
import { standingFileClearedLedgerSummary, standingFileSetLedgerSummary } from "./standing-files.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The workspace-misc daily-measurement wiring (2026-11-20,
// the measured-proof series, census-finish sprint): every
// standing file set or cleared, every code root designated
// or cleared, every chat citation attached, and every
// morning brief assembled has ledgered as a standing-file /
// code-root / chat-citation / brief line since each seam
// landed - one line per act, in the fixed shapes the seams
// write, carrying the file's name and tier, the root's path,
// and the chats' eight-character prefixes - but the classes
// were never folded, so the workspace's slow drift was
// invisible in aggregate. Every act here is an operator,
// owner, or runtime act, so the verdict is attention only
// when a line is unparseable. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no file
// name, no path, no chat id - a fold that printed paths
// would change on every new designation even at an identical
// shape. The scorecard path is a pure read - it creates
// nothing, sets nothing, and clears nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-workspace-misc-"));
}

const LIVE_BRIEF: BriefSection[] = [
  { name: "Today", state: "unavailable", lines: [] },
  { name: "Mail", state: "unavailable", lines: [] },
  { name: "Needs You", state: "ok", lines: [] },
  { name: "Watches", state: "ok", lines: [] },
  { name: "Work Queues", state: "empty", lines: [] },
];

test("workspace misc scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = workspaceMiscScorecardText(dir);
    assert.equal(text, "Workspace misc: clear, 0 standing files (0 set, 0 cleared, 0 chars), 0 code roots (0 designated, 0 cleared), 0 chat citations, 0 briefs, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = workspaceMiscScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held workspace misc scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace misc scorecard: the live census shape folds to counts and no name, path, or chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = workspaceMiscScorecardText(dir);
    recordActivity(dir, "operator", "standing-file", standingFileSetLedgerSummary("persona", "stable", 17));
    recordActivity(dir, "operator", "standing-file", standingFileClearedLedgerSummary("persona"));
    recordActivity(dir, "operator", "code-root", codeRootDesignatedLedgerSummary("/opt/sam/code"));
    recordActivity(dir, "operator", "code-root", codeRootDesignatedLedgerSummary("/opt/sam/code"));
    recordActivity(dir, "sam", "chat-citation", chatCitationLedgerSummary("2e67eb98-1111-4222-8333-444444444444", "2e67eb98-1111-4222-8333-444444444444", "c3df753b-1111-4222-8333-444444444444"));
    recordActivity(dir, "sam", "chat-citation", chatCitationLedgerSummary("48d8efb2-1111-4222-8333-444444444444", "48d8efb2-1111-4222-8333-444444444444", "c3df753b-1111-4222-8333-444444444444"));
    recordActivity(dir, "sam", "brief", briefLedgerSummary(LIVE_BRIEF));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = workspaceMiscScorecardText(dir);
    assert.equal(text, "Workspace misc: clear, 2 standing files (1 set, 1 cleared, 17 chars), 2 code roots (2 designated, 0 cleared), 2 chat citations, 1 briefs, 7 total");
    assert.equal(text.includes("persona"), false, "no file name surfaces");
    assert.equal(text.includes("/opt/sam/code"), false, "no code-root path surfaces");
    assert.equal(text.includes("2e67eb98"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first workspace act changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace misc scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "code-root", codeRootClearedLedgerSummary());
    recordActivity(dir, "operator", "code-root", "Some wholly novel root shape mentioning sekrit paths");
    recordActivity(dir, "sam", "brief", "A brief in a novel shape");
    const text = workspaceMiscScorecardText(dir);
    assert.equal(text, "Workspace misc: attention, 0 standing files (0 set, 0 cleared, 0 chars), 1 code roots (0 designated, 1 cleared), 0 chat citations, 0 briefs, 1 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace misc parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(standingFileSetLedgerSummary("persona", "stable", 17), "Standing file persona (stable) set, 17 chars");
  assert.equal(standingFileClearedLedgerSummary("persona"), "Standing file persona cleared");
  assert.equal(codeRootDesignatedLedgerSummary("/opt/sam/code"), "Designated code root: /opt/sam/code");
  assert.equal(codeRootClearedLedgerSummary(), "Cleared the designated code root");
  assert.equal(
    chatCitationLedgerSummary("2e67eb98-1111-4222-8333-444444444444", "2e67eb98-1111-4222-8333-444444444444", "c3df753b-1111-4222-8333-444444444444"),
    "Citation attached in chat 2e67eb98 pointing at chat 2e67eb98, message c3df753b",
  );
  assert.equal(
    briefLedgerSummary(LIVE_BRIEF),
    "Morning brief assembled: today=unavailable, mail=unavailable, needs you=ok, watches=ok, work queues=empty",
  );
  assert.deepEqual(parseStandingFileSetSummary(standingFileSetLedgerSummary("persona", "stable", 17)), { chars: 17 });
  assert.deepEqual(parseStandingFileClearedSummary(standingFileClearedLedgerSummary("persona")), {});
  assert.deepEqual(parseCodeRootDesignatedSummary(codeRootDesignatedLedgerSummary("/opt/sam/code")), {});
  assert.deepEqual(parseCodeRootClearedSummary(codeRootClearedLedgerSummary()), {});
  assert.deepEqual(parseChatCitationSummary(chatCitationLedgerSummary("2e67eb98-1111-4222-8333-444444444444", "2e67eb98-1111-4222-8333-444444444444", "c3df753b-1111-4222-8333-444444444444")), {});
  assert.deepEqual(parseBriefSummary(briefLedgerSummary(LIVE_BRIEF)), {});
  assert.equal(parseStandingFileSetSummary(""), null);
  assert.equal(parseStandingFileSetSummary("Standing file persona set"), null, "a set line with no tier or char count does not parse");
  assert.equal(parseStandingFileClearedSummary("Standing file persona set, 17 chars"), null, "a set line is not a cleared line");
  assert.equal(parseCodeRootDesignatedSummary("Designated code root:"), null, "a designated line with no path does not parse");
  assert.equal(parseCodeRootClearedSummary("Cleared the designated code root yesterday"), null, "the cleared line is exact");
  assert.equal(parseChatCitationSummary("Citation attached in chat 2e67eb98"), null, "a truncated citation line does not parse");
  assert.equal(parseBriefSummary("Morning brief assembled:"), null, "a brief line with no sections does not parse");
});

test("workspace misc scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-workspace-misc"), "sam-workspace-misc is allowlisted");
  const argv = scriptArgv("/some/root", "sam-workspace-misc");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "misc-scorecard"], "the argv rides code misc-scorecard");
});

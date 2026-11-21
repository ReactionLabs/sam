import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { chatOrganizeHistoryScorecardText, chatOrganizeLedgerSummary, parseChatOrganizeSummary, ORGANIZE_STALE_DAYS } from "./chat-organize.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The chat organize history daily-measurement wiring
// (2026-11-21, the measured-proof series): every organize
// pass ledgers exactly one chat-organize line (scanned /
// renamed / archived counts) and nothing else persists the
// pass's outcome - the chats it archived read back as
// ordinary archived chats - but the class was never folded,
// so how many passes ever ran and what they did in aggregate
// was invisible. This family has no failure class of its own
// (a failed pass surfaces through the chat tool's error
// path, not a ledger kind), so the verdict is attention only
// when a line is unparseable, the setup-history precedent.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no chat title - the ledger line
// itself carries no titles, so nothing sensitive exists to
// leak. The scorecard path is a pure read - it creates
// nothing, organizes nothing, renames nothing, and archives
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-organize-history-"));
}

const BARE = "Chat organize history: clear, 0 passes, 0 scanned, 0 renamed, 0 archived, 0 distinct actors, 0 total";

test("chat organize history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = chatOrganizeHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = chatOrganizeHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held organize scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat organize history scorecard: recorded passes fold to summed counts with the distinct-actor count as a number only", () => {
  const dir = scratch();
  try {
    const clean = chatOrganizeHistoryScorecardText(dir);
    recordActivity(dir, "sam", "chat-organize", chatOrganizeLedgerSummary(8, 2, 3));
    recordActivity(dir, "trading", "chat-organize", chatOrganizeLedgerSummary(5, 0, 1));
    recordActivity(dir, "sam", "chat-organize", chatOrganizeLedgerSummary(8, 0, 0));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = chatOrganizeHistoryScorecardText(dir);
    assert.equal(text, "Chat organize history: clear, 3 passes, 21 scanned, 2 renamed, 4 archived, 2 distinct actors, 3 total");
    assert.equal(text.includes("trading"), false, "no actor name surfaces");
    assert.notEqual(text, clean, "the first recorded pass changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat organize history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "chat-organize", chatOrganizeLedgerSummary(4, 1, 1));
    recordActivity(dir, "sam", "chat-organize", "Organized chats: scanned sekrit_count, renamed 1, archived 1 (stale threshold " + ORGANIZE_STALE_DAYS + " days; nothing deleted, nothing pinned)");
    recordActivity(dir, "sam", "chat-organize", "Organized chats: scanned 4, renamed 1, archived 1 (stale threshold 3 days; nothing deleted, nothing pinned)");
    const text = chatOrganizeHistoryScorecardText(dir);
    assert.equal(text, "Chat organize history: attention, 1 passes, 4 scanned, 1 renamed, 1 archived, 1 distinct actors, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat organize parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(chatOrganizeLedgerSummary(8, 2, 3), "Organized chats: scanned 8, renamed 2, archived 3 (stale threshold " + ORGANIZE_STALE_DAYS + " days; nothing deleted, nothing pinned)");
  assert.deepEqual(parseChatOrganizeSummary(chatOrganizeLedgerSummary(8, 2, 3)), { scanned: 8, renamed: 2, archived: 3 });
  assert.deepEqual(parseChatOrganizeSummary(chatOrganizeLedgerSummary(0, 0, 0)), { scanned: 0, renamed: 0, archived: 0 });
  assert.equal(parseChatOrganizeSummary(""), null);
  assert.equal(parseChatOrganizeSummary("Organized chats: scanned 8, renamed 2, archived 3"), null, "a line missing the fixed tail does not parse");
  assert.equal(parseChatOrganizeSummary("Organized chats: scanned 8, renamed 2, archived 3 (stale threshold " + (ORGANIZE_STALE_DAYS + 1) + " days; nothing deleted, nothing pinned)"), null, "a threshold other than the module's own does not parse");
  assert.equal(parseChatOrganizeSummary("Organized chats: scanned -1, renamed 2, archived 3 (stale threshold " + ORGANIZE_STALE_DAYS + " days; nothing deleted, nothing pinned)"), null, "a negative count does not parse");
});

test("chat organize history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-organize-history"), "sam-organize-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-organize-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["chats", "organize-history"], "the argv rides chats organize-history");
});

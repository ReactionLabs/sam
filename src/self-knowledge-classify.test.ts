import test from "node:test";
import assert from "node:assert/strict";
import { classifyDefect } from "./self-work.js";

// Program H: the three new failure lines join the self-work
// classification (so the daily bridge can queue a repair from a
// recorded spec), while the guard's own lines deliberately do
// NOT classify - a suppression holding is the system working,
// never a defect.
function line(kind: string, summary: string) {
  return { at: "2026-11-14T12:00:00.000Z", actor: "dip", kind, summary };
}

test("the Program H failure kinds classify with their phases; guard lines stay informational", () => {
  assert.deepEqual(classifyDefect(line("context-failed", "Context meter write failed: EISDIR"))?.key, "context-failed:write");
  assert.deepEqual(classifyDefect(line("context-failed", "Context meter read failed: EISDIR"))?.key, "context-failed:read");
  assert.deepEqual(classifyDefect(line("fence-integrity-failed", "Fence integrity check failed for profile dip: 1 law record(s) changed"))?.key, "fence-integrity-failed");
  assert.deepEqual(classifyDefect(line("episodes-failed", "Episodes evidence read failed: stored evidence was not valid JSON"))?.key, "episodes-failed:read");
  assert.equal(classifyDefect(line("memory-suppressed", "Memory write suppressed via episodes for dip: matched capture suppression ab12cd34 (needle sha256 0123456789ab); nothing was stored")), null);
  assert.equal(classifyDefect(line("memory-suppression", "Capture suppression recorded for profile dip: needle sha256 0123456789ab (suppression ab12cd34, from chat-1); 0 live memory record(s) already match and await the owner's purge decision")), null);
});

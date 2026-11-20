import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  gitCloneRefusedLedgerSummary,
  gitCloneResultLedgerSummary,
  gitCloneScorecardText,
  parseGitCloneSummary,
} from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The git clone daily-measurement wiring (2026-11-20, the
// measured-proof series): every clone attempt has ledgered
// as a git-clone line since the Hands v2 clone landed - a
// refusal before git runs and the run's own result line,
// carrying the repo URL and the destination path - but the
// class was never folded, so whether a clone has ever
// succeeded was invisible in aggregate (code runs and code
// writes are measured; the clones that populate the code
// root were not). A failed or refused clone is a broken
// fetch, so the verdict is attention when any clone failed
// or was refused or any line is unparseable. The parser
// classifies by the line's STATUS, never its verb: the one
// live line predates the verb-honesty fix and reads
// "Cloned ... : exit 128". The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no URL,
// no destination, no refusal reason - the summary carries
// the URL and the path, which the fold counts and never
// prints. The scorecard path is a pure read - it creates
// nothing and clones nothing; every state here is built
// through the ledger's own public door (recordActivity)
// with the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-git-clone-scorecard-"));
}

test("git clone scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = gitCloneScorecardText(dir);
    assert.equal(text, "Git clones: clear, 0 cloned, 0 failed, 0 refused, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = gitCloneScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held git clone scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("git clone scorecard: the class folds to counts, and no URL or destination surfaces", () => {
  const dir = scratch();
  try {
    const clean = gitCloneScorecardText(dir);
    recordActivity(dir, "sam", "git-clone", gitCloneResultLedgerSummary(true, "https://github.com/sekrit/sekrit-repo", "sekrit-dest", "ok"));
    recordActivity(dir, "sam", "git-clone", gitCloneResultLedgerSummary(false, "https://github.com/other/other-repo", "other-dest", "exit 128"));
    recordActivity(dir, "operator", "git-clone", gitCloneRefusedLedgerSummary("an invalid URL into bad-dest", "unsupported protocol"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = gitCloneScorecardText(dir);
    assert.equal(text, "Git clones: attention, 1 cloned, 1 failed, 1 refused, 3 total");
    assert.equal(text.includes("sekrit"), false, "no URL or destination surfaces");
    assert.equal(text.includes("other-repo"), false, "no failed URL surfaces");
    assert.equal(text.includes("unsupported protocol"), false, "no refusal reason surfaces");
    assert.notEqual(text, clean, "the first recorded clone changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("git clone scorecard: the legacy verb line classifies by its status, and an unmatched shape is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "git-clone", "Cloned https://github.com/ReactionLabs/agent-bridge into agent-bridge: exit 128");
    recordActivity(dir, "sam", "git-clone", "Some wholly novel clone shape mentioning sekrit-repo");
    const text = gitCloneScorecardText(dir);
    assert.equal(text, "Git clones: attention, 0 cloned, 1 failed, 0 refused, 2 total, 1 unparseable");
    assert.equal(text.includes("agent-bridge"), false, "the legacy line's URL never surfaces");
    assert.equal(text.includes("novel clone"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit-repo"), false, "no URL surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("git clone parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    gitCloneResultLedgerSummary(true, "https://example.com/repo", "dest", "ok"),
    "Cloned https://example.com/repo into dest: ok",
  );
  assert.equal(
    gitCloneResultLedgerSummary(false, "https://example.com/repo", "dest", "exit 128"),
    "Clone failed for https://example.com/repo into dest: exit 128",
  );
  assert.equal(
    gitCloneRefusedLedgerSummary("https://example.com/repo into dest", "destination escapes the code root"),
    "Refused clone of https://example.com/repo into dest: destination escapes the code root",
  );
  assert.deepEqual(parseGitCloneSummary(gitCloneResultLedgerSummary(true, "https://example.com/repo", "dest", "ok")), { action: "cloned" });
  assert.deepEqual(parseGitCloneSummary(gitCloneResultLedgerSummary(false, "https://example.com/repo", "dest", "exit 1 (timed out)")), { action: "failed" });
  assert.deepEqual(parseGitCloneSummary("Cloned https://example.com/repo into dest: exit 128"), { action: "failed" }, "a legacy verb with a failed status is a failure");
  assert.deepEqual(parseGitCloneSummary(gitCloneRefusedLedgerSummary("an invalid URL into dest", "bad url")), { action: "refused" });
  assert.equal(parseGitCloneSummary(""), null);
  assert.equal(parseGitCloneSummary("Cloned https://example.com/repo into dest: maybe"), null, "an unknown status does not parse");
  assert.equal(parseGitCloneSummary("Cloned https://example.com/repo: ok"), null, "a result line with no destination does not parse");
  assert.equal(parseGitCloneSummary("Refused clone of dest"), null, "a refusal line with no reason does not parse");
});

test("git clone scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-git-clones"), "sam-git-clones is allowlisted");
  const argv = scriptArgv("/some/root", "sam-git-clones");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "clone-scorecard"], "the argv rides code clone-scorecard");
});

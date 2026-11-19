import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseSandboxCreateSummary,
  parseSandboxDestroySummary,
  parseSandboxPipSummary,
  parseSandboxWriteSummary,
  sandboxCreateLedgerSummary,
  sandboxDestroyLedgerSummary,
  sandboxPipLedgerSummary,
  sandboxScorecardText,
  sandboxWriteLedgerSummary,
} from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The sandbox daily-measurement wiring (2026-11-19, the
// measured-proof series): every sandbox create, destroy,
// write, and pip install has ledgered as a sandbox-create /
// sandbox-destroy / sandbox-write / sandbox-pip line since
// the sandbox manager landed - one line per lifecycle event,
// in the fixed shapes the seams write, carrying the sandbox
// name and, for writes, the file path and content hash, and
// for installs the exact package spec and outcome - but the
// classes were never folded, so how many sandboxes SAM has
// created, written into, destroyed, or installed into, and
// whether any install ever failed, was invisible in
// aggregate. The verdict is attention only when a pip
// install failed or a line is unparseable: creates, writes,
// and destroys are operator or working acts, a failed
// install is the news. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no sandbox name,
// no file path, no content hash, and no package spec - a
// sandbox fold that printed names would publish the working
// surfaces it exists to watch. The scorecard path is a pure
// read - it creates nothing, writes nothing, installs
// nothing, and destroys nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-sandbox-scorecard-"));
}

const HASH = "a".repeat(64);

test("sandbox scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = sandboxScorecardText(dir);
    assert.equal(text, "Sandboxes: clear, 0 created, 0 destroyed, 0 writes, 0 installs (ok 0, failed 0), 0 distinct sandboxes, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = sandboxScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held sandbox scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandbox scorecard: the lifecycle folds to counts and no name, path, hash, or spec surfaces", () => {
  const dir = scratch();
  try {
    const clean = sandboxScorecardText(dir);
    recordActivity(dir, "operator", "sandbox-create", sandboxCreateLedgerSummary("sekritbox"));
    recordActivity(dir, "operator", "sandbox-create", sandboxCreateLedgerSummary("otherbox"));
    recordActivity(dir, "sam", "sandbox-write", sandboxWriteLedgerSummary("sekrit.py", "sekritbox", HASH));
    recordActivity(dir, "sam", "sandbox-write", sandboxWriteLedgerSummary("deep/sekrit2.py", "sekritbox", HASH));
    recordActivity(dir, "operator", "sandbox-destroy", sandboxDestroyLedgerSummary("otherbox"));
    recordActivity(dir, "sam", "sandbox-pip", sandboxPipLedgerSummary("sekritpkg==1.2.3", "sekritbox", true, 0, false));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = sandboxScorecardText(dir);
    assert.equal(text, "Sandboxes: clear, 2 created, 1 destroyed, 2 writes, 1 installs (ok 1, failed 0), 2 distinct sandboxes, 6 total");
    assert.equal(text.includes("sekrit"), false, "no sandbox name, path, or package surfaces");
    assert.equal(text.includes(HASH), false, "no content hash surfaces");
    assert.notEqual(text, clean, "the first lifecycle event changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandbox scorecard: a failed install is attention, timed out or not", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "sandbox-create", sandboxCreateLedgerSummary("b1"));
    recordActivity(dir, "sam", "sandbox-pip", sandboxPipLedgerSummary("pkg==1.0.0", "b1", false, 1, false));
    recordActivity(dir, "sam", "sandbox-pip", sandboxPipLedgerSummary("pkg2==2.0.0", "b1", false, null, true));
    const text = sandboxScorecardText(dir);
    assert.equal(text, "Sandboxes: attention, 1 created, 0 destroyed, 0 writes, 2 installs (ok 0, failed 2), 1 distinct sandboxes, 3 total");
    assert.equal(text.includes("pkg"), false, "no package spec surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandbox scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "sandbox-create", sandboxCreateLedgerSummary("b1"));
    recordActivity(dir, "sam", "sandbox-write", "Some wholly novel sandbox shape mentioning sekrit files");
    recordActivity(dir, "sam", "sandbox-pip", "Installed pkg==1.0.0 into sandbox b1");
    const text = sandboxScorecardText(dir);
    assert.equal(text, "Sandboxes: attention, 1 created, 0 destroyed, 0 writes, 0 installs (ok 0, failed 0), 1 distinct sandboxes, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel sandbox"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandbox parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(sandboxCreateLedgerSummary("soulfind"), "Created sandbox soulfind");
  assert.equal(sandboxDestroyLedgerSummary("soulfind"), "Deleted sandbox soulfind");
  assert.equal(
    sandboxWriteLedgerSummary("find.py", "soulfind", HASH),
    "Wrote find.py in sandbox soulfind sha256:" + HASH,
  );
  assert.equal(
    sandboxPipLedgerSummary("requests==2.32.3", "soulfind", true, 0, false),
    "Installed requests==2.32.3 into sandbox soulfind: ok",
  );
  assert.equal(
    sandboxPipLedgerSummary("requests==2.32.3", "soulfind", false, 1, false),
    "Install failed for requests==2.32.3 into sandbox soulfind: exit 1",
  );
  assert.equal(
    sandboxPipLedgerSummary("requests==2.32.3", "soulfind", false, null, true),
    "Install failed for requests==2.32.3 into sandbox soulfind: exit null (timed out)",
  );
  assert.deepEqual(parseSandboxCreateSummary(sandboxCreateLedgerSummary("b1")), { name: "b1" });
  assert.deepEqual(parseSandboxDestroySummary(sandboxDestroyLedgerSummary("b1")), { name: "b1" });
  assert.deepEqual(parseSandboxWriteSummary(sandboxWriteLedgerSummary("a/b.py", "b1", HASH)), { name: "b1" });
  assert.deepEqual(parseSandboxPipSummary(sandboxPipLedgerSummary("p==1.0", "b1", true, 0, false)), { name: "b1", ok: true });
  assert.deepEqual(parseSandboxPipSummary(sandboxPipLedgerSummary("p==1.0", "b1", false, 2, false)), { name: "b1", ok: false });
  assert.deepEqual(parseSandboxPipSummary(sandboxPipLedgerSummary("p==1.0", "b1", false, null, true)), { name: "b1", ok: false });
  assert.equal(parseSandboxCreateSummary(""), null);
  assert.equal(parseSandboxCreateSummary("Created sandbox"), null, "a truncated create line does not parse");
  assert.equal(parseSandboxDestroySummary("Deleted sandbox b1 yesterday"), null);
  assert.equal(parseSandboxWriteSummary("Wrote a.py in sandbox b1 sha256:abc"), null, "a short hash does not parse");
  assert.equal(parseSandboxPipSummary("Installed p==1.0 into sandbox b1"), null, "an install line with no outcome does not parse");
  assert.equal(parseSandboxPipSummary("Some wholly novel sandbox shape"), null);
});

test("sandbox scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-sandboxes"), "sam-sandboxes is allowlisted");
  const argv = scriptArgv("/some/root", "sam-sandboxes");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "sandbox-scorecard"], "the argv rides code sandbox-scorecard");
});

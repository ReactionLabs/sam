import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionScorecardText, decideAction, proposeAction } from "./actions.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The approval-gate daily-measurement wiring (2026-11-18,
// the measured-proof series): the worthiness scorecard
// trends the delivery gate's verdicts and the outbox
// scorecard trends the queue downstream of it, but the ONE
// gate's own queue - proposals waiting on the owner - had
// no trending surface, so a backlog could sit or grow
// invisible. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it carries counts
// only: no stamp, no title, no detail, no actor, no
// result. The scorecard path is a pure read - it creates
// nothing, approves nothing, rejects nothing, and
// executes nothing; every state here is built through
// the gate's own public doors (proposeAction /
// decideAction), never around them.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-actions-scorecard-"));
}

test("actions scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = actionScorecardText(dir);
    assert.match(text, /^Approval gate: clear$/m);
    assert.match(text, /^Pending: 0$/m);
    assert.match(text, /^Done: 0$/m);
    assert.match(text, /^Rejected: 0$/m);
    assert.match(text, /^Failed: 0$/m);
    assert.match(text, /^Pending by kind: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = actionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held gate scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actions scorecard: a pending proposal flips the verdict, counts by kind, and leaks no content", () => {
  const dir = scratch();
  try {
    const clean = actionScorecardText(dir);
    proposeAction(dir, { actor: "sam", kind: "note", title: "sekrit title marker", detail: "sekrit detail marker" });
    proposeAction(dir, { actor: "sam", kind: "note", title: "second note", detail: "another detail" });
    proposeAction(dir, { actor: "sam", kind: "law", title: "a law marker", detail: "Always confirm before spending" });
    const text = actionScorecardText(dir);
    assert.match(text, /^Approval gate: attention$/m);
    assert.match(text, /^Pending: 3$/m);
    assert.match(text, /^Pending by kind: law 1, note 2$/m);
    assert.equal(text.includes("sekrit"), false, "no title or detail marker surfaces");
    assert.equal(text.includes("confirm before spending"), false, "detail text never surfaces");
    assert.notEqual(text, clean, "the first pending proposal changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actions scorecard: decided proposals fold to done and rejected counts", async () => {
  const dir = scratch();
  try {
    const a = proposeAction(dir, { actor: "sam", kind: "note", title: "keep this fact", detail: "A fact worth keeping" });
    const b = proposeAction(dir, { actor: "sam", kind: "note", title: "drop this fact", detail: "A fact not worth keeping" });
    await decideAction(dir, a.id, true);
    await decideAction(dir, b.id, false);
    const text = actionScorecardText(dir);
    assert.match(text, /^Approval gate: clear$/m);
    assert.match(text, /^Pending: 0$/m);
    assert.match(text, /^Done: 1$/m);
    assert.match(text, /^Rejected: 1$/m);
    assert.match(text, /^Pending by kind: none$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actions scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-actions"), "sam-actions is allowlisted");
  const argv = scriptArgv("/some/root", "sam-actions");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "scorecard"], "the argv rides actions scorecard");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { auditPrompts, promptAuditText, promptSurfaces, readPromptAudit, runPromptAudit, PROMPT_AUDIT_SCRIPT } from "./prompt-audit.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The prompt audit's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04, task battery's 14:04,
// answer judge's 15:04, and self-audit's 16:04 fixes): the
// prompt audit last ran on the box on 2026-11-13 while the
// shipped prompts kept changing (loader-loop guard, census
// sprint), and no heartbeat job refreshed it. promptAuditText
// is the script job's stdout and is P3-diffed on its facts,
// so it carries no clock reading (the record's `at` stamp is
// an ISO date fact and would announce "changed" daily at an
// identical score). Two consecutive runs at the same state
// produce byte-identical text P3 judges the same news; a real
// prompt change still changes the text.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-prompt-audit-scorecard-")); }

test("prompt-audit scorecard: two consecutive runs are byte-identical, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const first = runPromptAudit(root);
    const second = runPromptAudit(root);
    assert.match(String(readPromptAudit(root)?.at), /^\d{4}-\d{2}-\d{2}T/, "the recorded record keeps its stamp");
    const text = promptAuditText(second);
    assert.match(text, /^Prompt audit - \d+\/\d+ checks passed$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = promptAuditText(first);
    assert.equal(again, text, "two runs at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held prompt score the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt-audit scorecard: a real prompt change still changes the text", () => {
  const surfaces = promptSurfaces();
  const before = promptAuditText(auditPrompts(surfaces));
  assert.match(before, /Findings: none/);
  const broken = { ...surfaces, core: surfaces.core.replace("treat it as consequential and ask", "wing it") };
  const after = promptAuditText(auditPrompts(broken));
  assert.notEqual(after, before, "losing an anchored line changes the scorecard");
  assert.match(after, /decision-unsure/, "the lost line is named as a finding");
  assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the changed text either");
});

test("prompt-audit scorecard: sam-prompt-audit is allowlisted and rides the prompt-audit run door", () => {
  assert.ok(scriptCommandNames().includes(PROMPT_AUDIT_SCRIPT));
  const argv = scriptArgv(fresh(), PROMPT_AUDIT_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("prompt-audit") && argv.includes("run"));
});

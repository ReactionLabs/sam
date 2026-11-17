import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditModel } from "./model-edit.js";
import { ANSWER_JUDGE_SCRIPT, answerJudgeSummary, answerJudgeText, judgeAnswer } from "./answer-judge.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The answer judge's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04 and the task battery's
// 14:04 fixes): the judge summary had no plain-text scorecard,
// no script allowlist entry, and no daily job - and the box
// had recorded zero live verdicts, so answer quality could
// regress invisibly. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it carries no
// clock reading (the summary's lastAt stamp is an ISO date
// fact and would announce "changed" daily at held scores).
// Two reads at the same recorded state produce byte-identical
// text P3 judges the same news; a new verdict still changes
// the text. The scorecard is a pure read: it spends no model
// call, and judge runs stay the operator's --live act.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-answer-judge-scorecard-")); }

function fakeProvider(scores: { answered: number; grounded: number; noInventedFacts: number; rightLength: number }): EditModel {
  return {
    complete: async () => ({
      message: {
        content: JSON.stringify({
          scores,
          notes: { answered: "ask addressed", grounded: "claims checked", noInventedFacts: "invention checked", rightLength: "length checked" },
          summary: "Scored.",
        }),
      },
    }),
  } as EditModel;
}

test("answer judge scorecard: the empty state is stable, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const text = answerJudgeText(answerJudgeSummary(root));
    assert.match(text, /0 scored, 0 malformed/);
    assert.match(text, /No verdicts recorded yet/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = answerJudgeText(answerJudgeSummary(root));
    assert.equal(again, text, "two reads at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held judge scorecard the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer judge scorecard: scores ride the text with no stamp, and a new verdict changes it", async () => {
  const root = fresh();
  try {
    await judgeAnswer(root, { ask: "How many are entered?", evidence: "page cap 100, no total", answer: "100 or more." }, "stub-judge", fakeProvider({ answered: 5, grounded: 5, noInventedFacts: 5, rightLength: 5 }));
    const summary = answerJudgeSummary(root);
    assert.match(String(summary.lastAt), /^\d{4}-\d{2}-\d{2}T/, "the summary record keeps its stamp");
    const text = answerJudgeText(summary);
    assert.match(text, /1 scored, 0 malformed/);
    assert.match(text, /Mean overall: 5/);
    assert.match(text, /answered: 5/);
    assert.match(text, /Verdicts: 1 strong, 0 mixed, 0 weak/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.doesNotMatch(text, /How many are entered/, "no turn content in the text");

    const held = answerJudgeText(answerJudgeSummary(root));
    assert.equal(held, text, "a re-read at the same state is byte-identical");

    await judgeAnswer(root, { ask: "How many are entered?", evidence: "page cap 100, no total", answer: "Exactly 212, counted just now." }, "stub-judge", fakeProvider({ answered: 4, grounded: 1, noInventedFacts: 0, rightLength: 4 }));
    const moved = answerJudgeText(answerJudgeSummary(root));
    assert.notEqual(moved, text, "a new verdict still changes the text");
    assert.match(moved, /2 scored, 0 malformed/);
    assert.match(moved, /Mean overall: 3\.63/);
    assert.match(moved, /Weakest dimension: noInventedFacts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer judge scorecard: sam-answer-judge is allowlisted and rides the scorecard CLI door", () => {
  assert.ok(scriptCommandNames().includes(ANSWER_JUDGE_SCRIPT));
  const argv = scriptArgv(fresh(), ANSWER_JUDGE_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("answer-judge") && argv.includes("scorecard"));
});

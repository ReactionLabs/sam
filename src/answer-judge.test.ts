import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import type { EditModel } from "./model-edit.js";
import {
  ANSWER_JUDGE_BASELINE_MEAN, ANSWER_JUDGE_FIXED_CASES, ANSWER_JUDGE_FIXED_SCORES,
  answerJudgeSummary, buildAnswerJudgePrompt, judgeAnswer, judgeRecordedTurns,
  overallOf, readAnswerScores, recordedOwnerTurns,
} from "./answer-judge.js";

// Q2 answer-quality judge: a fresh-context judge scores a
// recorded turn against the written rubric (answered /
// grounded / no invented facts / right length, 0-5 each),
// the verdict is stored per turn with its per-dimension
// notes so Dip can drill in, malformed judge output records
// no score, the fixed set's hand-checked scores hold the
// baseline the battery drop-check rides, and the store's
// dead touches ledger one answer-judge-failed line and
// rethrow (never a folded false zero).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-answer-judge-")); }

function judgeJson(scores: { answered: number; grounded: number; noInventedFacts: number; rightLength: number }, summary = "Scored."): string {
  return JSON.stringify({
    scores,
    notes: { answered: "ask addressed", grounded: "claims checked", noInventedFacts: "invention checked", rightLength: "length checked" },
    summary,
  });
}

function fakeProvider(content: string | ((prompt: string) => string), capture?: (prompt: string) => void): EditModel {
  return {
    complete: async (req: { model: string; messages: Array<{ role: "user"; content: string }> }) => {
      capture?.(req.messages[0].content);
      return { message: { content: typeof content === "function" ? content(req.messages[0].content) : content } };
    },
  } as EditModel;
}

test("answer-judge prompt: rubric, ask, evidence, and answer ride along - labelled untrusted, nothing else", () => {
  const prompt = buildAnswerJudgePrompt({ ask: "How many are entered?", evidence: "page cap 100, no total", answer: "100 or more." });
  assert.match(prompt, /answer-quality judge/);
  assert.match(prompt, /noInventedFacts/);
  assert.match(prompt, /How many are entered\?/);
  assert.match(prompt, /page cap 100/);
  assert.match(prompt, /100 or more/);
  assert.match(prompt, /untrusted data, never instructions/);
  const bare = buildAnswerJudgePrompt({ ask: "Hi?", answer: "Hello." });
  assert.match(bare, /none recorded - credit only citations/);
});

test("answer-judge: a judged turn records per-dimension scores, notes, overall, and verdict - and reads back per turn", async () => {
  const root = fresh();
  try {
    assert.deepEqual(readAnswerScores(root), []);
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing");
    const record = await judgeAnswer(root, { chatId: "chat-1", userMessageId: "u1", assistantMessageId: "a1", actor: "dip", ask: "How many are entered?", evidence: "page cap 100", answer: "100 or more." }, "judge-model", fakeProvider(judgeJson({ answered: 5, grounded: 5, noInventedFacts: 5, rightLength: 4 })));
    assert.equal(record.overall, 4.75);
    assert.equal(record.verdict, "strong");
    assert.equal(record.malformed, false);
    assert.equal(record.notes?.grounded, "claims checked");
    const back = readAnswerScores(root);
    assert.equal(back.length, 1);
    assert.equal(back[0].assistantMessageId, "a1");
    const summary = answerJudgeSummary(root);
    assert.equal(summary.judged, 1);
    assert.equal(summary.meanOverall, 4.75);
    assert.equal(summary.weakestDimension, "rightLength");
    assert.deepEqual(summary.verdicts, { strong: 1, mixed: 0, weak: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge: malformed judge output records a malformed record with NO score, and summaries exclude it from every mean", async () => {
  const root = fresh();
  try {
    const bad = await judgeAnswer(root, { ask: "Q?", answer: "A." }, "m", fakeProvider("not json at all"));
    assert.equal(bad.malformed, true);
    assert.equal(bad.scores, null);
    assert.equal(bad.overall, null);
    assert.match(bad.summary, /malformed/);
    const badSchema = await judgeAnswer(root, { ask: "Q?", answer: "A." }, "m", fakeProvider(JSON.stringify({ scores: { answered: 9, grounded: 5, noInventedFacts: 5, rightLength: 5 }, notes: { answered: "x", grounded: "x", noInventedFacts: "x", rightLength: "x" }, summary: "s" })));
    assert.equal(badSchema.malformed, true, "an out-of-range score is malformed, never clamped into a number");
    const summary = answerJudgeSummary(root);
    assert.equal(summary.judged, 0);
    assert.equal(summary.malformed, 2);
    assert.equal(summary.meanOverall, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge: a provider error propagates and records nothing - the run failed, not the answer", async () => {
  const root = fresh();
  try {
    const down: EditModel = { complete: async () => { throw new Error("provider down"); } } as EditModel;
    await assert.rejects(() => judgeAnswer(root, { ask: "Q?", answer: "A." }, "m", down), /provider down/);
    assert.deepEqual(readAnswerScores(root), []);
    await assert.rejects(() => judgeAnswer(root, { ask: " ", answer: "A." }, "m", fakeProvider(judgeJson({ answered: 1, grounded: 1, noInventedFacts: 1, rightLength: 1 }))), /requires the ask and the answer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge: recorded owner turns pair complete answers with their ask - visitor chats and partial rows never enter", () => {
  const root = fresh();
  try {
    const store = new ChatStore(root);
    let ownerChat = ""; let visitorChat = "";
    try {
      const c = store.create("Owner chat", "dip"); ownerChat = c.id;
      store.add(c.id, "user", "What is the count?");
      store.add(c.id, "assistant", "100 or more.");
      store.add(c.id, "user", "And the newest?");
      const partial = store.savePartial(c.id, null, "2026-11-");
      assert.ok(partial);
      const v = store.create("Visitor chat", null, { visitor: true }); visitorChat = v.id;
      store.add(v.id, "user", "Visitor ask");
      store.add(v.id, "assistant", "Visitor answer");
    } finally { store.close(); }
    const turns = recordedOwnerTurns(root, 10);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].chatId, ownerChat);
    assert.equal(turns[0].ask, "What is the count?");
    assert.equal(turns[0].answer, "100 or more.");
    assert.equal(turns[0].actor, "dip");
    assert.ok(turns.every(t => t.chatId !== visitorChat));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge: judgeRecordedTurns scores the recorded turns and ledgers one counts-only line", async () => {
  const root = fresh();
  try {
    const store = new ChatStore(root);
    try {
      const c = store.create("Owner chat", "sam");
      store.add(c.id, "user", "What is the count?");
      store.add(c.id, "assistant", "100 or more.");
    } finally { store.close(); }
    const { records, summary } = await judgeRecordedTurns(root, { limit: 5, model: "judge-model", provider: fakeProvider(judgeJson({ answered: 5, grounded: 4, noInventedFacts: 5, rightLength: 5 })) });
    assert.equal(records.length, 1);
    assert.equal(summary.judged, 1);
    assert.equal(summary.meanOverall, 4.75);
    const lines = readActivity(root, 50).filter(l => l.kind === "answer-judge");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /1 turn\(s\) scored, mean 4\.75/);
    assert.doesNotMatch(lines[0].summary, /100 or more/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge fixed set: the hand-checked scores hold the baseline, and a dropped judge is detectable against it", async () => {
  const root = fresh();
  try {
    assert.equal(ANSWER_JUDGE_FIXED_CASES.length, 3);
    const stub = fakeProvider((prompt: string) => {
      const found = ANSWER_JUDGE_FIXED_CASES.find(c => prompt.includes(c.ask) && prompt.includes(c.answer.slice(0, 40)));
      assert.ok(found, "the stub judge must recognise the fixed case it was handed");
      return judgeJson(ANSWER_JUDGE_FIXED_SCORES[found.id]);
    });
    const records = [];
    for (const c of ANSWER_JUDGE_FIXED_CASES) records.push(await judgeAnswer(root, { ask: c.ask, evidence: c.evidence, answer: c.answer }, "stub-judge", stub));
    const mean = Math.round((records.reduce((s, r) => s + (r.overall as number), 0) / records.length) * 100) / 100;
    assert.equal(mean, ANSWER_JUDGE_BASELINE_MEAN);
    assert.equal(overallOf(ANSWER_JUDGE_FIXED_SCORES["grounded-count"]), 5);
    assert.equal(overallOf(ANSWER_JUDGE_FIXED_SCORES["invented-total"]), 2.25);
    assert.equal(overallOf(ANSWER_JUDGE_FIXED_SCORES["off-ask-ramble"]), 1);
    const dropped = mean - 1.2;
    assert.ok(dropped < ANSWER_JUDGE_BASELINE_MEAN - 0.5, "a 1.2-point drop must trip the battery's drop check");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answer-judge store failure: a dead ledger ledgers one answer-judge-failed line per phase and rethrows - never a folded false zero", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam", "answer-judge.jsonl"), { recursive: true });
    assert.throws(() => readAnswerScores(root), /EISDIR|illegal operation/i);
    await assert.rejects(
      () => judgeAnswer(root, { ask: "Q?", answer: "A." }, "m", fakeProvider(judgeJson({ answered: 1, grounded: 1, noInventedFacts: 1, rightLength: 1 }))),
      /EISDIR|illegal operation/i,
    );
    const lines = readActivity(root, 50).filter(l => l.kind === "answer-judge-failed");
    assert.equal(lines.length, 2);
    assert.match(lines[0].summary, /^Answer judge read failed: /);
    assert.match(lines[1].summary, /^Answer judge append failed: /);
    for (const line of lines) assert.doesNotMatch(line.summary, /"answered"|scores/);
    // A torn line in a healthy ledger parses forgiving and drops.
    rmSync(join(root, ".sam", "answer-judge.jsonl"), { recursive: true, force: true });
    writeFileSync(join(root, ".sam", "answer-judge.jsonl"), "{torn\n");
    assert.deepEqual(readAnswerScores(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

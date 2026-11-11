import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot, writeCodeFile, editCodeFile } from "./code.js";
import { recordVerification, verificationStatus } from "./verification.js";
import { codingPrompt, codingSummary, drainCodingTasks, listCodingTasks, queueCodingTask, updateCodingTask } from "./coding.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { readActivity } from "./activity.js";

// Phase D item 3 (coder C3): the coding loop. Fixtures mirror
// code.test.ts - a SAM home plus a separate project tree - and the
// stub turn stands in for runChatTurn: it persists the exchange the
// way the real turn does, then does its "work" through the real C1
// hands and the real verification ledger, so the loop is graded by
// the same machinery it rides in production.

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-coding-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
  return { base, sam, proj, chatId };
}

type Work = (iteration: number) => void;
function stubTurn(sam: string, work: Work, prompts?: string[]) {
  let calls = 0;
  return async (chatId: string, content: string) => {
    calls += 1;
    prompts?.push(content);
    const db = new ChatStore(sam);
    try { db.add(chatId, "user", content); } finally { db.close(); }
    work(calls);
    const db2 = new ChatStore(sam);
    try { db2.add(chatId, "assistant", "iteration " + calls + " reply"); } finally { db2.close(); }
    return "iteration " + calls + " reply";
  };
}
function verifyPass(sam: string) {
  recordVerification(sam, { kind: "build", passed: true, runId: "r-build-" + Math.random() });
  recordVerification(sam, { kind: "test", passed: true, runId: "r-test-" + Math.random() });
}
function chatTexts(sam: string, chatId: string): string[] {
  const db = new ChatStore(sam);
  try { return db.messages(chatId).map(m => m.content); } finally { db.close(); }
}

test("queue: refuses without a designated code root; validates actor, spec, and chat; clamps iterations", () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId, spec: "Add a hello file" }), /No code root is designated/);
    setCodeRoot(sam, proj);
    assert.throws(() => queueCodingTask(sam, { actor: "Bad Actor", chatId, spec: "x" }), /Invalid actor/);
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId, spec: "  " }), /Invalid coding spec/);
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId, spec: "x".repeat(4001) }), /Invalid coding spec/);
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId: "nope", spec: "x" }), /Chat not found/);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Add a hello file", maxIterations: 99 });
    assert.equal(task.status, "queued");
    assert.equal(task.maxIterations, 5);
    assert.equal(codingSummary(sam).queued, 1);
    assert.ok(readActivity(sam).some(a => a.kind === "coding-queued"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the loop closes DONE in one iteration when the turn writes and verifies; summary + diff post into the chat", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts exporting a greeting" });
    const runTurn = stubTurn(sam, () => { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n"); verifyPass(sam); });
    const out = await drainCodingTasks(sam, { runTurn });
    assert.deepEqual(out.ran, [task.id]);
    const done = listCodingTasks(sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.iterations, 1);
    assert.equal(done.verification, "verified");
    assert.deepEqual(done.changes.map(c => c.path), ["src/hello.ts"]);
    const texts = chatTexts(sam, chatId);
    const summary = texts[texts.length - 1];
    assert.match(summary, /Coding task done/);
    assert.match(summary, /Verification: verified/);
    assert.match(summary, /src\/hello\.ts/);
    assert.match(summary, /\+export const hi/);
    assert.ok(readActivity(sam).some(a => a.kind === "coding-done"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a failed verification is data: the loop iterates with the verdict as input and closes done when it passes", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Fix the greeting export", maxIterations: 3 });
    const prompts: string[] = [];
    const runTurn = stubTurn(sam, (iteration) => {
      if (iteration === 1) {
        writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'helo';\n");
        recordVerification(sam, { kind: "build", passed: true, runId: "b1" });
        recordVerification(sam, { kind: "test", passed: false, runId: "t1" });
      } else {
        editCodeFile(sam, "trading", "src/hello.ts", "'helo'", "'hello'");
        verifyPass(sam);
      }
    }, prompts);
    const out = await drainCodingTasks(sam, { runTurn });
    assert.deepEqual(out.ran, [task.id]);
    const done = listCodingTasks(sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.iterations, 2);
    assert.match(prompts[1], /verification ledger reads "failed"/);
    assert.match(prompts[1], /src\/hello\.ts/);
    assert.match(readFileSync(join(proj, "src/hello.ts"), "utf8"), /hello/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("iterations exhausted over unverified writes closes BLOCKED, never done, with the state named in the chat", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Write something and never verify it", maxIterations: 2 });
    const runTurn = stubTurn(sam, (iteration) => { writeCodeFile(sam, "trading", "src/draft" + iteration + ".ts", "export const x = " + iteration + ";\n"); });
    const out = await drainCodingTasks(sam, { runTurn });
    assert.deepEqual(out.ran, []);
    assert.deepEqual(out.blocked, [task.id]);
    const blocked = listCodingTasks(sam)[0];
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.iterations, 2);
    assert.equal(blocked.verification, "unverified");
    assert.equal(verificationStatus(sam).state, "unverified");
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Coding task blocked \(not done\)/);
    assert.ok(readActivity(sam).some(a => a.kind === "coding-blocked"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a turn that makes no changes closes done with the no-changes outcome stated; a thrown turn fails the task and posts it", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const noop = queueCodingTask(sam, { actor: "trading", chatId, spec: "Check whether a greeting file exists" });
    const out1 = await drainCodingTasks(sam, { runTurn: stubTurn(sam, () => { /* reads only */ }) });
    assert.deepEqual(out1.ran, [noop.id]);
    const doneNoop = listCodingTasks(sam).find(t => t.id === noop.id)!;
    assert.equal(doneNoop.status, "done");
    assert.deepEqual(doneNoop.changes, []);
    assert.match(doneNoop.result ?? "", /No code changes were made/);
    const boom = queueCodingTask(sam, { actor: "trading", chatId, spec: "Explode" });
    const out2 = await drainCodingTasks(sam, { runTurn: async () => { throw new Error("model went away"); } });
    assert.deepEqual(out2.failed, [boom.id]);
    const failed = listCodingTasks(sam).find(t => t.id === boom.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.result ?? "", /model went away/);
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Coding task failed/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a stale running task is recovered as failed by the next drain instead of wedging the queue", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Long task" });
    updateCodingTask(sam, task.id, { status: "running", startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const out = await drainCodingTasks(sam, { runTurn: stubTurn(sam, () => {}) });
    assert.deepEqual(out.recovered, [task.id]);
    assert.equal(listCodingTasks(sam)[0].status, "failed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sam_coding_task queues through the chat seam; visitors are refused; the prompt carries the verify-on-stop rule", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const queued = await executeOwnToolAsync(sam, "trading", "sam_coding_task", { spec: "Add a farewell export" }, undefined, chatId) as { status?: string; note?: string };
    assert.equal(queued.status, "queued");
    assert.match(queued.note ?? "", /only counts as done when the verification ledger/);
    assert.equal(listCodingTasks(sam).length, 1);
    const db = new ChatStore(sam);
    let visitorChat: string;
    try { visitorChat = db.create("Web chat", "sam", { visitor: true }).id; } finally { db.close(); }
    const refused = await executeOwnToolAsync(sam, "sam", "sam_coding_task", { spec: "anything" }, undefined, visitorChat) as { error?: string };
    assert.match(refused.error ?? "", /Visitors cannot queue coding tasks/);
    assert.equal(listCodingTasks(sam).length, 1);
    const p1 = codingPrompt(listCodingTasks(sam)[0], 1, null);
    assert.match(p1, /iteration 1 of 3/);
    assert.match(p1, /never claim done over unverified writes/);
    assert.match(p1, /Never push or open pull requests/);
    assert.match(p1, /commits your writes locally after each iteration/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- C5 self-review (Phase D item 4): verified is not done until
// the goldfish passes the diff. The review dep stands in for
// runGoldfishReview; the loop's contract with it is what is tested.

function reviewRecord(verdict: "PASS" | "BLOCK", summary: string, detail = "Validate first, spend the artifact last.") {
  return {
    at: new Date().toISOString(), spec: "spec", model: "test-model", changeCount: 1, changeHashes: [], malformed: false,
    verdict, summary,
    findings: verdict === "BLOCK" ? [{ severity: "BLOCKER" as const, detail, evidence: "- spend(code); + validate(code);", patternId: "LOCAL-3" }] : [],
  };
}

test("C5: a verified task closes done only after the review PASSes; the summary names the review", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts exporting a greeting" });
    const runTurn = stubTurn(sam, () => { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n"); verifyPass(sam); });
    let reviewedSpec = "";
    const out = await drainCodingTasks(sam, { runTurn, review: async (t) => { reviewedSpec = t.spec; return reviewRecord("PASS", "No concerns."); } });
    assert.deepEqual(out.ran, [task.id]);
    assert.match(reviewedSpec, /greeting/);
    const done = listCodingTasks(sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.review, "PASS: No concerns.");
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Self-review: PASS: No concerns\./);
    assert.ok(readActivity(sam).some(a => a.kind === "coding-review"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C5: a BLOCK is data - its findings ride the next prompt, and a later PASS closes done", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Fix the greeting export", maxIterations: 3 });
    const prompts: string[] = [];
    const runTurn = stubTurn(sam, (iteration) => {
      if (iteration === 1) { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'helo';\n"); verifyPass(sam); }
      else { editCodeFile(sam, "trading", "src/hello.ts", "'helo'", "'hello'"); verifyPass(sam); }
    }, prompts);
    let reviews = 0;
    const out = await drainCodingTasks(sam, { runTurn, review: async () => { reviews += 1; return reviews === 1 ? reviewRecord("BLOCK", "One blocker.") : reviewRecord("PASS", "Fixed."); } });
    assert.deepEqual(out.ran, [task.id]);
    const done = listCodingTasks(sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.iterations, 2);
    assert.equal(done.review, "PASS: Fixed.");
    assert.match(prompts[1], /BLOCKED the verified diff/);
    assert.match(prompts[1], /LOCAL-3/);
    assert.match(prompts[1], /Validate first/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C5: exhausting iterations under a BLOCK closes blocked, never done, with the block named", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Write something the reviewer hates", maxIterations: 2 });
    const runTurn = stubTurn(sam, (iteration) => { writeCodeFile(sam, "trading", "src/draft" + iteration + ".ts", "export const x = " + iteration + ";\n"); verifyPass(sam); });
    const out = await drainCodingTasks(sam, { runTurn, review: async () => reviewRecord("BLOCK", "Still blocked.") });
    assert.deepEqual(out.ran, []);
    assert.deepEqual(out.blocked, [task.id]);
    const blocked = listCodingTasks(sam)[0];
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.verification, "verified");
    assert.match(blocked.review ?? "", /^BLOCK: Still blocked\./);
    assert.match(blocked.result ?? "", /review BLOCK/);
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Coding task blocked \(not done\)/);
    assert.match(texts[texts.length - 1], /Self-review: BLOCK/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C5: a review that cannot run closes blocked naming the reason - verified alone is not done", async () => {
  const { base, sam, proj, chatId } = fixture();
  try {
    setCodeRoot(sam, proj);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts exporting a greeting" });
    const runTurn = stubTurn(sam, () => { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n"); verifyPass(sam); });
    const out = await drainCodingTasks(sam, { runTurn, review: async () => { throw new Error("Pattern Catalog not found"); } });
    assert.deepEqual(out.ran, []);
    assert.deepEqual(out.blocked, [task.id]);
    const blocked = listCodingTasks(sam)[0];
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.verification, "verified");
    assert.match(blocked.review ?? "", /unavailable: Pattern Catalog not found/);
    assert.match(blocked.result ?? "", /self-review could not run/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

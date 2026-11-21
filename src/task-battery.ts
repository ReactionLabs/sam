import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { modelApiKey } from "./config-wizard.js";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { MemorySuppressedError, captureSuppressionsFromText } from "./capture-guard.js";
import { codeWrites, readCodeFile, setCodeRoot, writeCodeFile } from "./code.js";
import { recordVerification, verificationGate } from "./verification.js";
import { annotateToolResult, processReplySources } from "./source-citations.js";
import { orchestrate, setOrchestrationRunnerForTests, type Lane } from "./orchestration.js";
import { errorReason } from "./error-reason.js";

/**
 * The task battery (Sprint 4 item 4, Program C): a fixed, versioned
 * set of real jobs Sam runs against itself, each scored pass or
 * fail with evidence, so "Sam got better" is a number.
 *
 * This is the sibling of the behavior eval battery (sam eval-battery,
 * 27 harness tasks, no model). That battery stays the ship gate for
 * prompt and harness changes. This one is the job scorecard:
 *
 * - FIXED AND VERSIONED. The case list and TASK_BATTERY_VERSION
 *   move together. A run is stored by version, and a later version
 *   does not overwrite an earlier one.
 * - SCRATCH HOMES. Every case executes in its own temp directory.
 *   The workspace the command was pointed at receives only the
 *   scorecard store and one counts-only ledger line. No case opens
 *   that workspace's memory, chats, or code root.
 * - NO LIVE MODEL HERE. A live end-to-end pass needs a model key
 *   and an external request. This module never sends one. `sam
 *   battery` runs the offline harness against the real machinery.
 *   `sam battery --live` with no key records liveRun pending-keys
 *   and does not turn that into a pass. A key that is present is
 *   not used: liveRun is pending-ruling and no request is sent.
 * - THE BUILD LANE IS MEASURED. The orchestration case runs a
 *   research lane and a build lane through the real coordinator.
 *   The build worker throws the same "Unsafe model output" the
 *   model path raises. The case fails, and the evidence names the
 *   error and the research lane that verified. A future live run
 *   that lands the build artifact scores pass through the same
 *   scorer. The failure is not relabeled.
 */

export const TASK_BATTERY_VERSION = "s4.1";

export const TASK_BATTERY_CASE_IDS = [
  "research-citations",
  "multi-file-coding",
  "orchestration-build-lane",
  "memory-do-not-store",
  "cold-chat-simple",
] as const;

export type TaskBatteryCaseId = typeof TASK_BATTERY_CASE_IDS[number];

export const COLD_CHAT_QUESTION = "What is 2 + 2?";
export const COLD_CHAT_ANSWER = "4";

const RESEARCH_SOURCE = "notes/brief.md";
const RESEARCH_FACT = "The launch window is Tuesday.";
const DO_NOT_STORE_INSTRUCTION = "Do not store the harbor gate code anywhere.";
const SUPPRESSED_FACT = "The harbor gate code is 9.";
const KEPT_FACT = "The cortado is two shots.";

export type TaskBatteryLiveRun = "not-requested" | "pending-keys" | "pending-ruling";

export interface TaskBatteryCaseResult {
  id: TaskBatteryCaseId;
  label: string;
  passed: boolean;
  evidence: string;
  durationMs: number;
  execution: "harness";
}

export interface TaskBatteryRun {
  version: string;
  at: string;
  execution: "harness";
  liveRun: TaskBatteryLiveRun;
  overall: { passed: number; total: number };
  cases: TaskBatteryCaseResult[];
  note: string;
}

export interface ResearchScoreInput {
  sourcesText: string;
  cited: number;
  laneVerdict: string;
  laneResult: string;
}

export function scoreResearch(input: ResearchScoreInput): { passed: boolean; evidence: string } {
  const cited = input.cited >= 1
    && /Sources:/.test(input.sourcesText)
    && input.sourcesText.includes(RESEARCH_SOURCE);
  const lane = input.laneVerdict === "verified"
    && /\[\d+\]/.test(input.laneResult)
    && input.laneResult.includes(RESEARCH_SOURCE);
  if (cited && lane) {
    return {
      passed: true,
      evidence: "Research lane verified with a citation of " + RESEARCH_SOURCE + ", and the reply's Sources list was built from the run registry.",
    };
  }
  const missing: string[] = [];
  if (!cited) missing.push("the reply did not keep a registry citation of " + RESEARCH_SOURCE);
  if (input.laneVerdict !== "verified") missing.push("the research lane verdict was " + (input.laneVerdict || "missing"));
  if (!/\[\d+\]/.test(input.laneResult)) missing.push("the lane result named no citation");
  return { passed: false, evidence: "Research job failed: " + missing.join("; ") + "." };
}

export interface MultiFileScoreInput {
  files: string[];
  contentsMatch: boolean;
  gateBefore: { closable: boolean; state: string };
  gateAfter: { closable: boolean; state: string };
}

export function scoreMultiFile(input: MultiFileScoreInput): { passed: boolean; evidence: string } {
  const filesOk = input.files.length >= 2 && input.contentsMatch;
  const gateHeld = input.gateBefore.closable === false && input.gateBefore.state === "unverified";
  const gateClosed = input.gateAfter.closable === true && input.gateAfter.state === "verified";
  if (filesOk && gateHeld && gateClosed) {
    return {
      passed: true,
      evidence: "Wrote " + input.files.join(" and ") + " through the code store. The verification gate refused to close before a fresh build and test, then closed verified.",
    };
  }
  const missing: string[] = [];
  if (input.files.length < 2) missing.push("fewer than two files were written (" + String(input.files.length) + ")");
  if (!input.contentsMatch) missing.push("a written file did not read back");
  if (!gateHeld) missing.push("the gate was " + input.gateBefore.state + " before verification (closable " + String(input.gateBefore.closable) + ")");
  if (!gateClosed) missing.push("the gate was " + input.gateAfter.state + " after build and test");
  return { passed: false, evidence: "Multi-file coding job failed: " + missing.join("; ") + "." };
}

export interface BuildLaneScoreInput {
  researchVerdict: string | null;
  buildStatus: string | null;
  buildVerdict: string | null;
  buildBlocker: string | null;
  buildAttempts: number;
  jobStatus: string | null;
}

/** The build-lane scorer. A verified build is a pass. The known
 *  unsafe-output failure is a fail whose evidence names it. Nothing
 *  in here turns that error into a pass. */
export function scoreBuildLane(input: BuildLaneScoreInput): { passed: boolean; evidence: string } {
  const researchOk = input.researchVerdict === "verified";
  const buildOk = input.buildStatus === "done" && input.buildVerdict === "verified";
  if (researchOk && buildOk) {
    return {
      passed: true,
      evidence: "Research lane verified and the build lane verified. The known unsafe-output failure did not occur on this run.",
    };
  }
  const blocker = input.buildBlocker ?? "";
  const unsafe = /unsafe model output/i.test(blocker);
  if (researchOk && unsafe) {
    return {
      passed: false,
      evidence: "MEASURED: research lane verified; build lane " + (input.buildStatus ?? "unknown")
        + " after " + String(input.buildAttempts) + " attempt(s) with Unsafe model output"
        + " (job " + (input.jobStatus ?? "unknown") + "). This is the known weak spot, recorded as a fail.",
    };
  }
  return {
    passed: false,
    evidence: "Build-lane measurement incomplete: research " + (input.researchVerdict ?? "missing")
      + ", build " + (input.buildStatus ?? "missing")
      + (blocker ? " (" + blocker.slice(0, 180) + ")" : "")
      + ", job " + (input.jobStatus ?? "missing") + ".",
  };
}

export interface DoNotStoreScoreInput {
  suppressionCreated: boolean;
  secretRefused: boolean;
  otherStored: boolean;
  secretPresent: boolean;
}

export function scoreDoNotStore(input: DoNotStoreScoreInput): { passed: boolean; evidence: string } {
  if (input.suppressionCreated && input.secretRefused && input.otherStored && !input.secretPresent) {
    return {
      passed: true,
      evidence: "The do-not-store instruction bound: MemoryStore.add refused the matching content and stored an unrelated fact. The refused content is not in the store.",
    };
  }
  const missing: string[] = [];
  if (!input.suppressionCreated) missing.push("no suppression was recorded from the instruction");
  if (!input.secretRefused) missing.push("the matching write was not refused");
  if (!input.otherStored) missing.push("an unrelated fact was not stored");
  if (input.secretPresent) missing.push("the refused content is present in the store");
  return { passed: false, evidence: "Memory do-not-store failed: " + missing.join("; ") + "." };
}

export interface ColdChatScoreInput {
  priorMessages: number;
  answer: string;
  durationMs: number;
  storedAnswer: string;
}

export function scoreColdChat(input: ColdChatScoreInput): { passed: boolean; evidence: string } {
  const cold = input.priorMessages === 0;
  const timed = Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs < 30_000;
  const right = input.answer === COLD_CHAT_ANSWER && input.storedAnswer === COLD_CHAT_ANSWER;
  if (cold && timed && right) {
    return {
      passed: true,
      evidence: "Cold chat (0 prior messages) answered \"" + COLD_CHAT_ANSWER + "\" in " + String(input.durationMs) + "ms. The stored reply is that answer alone.",
    };
  }
  const missing: string[] = [];
  if (!cold) missing.push("the chat was not cold (" + String(input.priorMessages) + " prior message(s))");
  if (!timed) missing.push("duration was not a timed simple-question bound (" + String(input.durationMs) + "ms)");
  if (input.answer !== COLD_CHAT_ANSWER) missing.push("the answer was not the plain expected answer");
  if (input.storedAnswer !== COLD_CHAT_ANSWER) missing.push("the stored reply was not the answer alone");
  return { passed: false, evidence: "Cold-chat question failed: " + missing.join("; ") + "." };
}

/** The harness answer for the fixed cold question. It knows that
 *  one question and nothing else, and it returns the answer with
 *  no reasoning text around it. */
export function answerColdQuestion(question: string): string {
  return question.trim() === COLD_CHAT_QUESTION ? COLD_CHAT_ANSWER : "";
}

function scratchCase<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "sam-task-battery-"));
  return fn(root).finally(() => { rmSync(root, { recursive: true, force: true }); });
}

async function runResearch(): Promise<TaskBatteryCaseResult> {
  const started = Date.now();
  const label = "Research job with citations";
  try {
    return await scratchCase(async root => {
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, RESEARCH_SOURCE), RESEARCH_FACT + "\n");
      const chats = new ChatStore(root);
      let chatId = "";
      try { chatId = chats.create("Battery research").id; } finally { chats.close(); }
      const userMessageId = "battery-research-ask";
      annotateToolResult(root, {
        chatId, userMessageId, actor: "sam",
        name: "sam_workspace_read",
        args: { path: RESEARCH_SOURCE },
        result: { path: RESEARCH_SOURCE, content: RESEARCH_FACT + "\n" },
      });
      const processed = processReplySources(root, {
        chatId, userMessageId, actor: "sam",
        text: RESEARCH_FACT + " [1].",
      });
      let laneVerdict = "";
      let laneResult = "";
      setOrchestrationRunnerForTests(async () => {
        const body = readFileSync(join(root, RESEARCH_SOURCE), "utf8");
        return RESEARCH_FACT + " per " + RESEARCH_SOURCE + " [1]. " + body.trim();
      });
      try {
        const { lanes } = await orchestrate(root, {
          profile: "sam",
          ask: "Battery research: when is the launch window? Cite the brief.",
          lanes: [{
            name: "brief",
            kind: "research",
            goal: "Read notes/brief.md and report the launch window with a citation.",
            doneLooksLike: "A sentence naming the window and citing notes/brief.md.",
            notDoneLooksLike: "A window with no source.",
            landsAt: "the job report",
          }],
        });
        laneVerdict = lanes[0]?.verdict ?? "";
        laneResult = lanes[0]?.result ?? "";
      } finally { setOrchestrationRunnerForTests(null); }
      const scored = scoreResearch({
        sourcesText: processed.text,
        cited: processed.sources.length,
        laneVerdict,
        laneResult,
      });
      return { id: "research-citations", label, passed: scored.passed, evidence: scored.evidence, durationMs: Date.now() - started, execution: "harness" };
    });
  } catch (error) {
    return { id: "research-citations", label, passed: false, evidence: "Research job threw: " + errorReason(error), durationMs: Date.now() - started, execution: "harness" };
  }
}

async function runMultiFile(): Promise<TaskBatteryCaseResult> {
  const started = Date.now();
  const label = "Multi-file coding job";
  try {
    return await scratchCase(async root => {
      const codeDir = mkdtempSync(join(tmpdir(), "sam-task-battery-code-"));
      try {
        setCodeRoot(root, codeDir);
        writeCodeFile(root, "sam", "alpha.ts", "export const alpha = 1;\n");
        writeCodeFile(root, "sam", "beta.ts", "export const beta = 2;\n");
        const gateBefore = verificationGate(root);
        recordVerification(root, { kind: "build", passed: true, runId: "battery-build" });
        recordVerification(root, { kind: "test", passed: true, runId: "battery-test" });
        const gateAfter = verificationGate(root);
        const writes = codeWrites(root).map(w => w.path);
        const alpha = readCodeFile(root, "alpha.ts");
        const beta = readCodeFile(root, "beta.ts");
        const scored = scoreMultiFile({
          files: writes,
          contentsMatch: alpha.content === "export const alpha = 1;\n" && beta.content === "export const beta = 2;\n",
          gateBefore: { closable: gateBefore.closable, state: gateBefore.state },
          gateAfter: { closable: gateAfter.closable, state: gateAfter.state },
        });
        return { id: "multi-file-coding", label, passed: scored.passed, evidence: scored.evidence, durationMs: Date.now() - started, execution: "harness" };
      } finally { rmSync(codeDir, { recursive: true, force: true }); }
    });
  } catch (error) {
    return { id: "multi-file-coding", label, passed: false, evidence: "Multi-file coding job threw: " + errorReason(error), durationMs: Date.now() - started, execution: "harness" };
  }
}

async function runBuildLane(): Promise<TaskBatteryCaseResult> {
  const started = Date.now();
  const label = "Orchestration job with a build lane";
  try {
    return await scratchCase(async root => {
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, RESEARCH_SOURCE), RESEARCH_FACT + "\n");
      setOrchestrationRunnerForTests(async (_root, lane) => {
        if (lane.kind === "build") throw new Error("Unsafe model output");
        return RESEARCH_FACT + " per " + RESEARCH_SOURCE + " [1].";
      });
      try {
        const { job, lanes } = await orchestrate(root, {
          profile: "sam",
          ask: "Battery orchestration: research the brief, then build the one-pager.",
          lanes: [
            {
              name: "brief",
              kind: "research",
              goal: "Report the launch window from notes/brief.md with a citation.",
              doneLooksLike: "A cited sentence naming the window.",
              notDoneLooksLike: "A window with no source.",
              landsAt: "the job report",
            },
            {
              name: "page",
              kind: "build",
              goal: "Write one-pager.md containing the launch window.",
              doneLooksLike: "one-pager.md exists and names Tuesday.",
              notDoneLooksLike: "A narrative with no file.",
              landsAt: "one-pager.md",
              verify: { artifact: "one-pager.md", mustMention: ["Tuesday"] },
            },
          ],
        });
        const research = lanes.find(l => l.name === "brief");
        const build = lanes.find(l => l.name === "page");
        const scored = scoreBuildLane({
          researchVerdict: research?.verdict ?? null,
          buildStatus: build?.status ?? null,
          buildVerdict: build?.verdict ?? null,
          buildBlocker: build?.blocker ?? null,
          buildAttempts: build?.attempts ?? 0,
          jobStatus: job.status,
        });
        return { id: "orchestration-build-lane", label, passed: scored.passed, evidence: scored.evidence, durationMs: Date.now() - started, execution: "harness" };
      } finally { setOrchestrationRunnerForTests(null); }
    });
  } catch (error) {
    setOrchestrationRunnerForTests(null);
    return { id: "orchestration-build-lane", label, passed: false, evidence: "Orchestration job threw: " + errorReason(error), durationMs: Date.now() - started, execution: "harness" };
  }
}

async function runDoNotStore(): Promise<TaskBatteryCaseResult> {
  const started = Date.now();
  const label = "Memory do-not-store";
  try {
    return await scratchCase(async root => {
      const created = captureSuppressionsFromText(root, "sam", DO_NOT_STORE_INSTRUCTION, "task-battery");
      const dbPath = join(root, ".sam", "missions.db");
      let secretRefused = false;
      let otherStored = false;
      let secretPresent = false;
      const store = new MemoryStore(dbPath);
      try {
        try {
          store.add({ kind: "observation", content: SUPPRESSED_FACT, source: "task-battery", scope: "core" });
        } catch (error) {
          secretRefused = error instanceof MemorySuppressedError;
        }
        const kept = store.add({ kind: "observation", content: KEPT_FACT, source: "task-battery", scope: "core" });
        otherStored = kept.content === KEPT_FACT;
        secretPresent = store.list(undefined, ["core"]).some(r => r.content.includes("harbor gate code"));
      } finally { store.close(); }
      const scored = scoreDoNotStore({
        suppressionCreated: created.length === 1,
        secretRefused,
        otherStored,
        secretPresent,
      });
      return { id: "memory-do-not-store", label, passed: scored.passed, evidence: scored.evidence, durationMs: Date.now() - started, execution: "harness" };
    });
  } catch (error) {
    return { id: "memory-do-not-store", label, passed: false, evidence: "Memory do-not-store threw: " + errorReason(error), durationMs: Date.now() - started, execution: "harness" };
  }
}

async function runColdChat(): Promise<TaskBatteryCaseResult> {
  const started = Date.now();
  const label = "Timed cold-chat simple question";
  try {
    return await scratchCase(async root => {
      const chats = new ChatStore(root);
      try {
        const chat = chats.create("Battery cold chat");
        const prior = chats.messages(chat.id).length;
        const t0 = Date.now();
        const answer = answerColdQuestion(COLD_CHAT_QUESTION);
        const durationMs = Date.now() - t0;
        chats.add(chat.id, "user", COLD_CHAT_QUESTION, "task-battery");
        chats.add(chat.id, "assistant", answer, "task-battery");
        const stored = chats.messages(chat.id).filter(m => m.role === "assistant").map(m => m.content);
        const scored = scoreColdChat({
          priorMessages: prior,
          answer,
          durationMs,
          storedAnswer: stored.length === 1 ? stored[0] : stored.join("\n"),
        });
        return { id: "cold-chat-simple", label, passed: scored.passed, evidence: scored.evidence, durationMs: Date.now() - started, execution: "harness" };
      } finally { chats.close(); }
    });
  } catch (error) {
    return { id: "cold-chat-simple", label, passed: false, evidence: "Cold chat threw: " + errorReason(error), durationMs: Date.now() - started, execution: "harness" };
  }
}

const CASE_RUNNERS: Array<() => Promise<TaskBatteryCaseResult>> = [
  runResearch, runMultiFile, runBuildLane, runDoNotStore, runColdChat,
];

function liveNote(liveRun: TaskBatteryLiveRun): string {
  if (liveRun === "pending-keys") return "Live model run pending Dip's keys: --live was set and no model key is configured. No request was sent. The rows below are the offline harness, and a missing key is not a pass.";
  if (liveRun === "pending-ruling") return "A model key is configured, but this battery does not place external requests. The live run is withheld pending Dip's ruling. No request was sent. The rows below are the offline harness.";
  return "Live model run was not requested. This scorecard is the offline harness on a scratch home. A live run is pending Dip's keys. No request was sent.";
}

export function resolveLiveRun(live: boolean, env: NodeJS.ProcessEnv = process.env): TaskBatteryLiveRun {
  if (!live) return "not-requested";
  return modelApiKey(env) ? "pending-ruling" : "pending-keys";
}

let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Run the fixed battery. Cases use scratch directories. `root`
 *  is only the scorecard home. */
export async function runTaskBattery(root: string, opts: { live?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<TaskBatteryRun> {
  return exclusive(async () => {
    const liveRun = resolveLiveRun(opts.live === true, opts.env ?? process.env);
    const cases: TaskBatteryCaseResult[] = [];
    for (const run of CASE_RUNNERS) cases.push(await run());
    const passed = cases.filter(c => c.passed).length;
    const run: TaskBatteryRun = {
      version: TASK_BATTERY_VERSION,
      at: new Date().toISOString(),
      execution: "harness",
      liveRun,
      overall: { passed, total: cases.length },
      cases,
      note: liveNote(liveRun),
    };
    recordTaskBattery(root, run);
    const findings = cases.filter(c => !c.passed).length;
    recordActivity(root, "sam", "task-battery", taskBatteryLedgerSummary(run.version, passed, cases.length, liveRun, findings));
    return run;
  });
}

/** The ONE writer for the task battery's activity line, so
 *  the scorecard's parser below can never drift from the seam
 *  it counts. Its shape is byte-identical to what
 *  runTaskBattery wrote inline before this writer existed:
 *  the battery version, the passed/total counts, the live
 *  state, and the finding count - never a case label or any
 *  evidence, which can carry the owner's words. */
export function taskBatteryLedgerSummary(version: string, passed: number, total: number, liveRun: TaskBatteryLiveRun, findings: number): string {
  return "Task battery " + version + " recorded: " + String(passed) + "/" + String(total) + " passed, live " + liveRun + ", " + String(findings) + " finding(s)";
}

const TASK_BATTERY_LIVE_RUNS: TaskBatteryLiveRun[] = ["not-requested", "pending-keys", "pending-ruling"];

/** Parse one task-battery ledger summary. Only the fixed
 *  shape parses: a single non-space version token, a sane
 *  passed/total pair, a live state from the fixed vocabulary,
 *  and a finding count equal to total-passed - the seam
 *  computes findings as the failed-case count, so a line
 *  breaking that equality is not a shape the seam writes.
 *  Anything else returns null, so a drifted shape counts as
 *  unparseable instead of being silently miscounted. */
export function parseTaskBatterySummary(summary: string): { version: string; passed: number; total: number; liveRun: TaskBatteryLiveRun; findings: number } | null {
  const m = /^Task battery (\S+) recorded: (\d+)\/(\d+) passed, live (not-requested|pending-keys|pending-ruling), (\d+) finding\(s\)$/.exec(summary);
  if (!m) return null;
  const passed = Number(m[2]);
  const total = Number(m[3]);
  const findings = Number(m[5]);
  if (total < 1 || passed > total) return null;
  if (findings !== total - passed) return null;
  return { version: m[1] ?? "", passed, total, liveRun: m[4] as TaskBatteryLiveRun, findings };
}

/** The task battery history scorecard (2026-11-20, the
 *  measured-proof series): every recorded run has ledgered
 *  as a "task-battery" line since the battery landed, but
 *  the class was never folded - it was written inline at its
 *  only seam, with no ONE writer and no reader, so how many
 *  runs ever recorded, how their scores and live states
 *  split, and whether the battery ever passed clean was
 *  invisible as a trend (the battery's own surfaces execute
 *  a run or read the last stored scorecard per version;
 *  neither trends the history - the eval battery's history
 *  fold is the sibling this one was left behind by). A run
 *  that fell short is the battery naming a real job Sam
 *  cannot yet do, so the verdict is attention only when any
 *  finding was ever recorded, any run fell short of a full
 *  pass, or a line is unparseable, else clear. This text
 *  folds the class to counts only, on ONE line: the parsed
 *  run count, the summed findings, the latest passed/total,
 *  counts per fixed live bucket, the distinct-version count
 *  as a number only, and the total. No stamp, no actor, no
 *  version string, no case label, no evidence, and no
 *  verbatim summary enters the text. A pure read: it creates
 *  nothing, runs no battery case, and spends no model call -
 *  runTaskBattery itself is untouched apart from riding the
 *  ONE writer. */
export function taskBatteryHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "task-battery" });
  let runs = 0;
  let findings = 0;
  let latestPassed = 0;
  let latestTotal = 0;
  let short = 0;
  let unparseable = 0;
  const live = new Map<string, number>();
  const versions = new Set<string>();
  for (const line of lines) {
    const parsed = parseTaskBatterySummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    runs += 1;
    findings += parsed.findings;
    latestPassed = parsed.passed;
    latestTotal = parsed.total;
    if (parsed.passed < parsed.total) short += 1;
    live.set(parsed.liveRun, (live.get(parsed.liveRun) ?? 0) + 1);
    versions.add(parsed.version);
  }
  const parts: string[] = [];
  parts.push("Task battery history: " + (findings > 0 || short > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(runs) + " runs");
  parts.push(String(findings) + " findings");
  parts.push("latest " + String(latestPassed) + "/" + String(latestTotal) + " passed");
  for (const state of TASK_BATTERY_LIVE_RUNS) parts.push(state + " " + String(live.get(state) ?? 0));
  parts.push(String(versions.size) + " versions");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

export const TASK_BATTERY_SCRIPT = "sam-task-battery";

/** The battery as plain text (the sam-task-battery script job's
 *  stdout shape): the scorecard a person reads. The text
 *  deliberately carries NO clock or duration reading - not the
 *  run's stamp, not a case's durationMs, and not the cold-chat
 *  evidence's own measured milliseconds: a script job's stdout
 *  is P3-diffed on its facts, and a fresh stamp or duration is
 *  a new date/number fact every run, so a timed scorecard
 *  would announce "changed" daily at an identical score (the
 *  stack-watch false-change class, and the eval battery's
 *  2026-11-17 fix mirrored). The recorded record
 *  (readTaskBattery / battery show) keeps the stamp and every
 *  duration; the text keeps the per-case pass/fail and
 *  evidence, which are the facts a reader and the diff judge. */
export function taskBatteryText(run: TaskBatteryRun): string {
  const lines = [
    "Task battery " + run.version + " - " + String(run.overall.passed) + "/" + String(run.overall.total) + " passed - " + run.execution + " - live: " + run.liveRun,
  ];
  for (const c of run.cases) {
    const evidence = c.evidence.replace(/in \d+ms\b/, "within the timed bound");
    lines.push("- " + c.id + ": " + (c.passed ? "PASS" : "FAIL") + " - " + evidence);
  }
  lines.push("", run.note);
  return lines.join("\n");
}

// Failure visibility (gap found 2026-11-15, hourly run
// 08:04 EST): the task battery arrived with the Grok Sprint 4
// merge train AFTER the store census closed, and its store is
// the one new store that train brought in unguarded. Every
// touch opened .sam/task-battery.db raw: openStore (mkdir,
// symlink check, schema creation) plus recordTaskBattery (the
// scorecard INSERT every `sam battery run` ends with) and
// listTaskBatteryRuns / readTaskBattery (the `battery show`
// and `battery versions` CLI doors). A dead store threw with
// the seam unnamed, and any reader folding it as "no runs"
// would silently empty the battery's whole score history
// dressed as a version that never ran - in the store that
// exists to prove "Sam got better" is a number. Now the
// touches own their failure (the census precedent): a failed
// touch ledgers ONE task-battery-failed line (openStore plus
// the insert at phase write, because the open performs the
// schema writes; the list/read at phase read; actor sam; the
// verbatim reason collapsed and capped; never any scorecard
// record - case evidence can carry the owner's words), tags
// the error, and rethrows exactly, so every caller's handling
// is unchanged and reads still fail closed. A touch already
// ledgered by an inner door (read rides list) gains no
// second line. An absent store still reads as no runs,
// creating nothing, and torn rows still parse forgiving.
export type TaskBatteryPhase = "read" | "write";

export function taskBatteryFailureSummary(phase: TaskBatteryPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Task battery store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a task-battery-failed line carries (census sprint
 * 2026-11-17): recordTaskBatteryFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function taskBatteryFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordTaskBatteryFailure(root: string, phase: TaskBatteryPhase, error: unknown): void {
  const reason = taskBatteryFailureReason(error);
  recordActivity(root, "sam", "task-battery-failed", taskBatteryFailureSummary(phase, reason));
}

function tagTaskBatteryLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { taskBatteryLedgered?: boolean }).taskBatteryLedgered = true;
  }
}

export function isTaskBatteryLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { taskBatteryLedgered?: boolean }).taskBatteryLedgered === true;
}

function failTaskBattery(root: string, phase: TaskBatteryPhase, error: unknown): never {
  if (!isTaskBatteryLedgered(error)) recordTaskBatteryFailure(root, phase, error);
  tagTaskBatteryLedgered(error);
  throw error;
}

function batteryTouch<T>(root: string, phase: TaskBatteryPhase, fn: () => T): T {
  try { return fn(); }
  catch (error) { failTaskBattery(resolve(root), phase, error); }
}

function batteryDbPath(root: string): string { return join(resolve(root), ".sam", "task-battery.db"); }

function parseRun(data: unknown): TaskBatteryRun | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<TaskBatteryRun>;
  if (typeof value.version !== "string" || !value.version) return null;
  if (typeof value.at !== "string" || !value.at) return null;
  if (value.execution !== "harness") return null;
  if (value.liveRun !== "not-requested" && value.liveRun !== "pending-keys" && value.liveRun !== "pending-ruling") return null;
  if (!value.overall || typeof value.overall.passed !== "number" || typeof value.overall.total !== "number") return null;
  if (!Array.isArray(value.cases) || typeof value.note !== "string") return null;
  return value as TaskBatteryRun;
}

function openStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(batteryDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS task_battery (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL)");
  return db;
}

/** Append one run. Versions are not overwritten: a new version is
 *  a new row, and a repeat of the same version is another row. */
export function recordTaskBattery(root: string, run: TaskBatteryRun): void {
  batteryTouch(root, "write", () => {
    const db = openStore(root);
    try {
      db.prepare("INSERT INTO task_battery (version, at, data) VALUES (?, ?, ?)").run(run.version, run.at, JSON.stringify(run));
    } finally { db.close(); }
  });
}

export function listTaskBatteryRuns(root: string, version?: string): TaskBatteryRun[] {
  if (!existsSync(batteryDbPath(root))) return [];
  return batteryTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const rows = (version
        ? db.prepare("SELECT data FROM task_battery WHERE version = ? ORDER BY id").all(version)
        : db.prepare("SELECT data FROM task_battery ORDER BY id").all()) as Array<{ data: string }>;
      const runs: TaskBatteryRun[] = [];
      for (const row of rows) {
        try {
          const parsed = parseRun(JSON.parse(row.data));
          if (parsed) runs.push(parsed);
        } catch { /* a torn row is skipped, never fatal */ }
      }
      return runs;
    } finally { db.close(); }
  });
}

/** The newest stored run for a version, or null when that version
 *  has never been recorded. A read on an install with no store
 *  creates nothing. */
export function readTaskBattery(root: string, version: string = TASK_BATTERY_VERSION): TaskBatteryRun | null {
  const runs = listTaskBatteryRuns(root, version);
  return runs.length ? runs[runs.length - 1] : null;
}

/** Lane shape the build scorer reads. Exported so a test can show
 *  the scorer's pass path without pretending the harness saw it. */
export type BuildLaneFields = Pick<Lane, "verdict" | "status" | "blocker" | "attempts">;

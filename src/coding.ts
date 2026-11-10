import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { codeRoot, codeWrites, type CodeWriteRecord } from "./code.js";
import { commitTaskPaths, prepareTaskBranch, type CodingGitState } from "./git-work.js";
import { listChanges, verificationStatus } from "./verification.js";
import type { GoldfishRecord } from "./goldfish.js";

/**
 * The coding loop (Phase D item 3, Dip's coder program C3, ordered
 * after C1/C2 hands and riding the harness verify-on-stop ledger).
 *
 * C1/C2 gave SAM hands inside one turn; nothing carried a coding
 * task across iterations, and a turn could claim done over
 * unverified writes with nothing contradicting it. This loop is
 * the carrier: a coding task is queued from a chat (sam_coding_task)
 * or the CLI, drained by the heartbeat tick on the deep background
 * route, and each iteration is a real turn in the task's own chat
 * instructed to plan, edit through sam_code, run build + test, and
 * treat a failure as data for the next iteration - not as a stop.
 *
 * The loop never grades its own work: after every turn it reads
 * the verify-on-stop ledger (verification.ts). The task closes
 * DONE only when the changes it made are verified (a fresh build
 * AND test pass after the last change) - or when it made no
 * changes at all, which the summary says plainly. Failed or
 * unverified work feeds the next iteration's prompt, naming
 * exactly what is missing; exhausting the iteration cap closes
 * the task BLOCKED, never done, with the state named. The close
 * posts one summary into the chat - outcome, iterations,
 * verification state, and every write's diff from the C1 ledger -
 * so the owner reads the whole result where they asked for it.
 *
 * Self-review (Phase D item 4, coder C5): verification alone no
 * longer closes a task with changes. Once an iteration verifies,
 * the goldfish verifier (goldfish.ts - fresh context: spec + diff
 * + Pattern Catalog, no conversation history) reviews the task's
 * diff. A PASS closes done; a BLOCK is data like a failed test -
 * its findings ride the next iteration's prompt - and exhausting
 * the cap under a block closes BLOCKED. A review that cannot run
 * at all (no catalog, moved-on source, reviewer unconfigured)
 * also closes BLOCKED, never done: unreviewed work is not done.
 * The production drains (heartbeat tick, coding drain CLI) always
 * wire the real reviewer; a drain wired without one is a test or
 * an operator's explicit local run, and the task record says
 * which through its review field.
 *
 * Git discipline (Phase D item 5, coder C4): when the code root
 * is a git repository, a task works on a sam/<task> branch made
 * for it alone (git-work.ts) - a tree dirty before the task
 * starts refuses and the task closes blocked, because SAM never
 * sweeps the owner's uncommitted work into its branch. After
 * each iteration the loop commits exactly that iteration's C1
 * writes locally on the task branch; a task whose writes are not
 * all committed cannot close done. A non-git code root records
 * mode "none" and behaves exactly as before. Push stays a
 * separate owner-approved act (the ONE gate's git-push kind);
 * this loop never pushes and never opens a PR.
 *
 * Fences kept: the code root is the operator's designation (a task
 * cannot queue without one, and the loop can never move it), all
 * writes ride C1's confined hands, and all verify runs ride C2's
 * allowlist - the chat git commands stay read-only.
 */

export type CodingStatus = "queued" | "running" | "done" | "blocked" | "failed";
export interface CodingChange { path: string; created: boolean; addedLines: number; removedLines: number }
export interface CodingTask {
  id: string; actor: string; chatId: string; spec: string; title: string;
  status: CodingStatus; iterations: number; maxIterations: number;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  result: string | null; verification: string | null; changes: CodingChange[];
  /** C5 self-review outcome: "PASS: <summary>", "BLOCK: <summary>",
   *  "unavailable: <reason>", or null (no review ran - a task with
   *  no changes, or a drain wired without a reviewer). Legacy
   *  records predate the field and read as undefined. */
  review?: string | null;
  /** C4 git discipline state: the task's sam/<task> branch, its
   *  local commits, and any write paths not yet committed. Legacy
   *  records predate the field and read as undefined. */
  git?: CodingGitState | null;
}
const MAX_OPEN = 10;
const MAX_ITERATIONS_CAP = 5;
const DEFAULT_MAX_ITERATIONS = 3;
const STALE_RUNNING_MS = 60 * 60000;
const SUMMARY_DIFF_BUDGET = 6_000;

function codingFile(root: string): string { return join(resolve(root), ".sam", "coding.json"); }

export function listCodingTasks(root: string): CodingTask[] {
  const file = codingFile(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? data as CodingTask[] : []; }
  catch { return []; }
}

function saveTasks(root: string, items: CodingTask[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(codingFile(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}

export function codingSummary(root: string): { root: string | null; queued: number; running: number; done: number; blocked: number; failed: number; recent: CodingTask[] } {
  const items = listCodingTasks(root);
  const count = (s: CodingStatus) => items.filter(t => t.status === s).length;
  return { root: codeRoot(root), queued: count("queued"), running: count("running"), done: count("done"), blocked: count("blocked"), failed: count("failed"), recent: items.slice(-10) };
}

export function queueCodingTask(root: string, input: { actor: string; chatId: string; spec: string; maxIterations?: number }): CodingTask {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const spec = (input.spec ?? "").trim();
  if (!spec || spec.length > 4000) throw new Error("Invalid coding spec");
  if (!input.chatId) throw new Error("A chat is required");
  if (!codeRoot(root)) throw new Error("No code root is designated on this install, so there is nowhere for a coding task to work. The operator designates one with: sam code set-root <path>.");
  const db = new ChatStore(root);
  try { db.messages(input.chatId); } finally { db.close(); }
  const items = listCodingTasks(root);
  if (items.filter(t => t.status === "queued" || t.status === "running").length >= MAX_OPEN) throw new Error("Coding queue is full");
  const maxIterations = Math.max(1, Math.min(MAX_ITERATIONS_CAP, Math.floor(input.maxIterations ?? DEFAULT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS));
  const item: CodingTask = {
    id: randomUUID(), actor: input.actor, chatId: input.chatId, spec,
    title: spec.slice(0, 120), status: "queued", iterations: 0, maxIterations,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    result: null, verification: null, changes: [], review: null, git: null,
  };
  items.push(item); saveTasks(root, items);
  recordActivity(root, input.actor, "coding-queued", "Queued coding task: " + item.title);
  return item;
}

/** The instruction one iteration runs under. Iteration 1 plans and
 *  makes the first pass; later iterations are continuations that
 *  carry the ledger's verdict - the failure is the input, named
 *  exactly, never a vague "try again". */
export function codingPrompt(task: CodingTask, iteration: number, verdict: { state: string; pending: string[]; note?: string } | null): string {
  const head = iteration === 1
    ? "You are running a coding task in the background (iteration 1 of " + task.maxIterations + "). Work in the designated code root with your sam_code tool."
    : "You are continuing a coding task in the background (iteration " + iteration + " of " + task.maxIterations + "). The previous iteration did not close the work: the verification ledger reads \"" + (verdict?.state ?? "unverified") + "\"" + (verdict?.pending.length ? " with unverified changes in: " + verdict.pending.join(", ") : "") + (verdict?.note ? ". " + verdict.note : "") + ". A failed or missing verification - or a blocking review - is data, not a stop: read the failing build/test output or the reviewer's findings, fix the cause in the code root with sam_code, and run build and test again.";
  return head + "\n\nTask: " + task.spec + "\n\nHow to work: plan briefly, then make the change with sam_code write/edit. After writing, run the code root's build and test commands (sam_code action run, commands build and test). If either fails, read the output, fix the code, and run them again inside this same turn when you can. The work only counts as done when a fresh build and a fresh test both pass after your last change - never claim done over unverified writes. Verified work is then reviewed by a fresh-context reviewer who sees only the task, your diff, and the fleet Pattern Catalog (never this conversation): a block sends the work back with its findings, so write changes you could defend to a skeptical reviewer who was not here. You do not run git yourself: when the code root is a git repository, the loop works on a sam/<task> branch made for this task and commits your writes locally after each iteration. Never push or open pull requests - pushing the task branch is an owner-approved proposal, and your chat git commands (git-status, git-diff, git-log) stay read-only.";
}

function postToChat(root: string, chatId: string, text: string): void {
  try { const db = new ChatStore(root); try { db.add(chatId, "assistant", text); } finally { db.close(); } } catch { /* chat gone; the task record and ledger stand */ }
}

/** The closing summary: outcome first, then the evidence - the
 *  iteration count, the ledger's verdict, and every write this
 *  task made with its diff read back from the C1 ledger. */
export function codingSummaryText(task: CodingTask, writes: CodeWriteRecord[]): string {
  const outcome = task.status === "done"
    ? (task.changes.length ? "Coding task done: " + task.title : "Coding task closed with no changes: " + task.title)
    : task.status === "blocked"
      ? "Coding task blocked (not done): " + task.title
      : "Coding task failed: " + task.title;
  const lines = [outcome, "Iterations: " + task.iterations + " of " + task.maxIterations + ". Verification: " + (task.verification ?? "unknown") + "."];
  if (task.git?.mode === "branch") {
    lines.push("Git: branch " + task.git.branch + ", " + task.git.commits.length + " local commit(s)" + (task.git.commits.length ? " (" + task.git.commits.map(c => c.sha.slice(0, 8)).join(", ") + ")" : "") + " - not pushed; pushing the branch is an owner-approved git-push proposal." + (task.git.pending.length ? " Not yet committed: " + task.git.pending.join(", ") + "." : ""));
  } else if (task.git?.mode === "none") {
    lines.push("Git: the code root is not a git repository, so this work has no branch or commits.");
  } else if (task.git?.mode === "refused") {
    lines.push("Git: refused - " + (task.git.error ?? "the loop would not touch the code root's git state"));
  }
  if (task.review) lines.push("Self-review: " + task.review + ".");
  if (task.result) lines.push(task.result);
  if (writes.length) {
    lines.push("Changes (" + writes.length + "):");
    let budget = SUMMARY_DIFF_BUDGET;
    for (const w of writes) {
      const head = "- " + w.path + " (" + (w.created ? "created, " : "") + "+" + w.addedLines + "/-" + w.removedLines + ")";
      if (budget <= 0) { lines.push(head + " (diff omitted - read it back with: sam code writes)"); continue; }
      const diff = w.diff.slice(0, budget);
      budget -= diff.length;
      lines.push(head + "\n" + diff);
    }
  } else if (task.changes.length) {
    lines.push("Changes: " + task.changes.map(c => c.path).join(", "));
  }
  return lines.join("\n").slice(0, 12_000);
}

const draining = new Set<string>();
export interface CodingDrainDeps {
  runTurn: (chatId: string, content: string) => Promise<string>;
  maxPerDrain?: number;
  /** C5 self-review: the goldfish pass over a verified task's diff.
   *  The production drains always wire it (defaultCodingReviewer,
   *  or a refusing stub when no model is configured); a drain
   *  without it closes on verification alone, and the task's
   *  review field stays null saying so. */
  review?: (task: CodingTask) => Promise<GoldfishRecord>;
}

export async function drainCodingTasks(root: string, deps: CodingDrainDeps): Promise<{ ran: string[]; blocked: string[]; failed: string[]; recovered: string[] }> {
  const key = resolve(root);
  if (draining.has(key)) return { ran: [], blocked: [], failed: [], recovered: [] };
  draining.add(key);
  const ran: string[] = []; const blocked: string[] = []; const failed: string[] = []; const recovered: string[] = [];
  try {
    // Recover first, on the background pattern: a task still marked
    // running long past any plausible loop means its runner died.
    const items = listCodingTasks(root);
    const now = Date.now(); let dirty = false;
    for (const t of items) {
      if (t.status === "running" && t.startedAt && now - Date.parse(t.startedAt) > STALE_RUNNING_MS) {
        t.status = "failed"; t.finishedAt = new Date().toISOString(); t.result = "Runner stopped mid-task; marked failed by the next drain.";
        recovered.push(t.id); dirty = true;
        recordActivity(root, t.actor, "coding-failed", "Coding task died mid-run: " + t.title);
      }
    }
    if (dirty) saveTasks(root, items);
    const limit = deps.maxPerDrain ?? 2;
    const queued = listCodingTasks(root).filter(t => t.status === "queued").slice(0, limit);
    for (const task of queued) {
      const live = listCodingTasks(root); const current = live.find(t => t.id === task.id);
      if (!current || current.status !== "queued") continue;
      current.status = "running"; current.startedAt = new Date().toISOString(); saveTasks(root, live);
      recordActivity(root, current.actor, "coding-started", "Coding task started: " + current.title);
      // C4 git discipline: the task's branch is prepared before the
      // first turn. A refusal (a dirty tree, an unborn HEAD) closes
      // the task blocked without running a turn - SAM never sweeps
      // the owner's uncommitted work into its branch.
      let gitState: CodingGitState | null = null;
      try { gitState = prepareTaskBranch(root, current); }
      catch (e) { gitState = { mode: "refused", branch: null, baseSha: null, commits: [], pending: [], error: e instanceof Error ? e.message : "Git preparation failed" }; }
      current.git = gitState;
      { const mid = listCodingTasks(root); const m = mid.find(t => t.id === task.id); if (m) { m.git = gitState; saveTasks(root, mid); } }
      if (gitState.mode === "refused") {
        const after = listCodingTasks(root); const done = after.find(t => t.id === task.id);
        if (done) {
          done.status = "blocked"; done.git = gitState; done.verification = verificationStatus(root).state;
          done.finishedAt = new Date().toISOString(); done.result = gitState.error;
          saveTasks(root, after);
          postToChat(root, current.chatId, codingSummaryText(done, []));
        }
        blocked.push(task.id);
        recordActivity(root, current.actor, "coding-blocked", "Coding task blocked (git discipline): " + current.title);
        continue;
      }
      const writesBefore = codeWrites(root, 100_000).length;
      const changesBefore = listChanges(root).length;
      let verdict: { state: string; pending: string[]; note?: string } | null = null;
      let lastReply = "";
      let turnFailed: string | null = null;
      let reviewOutcome: string | null = null;
      let reviewUnavailable: string | null = null;
      try {
        for (let iteration = 1; iteration <= current.maxIterations; iteration++) {
          current.iterations = iteration;
          const mid = listCodingTasks(root); const m = mid.find(t => t.id === task.id); if (m) { m.iterations = iteration; saveTasks(root, mid); }
          const writesBeforeIter = codeWrites(root, 100_000).length;
          lastReply = await deps.runTurn(current.chatId, codingPrompt(current, iteration, verdict));
          // C4: commit this iteration's writes locally on the task
          // branch, as the loop works - exactly those paths, staged
          // by name. A commit failure is recorded on the task and
          // the pending paths stay pending; the close below will
          // not call uncommitted work done.
          if (gitState?.mode === "branch") {
            const newPaths = [...new Set(codeWrites(root, 100_000).slice(writesBeforeIter).map(w => w.path))];
            for (const p of newPaths) if (!gitState.pending.includes(p)) gitState.pending.push(p);
            if (gitState.pending.length) {
              try { commitTaskPaths(root, gitState, [...gitState.pending], iteration, current.title); gitState.error = null; }
              catch (e) { gitState.error = e instanceof Error ? e.message : "git commit failed"; }
              const mid2 = listCodingTasks(root); const m2 = mid2.find(t => t.id === task.id); if (m2) { m2.git = gitState; saveTasks(root, mid2); }
            }
          }
          const status = verificationStatus(root);
          const changesDuring = listChanges(root).length - changesBefore;
          verdict = { state: status.state, pending: status.pendingChanges.map(c => c.path) };
          if (changesDuring > 0 && status.state === "verified" && deps.review) {
            // C5: verified is necessary, not sufficient. The goldfish
            // reviews the diff in fresh context before this can close.
            try {
              const record = await deps.review(current);
              reviewOutcome = record.verdict + ": " + record.summary;
              const blockers = record.findings.filter(f => f.severity === "BLOCKER").map(f => (f.patternId ? "[" + f.patternId + "] " : "") + f.detail).join("; ");
              recordActivity(root, current.actor, "coding-review", "Self-review " + record.verdict + " for coding task: " + current.title + (blockers ? " - " + blockers.slice(0, 160) : ""));
              if (record.verdict === "PASS") break;
              verdict = { state: "verified", pending: [], note: "A fresh-context reviewer BLOCKED the verified diff: " + record.summary + (blockers ? " Blockers: " + blockers : "") + " Fix what the findings name; the next review covers the new changes." };
              continue; // a block is data: the next iteration gets the findings
            } catch (e) {
              const message = e instanceof Error ? e.message : "Self-review failed";
              // A standing BLOCK with no new changes to review is
              // still a block, not an infrastructure failure.
              if (reviewOutcome?.startsWith("BLOCK") && /No unreviewed changes/.test(message)) break;
              reviewUnavailable = message;
              break;
            }
          }
          if (changesDuring > 0 && status.state === "verified") break;
          if (changesDuring === 0 && status.state !== "failed") break; // nothing changed and nothing failed: the turn's answer stands
          // failed or unverified with changes on the table: the next
          // iteration gets the verdict as its input.
        }
      } catch (e) {
        turnFailed = e instanceof Error ? e.message : "Coding run failed";
      }
      const after = listCodingTasks(root); const done = after.find(t => t.id === task.id);
      if (!done) continue;
      const writes = codeWrites(root, 100_000).slice(writesBefore);
      done.changes = writes.map(w => ({ path: w.path, created: w.created, addedLines: w.addedLines, removedLines: w.removedLines }));
      const status = verificationStatus(root);
      done.verification = status.state;
      done.review = reviewUnavailable ? "unavailable: " + reviewUnavailable.slice(0, 240) : reviewOutcome;
      done.git = gitState;
      done.finishedAt = new Date().toISOString();
      const reviewGateOk = !deps.review || reviewOutcome?.startsWith("PASS") === true;
      const gitPending = gitState?.mode === "branch" ? gitState.pending : [];
      if (turnFailed) {
        done.status = "failed"; done.result = turnFailed.slice(0, 300);
        failed.push(task.id);
        recordActivity(root, current.actor, "coding-failed", "Coding task failed: " + current.title + " - " + turnFailed.slice(0, 120));
      } else if (done.changes.length > 0 && status.state === "verified" && !reviewUnavailable && reviewGateOk && gitPending.length === 0) {
        done.status = "done"; done.result = lastReply.slice(0, 300);
        ran.push(task.id);
        recordActivity(root, current.actor, "coding-done", "Coding task done and verified: " + current.title + " (" + done.changes.length + " file(s), " + done.iterations + " iteration(s))");
      } else if (done.changes.length === 0) {
        done.status = "done"; done.result = "No code changes were made; there was nothing to verify. " + lastReply.slice(0, 240);
        ran.push(task.id);
        recordActivity(root, current.actor, "coding-done", "Coding task closed with no changes: " + current.title);
      } else if (reviewUnavailable) {
        done.status = "blocked"; done.result = "The work verified, but the fresh-context self-review could not run (" + reviewUnavailable.slice(0, 200) + ") - unreviewed work is not done. Fix the review door (catalog, reviewer configuration, live source) and re-queue the task.";
        blocked.push(task.id);
        recordActivity(root, current.actor, "coding-blocked", "Coding task blocked (self-review unavailable): " + current.title);
      } else if (deps.review && status.state === "verified" && !reviewGateOk) {
        done.status = "blocked"; done.result = "Iterations exhausted under a fresh-context review BLOCK (" + (reviewOutcome ?? "no verdict").slice(0, 240) + ") - the changes are verified but the reviewer would not pass them, so this is not done. " + lastReply.slice(0, 160);
        blocked.push(task.id);
        recordActivity(root, current.actor, "coding-blocked", "Coding task blocked (review BLOCK): " + current.title);
      } else if (gitState?.mode === "branch" && gitPending.length > 0) {
        done.status = "blocked"; done.result = "The work is " + status.state + " but git discipline is incomplete: " + gitPending.length + " file(s) are not committed on " + gitState.branch + " (" + gitPending.join(", ") + ")" + (gitState.error ? " - " + gitState.error.slice(0, 200) : "") + ". Uncommitted work is not done; fix the cause and re-queue the task.";
        blocked.push(task.id);
        recordActivity(root, current.actor, "coding-blocked", "Coding task blocked (uncommitted writes): " + current.title);
      } else {
        done.status = "blocked"; done.result = "Iterations exhausted with the work " + status.state + " - the changes are in the code root but are NOT verified, so this is not done. " + lastReply.slice(0, 200);
        blocked.push(task.id);
        recordActivity(root, current.actor, "coding-blocked", "Coding task blocked (" + status.state + "): " + current.title);
      }
      saveTasks(root, after);
      postToChat(root, current.chatId, codingSummaryText(done, writes));
    }
    return { ran, blocked, failed, recovered };
  } finally { draining.delete(key); }
}

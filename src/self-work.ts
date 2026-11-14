import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { listActions, proposeAction } from "./actions.js";
import { readActivity, recordActivity, type ActivityLine } from "./activity.js";
import { channels } from "./channels.js";
import { ChatStore } from "./chats.js";
import { codeRoot } from "./code.js";
import { getCodingTask, listCodingTasks, queueCodingTask, type CodingTask } from "./coding.js";
import { addScheduledJob, heartbeatJobs, type HeartbeatJob } from "./heartbeat.js";
import { readSelfAudit, type SelfAudit } from "./self-audit.js";

/**
 * The self-work spec picker (SELF-WORK program, Dip 2026-11-11,
 * step 1): the standing loop's first act. Step 0 gave SAM a true
 * map of himself (the capability self-audit); this module reads
 * SAM's own activity ledger as a defect queue, ranks the failure
 * classes SAM already ledgers, and writes ONE three-part spec
 * (end goal / done looks like / not-done - the fleet spec shape)
 * for the top recurring defect, grounded in that recorded map.
 *
 * - DETERMINISTIC: the ranking and the spec are assembled in
 *   code from the ledger (the brief / curator precedent). No
 *   model call, no model opinion about what is broken: a class
 *   ranks by how many times it actually happened (ties break to
 *   the most recently seen, then the class key, so the pick is
 *   reproducible from the same ledger).
 * - GROUNDED IN THE AUDIT: the pick reads the recorded
 *   self-audit. A spec whose fix needs coder hands while the
 *   audit records no designated code root is stamped blockedBy
 *   naming that cannot - it is recorded honestly, never dressed
 *   as workable, and a later step may not queue it until the
 *   audit reads ready.
 * - THE HARD BOUNDARY BINDS THE PICKER: a spec whose likely
 *   files touch SAM's own gate, policy, or allowlist code is
 *   stamped ownerOnly - recorded for the owner, never queued
 *   for SAM's own hands in a later step (self-work on the
 *   approval machinery is owner-only, forever).
 * - SPECS ONLY: this step fixes nothing, queues no coding task,
 *   and sends nothing. The coding-task fix, the gated landing,
 *   and the per-fix digest line are the loop's later steps.
 * - RECORDED: a run persists to SQLite (.sam/self-work.db, the
 *   singleton pattern - ONE row holding the latest run's full
 *   JSON) and ledgers one self-work line carrying counts only.
 *   A pure read creates nothing. Delivery of the run's text
 *   rides Phase C exactly: "sam-self-work" is one entry on the
 *   script-job allowlist, and `self-work install` creates the
 *   standing job (default daily at 6am America/New_York, the
 *   operator names the channel - e.g. the SAM Telegram channel
 *   Dip designated for self-work updates - or none).
 *
 * Stable spec identity: a run whose top defect class is
 * unchanged from the previous recorded run's spec (same key,
 * same count, same last sighting) REUSES that spec's id instead
 * of minting a fresh one. Without this, the step-2 guard "a
 * spec is worked once" could never bind across runs - every
 * daily run would re-spec the identical class under a new id
 * and the bridge would treat it as new work. Growth mints a
 * fresh id: a class that recurs past its specced count (or a
 * different class topping the queue) is speccable again,
 * exactly once more. Only the id is reused - every other spec
 * field is rebuilt fresh, so a block that has since cleared
 * (a code root designated after the spec was stamped blocked)
 * unblocks the same spec instead of freezing the old stamp.
 *
 * Known-defect seeding (the later-step design call the step-1
 * and step-2 landings left open): the picker also sees a
 * code-declared registry of KNOWN defects that no ledger line
 * ever records (KNOWN_DEFECTS below). A seeded defect enters
 * the ranking beside the ledger classes at count 1 with
 * source "known" and its recorded date as its timestamps, so
 * any real recurring class outranks it; it becomes the top
 * spec only when the ledger is quiet. A known spec is a spec
 * like any other from there: the audit grounding, the
 * owner-only stamp, and the work bridge all apply unchanged.
 *
 * Step 2 (the work bridge, below the picker): the recorded spec
 * is WORKED, not just written. queueSelfWorkFix hands a workable
 * recorded spec to the C3 coding loop as a task in a dedicated
 * self-work chat - the heartbeat tick's existing drain works it
 * in the designated code root (suite + goldfish review, C4
 * branch + local commits). The refusals are the program's
 * fences restated as code: an owner-only spec is NEVER queued
 * (the hard boundary), a blocked spec waits for its clearing
 * act, one fix at a time, and a spec is worked once. Landing
 * stays gated: reconcileSelfWorkFixes turns a DONE task's
 * branch into a git-push proposal on the ONE gate (adopting an
 * existing pending proposal for the branch, never duplicating
 * it) - nothing pushes without the owner's approval - and
 * every terminal task earns exactly ONE digest line, recorded
 * on the fix record and ledgered once, which the standing
 * job's diffed delivery carries to the owner.
 */

export const SELF_WORK_JOB_NAME = "self-work";
export const SELF_WORK_SCRIPT = "sam-self-work";

/** Files a self-work spec may never hand to SAM's own hands:
 *  the gate, the policy, and the allowlist machinery. */
export const SELF_WORK_PROTECTED_FILES = ["actions.ts", "approval-policy.ts", "code.ts", "schedule.ts"];

export interface DefectClass {
  key: string;
  label: string;
  count: number;
  firstAt: string;
  lastAt: string;
  actors: string[];
  evidence: string;
  /** Where the class came from: the activity ledger, or the
   *  known-defect registry seeded beside it. Legacy recorded
   *  runs predate the field and read as ledger classes. */
  source?: "ledger" | "known";
}

/** A known defect: recorded in the roadmap / by the operator
 *  as real, but never written to the activity ledger, so the
 *  ledger alone can never surface it. The registry is data in
 *  code - reviewed like code, extended one honest entry at a
 *  time, never by the model and never at run time. */
export interface KnownDefect {
  key: string;
  label: string;
  /** When the defect was recorded (its ranking timestamps). */
  recordedAt: string;
  evidence: string;
  files: string[];
}

/** The known-defect registry, seeded beside the ledger in
 *  rankDefects at count 1. First entry: the SELF-WORK
 *  provisioning GAP - the engine binary probe (engine.ts, and
 *  engine-connect.ts's own copy) tests lstatSync().isFile(),
 *  which is false for a symlink, and npm's global install puts
 *  a symlink on PATH, so a stock install reads the engine as
 *  not installed; installs work around it by pointing
 *  SAM_ENGINE_BIN at the resolved real binary. */
export const KNOWN_DEFECTS: KnownDefect[] = [
  {
    key: "known:engine-binary-symlink",
    label: "known defect: engine binary probe misses symlinked installs (npm global)",
    recordedAt: "2026-11-11T20:17:00.000Z",
    evidence: "Recorded in the SELF-WORK provisioning pass (2026-11-11): engineBinary probes with lstatSync().isFile(), which is FALSE for npm's global install because the claude binary on PATH is a symlink; a stock npm install therefore reads installed:false. Worked around the operator way (SAM_ENGINE_BIN pointing at the resolved real binary). No ledger line ever records it.",
    files: ["engine.ts", "engine-connect.ts"],
  },
];

export interface SelfWorkSpec {
  id: string;
  defectKey: string;
  label: string;
  count: number;
  /** The top class's source: ledgered recurrence, or the
   *  known-defect registry. Legacy specs predate the field. */
  source?: "ledger" | "known";
  evidence: string;
  endGoal: string;
  doneLooksLike: string[];
  notDone: string[];
  files: string[];
  ownerOnly: boolean;
  blockedBy: string | null;
}

export interface SelfWorkRun {
  at: string;
  auditAt: string | null;
  ranked: DefectClass[];
  spec: SelfWorkSpec | null;
}

interface SpecTemplate { files: string[]; endGoal: string; doneLooksLike: string[]; notDone: string[] }

function templateFor(key: string, label: string, count: number): SpecTemplate {
  const n = String(count);
  const base = (files: string[], endGoal: string, doneLooksLike: string[], extraNotDone: string[] = []): SpecTemplate => ({
    files, endGoal, doneLooksLike,
    notDone: [
      "Claiming the class fixed from a single quiet run - the ledger must show the class absent across later comparable work, or a regression test must pin the failure shape",
      "Widening any allowlist, gate, budget number, or fence to make the symptom stop instead of fixing its cause",
      "Editing SAM's own gate, policy, or allowlist code (owner-only, forever) or landing anything except through the existing approval gate",
      ...extraNotDone,
    ],
  });
  if (key === "known:engine-binary-symlink") return base(
    ["engine.ts", "engine-connect.ts"],
    "A stock engine install reads as installed without an operator workaround: the binary probes test lstatSync().isFile(), which is false for the symlink npm's global install puts on PATH, so the engine (and the engine-connect probe's own copy) reads not-installed until SAM_ENGINE_BIN is pointed at the resolved real file by hand.",
    ["A test with a symlinked fake binary (the npm-global shape) reads installed through both probes, and a genuinely missing binary still reads not-installed",
     "The full suite is green, including the win-path guard, with the guard itself unedited",
     "An install with no SAM_ENGINE_BIN set and a symlinked engine on PATH reports the engine truthfully in status and the self-audit"],
    ["Loosening, editing, or routing around the win-path guard or its reserved-probe discipline to make the suite pass - the guard is the owner's tripwire, not an obstacle; if the reserve truly blocks the fix, the honest close is blocked naming that conflict, never a quiet guard edit"]);
  if (key === "tool-budget") return base(
    ["budgets.ts", "own-tools.ts", "connector-chat.ts"],
    "Turns stop ending on the tool budget with work unfinished: " + n + " ledgered tool-budget endings are the top recurring defect, and a turn that gathers results must answer from them (naming what it could not finish) instead of truncating.",
    ["A reproduction of the overspend shape answers from its partial results and names the unfinished checks, with no throw",
     "The tool-budget ledger line still records the overspend (calls used, executed, not executed) so the class stays countable",
     "The full suite is green, including the budget-tier and graceful-exhaustion tests"]);
  if (key === "loader-loop") return base(
    ["tool-tiers.ts", "own-tools.ts", "connector-chat.ts"],
    "Loader-only rounds stop recurring: " + n + " ledgered loader loops mean turns spent their steps loading tools and never acted, and the guard's nudge must steer the model to a loaded tool or an honest answer before the turn stops.",
    ["A history-poisoned reproduction recovers after the nudge (acts or answers) instead of tripping the guard",
     "A genuine second loader-only round still stops the turn honestly as a loader loop, never dressed as a budget or step ending",
     "The full suite is green, including both loops' loader-guard tests"]);
  if (key.startsWith("turn-failed:")) return base(
    ["openai-compatible.ts", "agent-turn.ts"],
    "The " + label + " class stops killing turns: it has ledgered " + n + " turn failures, and a completion in that shape must be recovered (retry, strip, or honest fallback) instead of throwing out of the turn.",
    ["The verbatim failure shape is reproduced in a test and the turn resolves to an answer or an honest fallback, never a raw throw",
     "Exactly one turn-failed ledger line still lands per genuinely dead turn, with the verbatim error, so the class stays countable",
     "The full suite is green, including the provider markup/empty-completion tests"]);
  if (key === "turn-retry") return base(
    ["agent-turn.ts", "own-tools.ts", "connector-chat.ts"],
    "Turns stop needing the context-reset retry as often: " + n + " ledgered retries mean first attempts keep failing on the full context, and the prompt assembly must stop poisoning first attempts.",
    ["The retry-triggering shape is identified from the ledgered cases and reproduced in a test that passes on the first attempt after the fix",
     "The reset retry itself stays as the safety net, and its ledger line still records when it fires",
     "The full suite is green"]);
  if (key.startsWith("heartbeat-failed:")) return base(
    ["heartbeat.ts"],
    "The failing heartbeat job stops failing: '" + label + "' has ledgered " + n + " job failures, and its failure must be fixed at its cause (or isolated with the reason recorded) instead of recurring on schedule.",
    ["The job's next runs complete with their normal verdict (changed, unchanged, or a script output) instead of job-failed lines",
     "A failure in this job still never wedges the tick: the other jobs and the drains in the same tick still run",
     "The full suite is green, including the heartbeat failure-isolation tests"]);
  if (key.startsWith("tick-failed:")) return base(
    ["heartbeat.ts"],
    "The failing heartbeat tick stage stops failing: '" + label + "' has ledgered " + n + " stage failures, and the stage must complete its work (or be fixed at its cause) instead of being skipped by the tick guard on every tick.",
    ["The stage's next ticks complete their normal work (consolidation watermarks advance, the pending deliveries drain, the due jobs run and their rows save, or a drain runs its queued tasks) instead of tick-failed lines",
     "A failure in this stage still never wedges the tick: the jobs and the other stages in the same tick still run, and exactly one tick-failed line lands per failed stage",
     "The full suite is green, including the heartbeat tick-stage isolation tests"]);
  if (key.startsWith("consolidate-failed:")) return base(
    ["heartbeat.ts", "corrections.ts", "skill-author.ts"],
    "The failing consolidation sub-step stops failing: '" + label + "' has ledgered " + n + " failures, and the sub-step must complete its work (owner corrections routed to the approval gate, or the skill library curated) instead of being silently skipped inside every consolidation run - a correction the routing drops is lost for good once the scan watermark passes it.",
    ["The sub-step's next consolidation runs complete their normal work (a correction in a chat produces its deduped law proposal on the gate, or the curator records its finding set) instead of consolidate-failed lines",
     "Exactly one consolidate-failed ledger line still lands per failed sub-step per consolidation run, with the verbatim reason, so the class stays countable",
     "The full suite is green, including the consolidation sub-step failure-ledger tests"]);
  if (key.startsWith("compaction-failed:")) return base(
    ["compaction.ts", "memory.ts", "chats.ts"],
    "The failing compaction step stops failing: '" + label + "' has ledgered " + n + " failures, and a long chat's fold must complete its durable writes (the stored-compaction read, the memory flush, or the summary save) instead of silently riding the raw tail on every turn - a flush-step failure wedges the chat uncompacted forever, and a save-step failure is what the retry-safe flush keeps from duplicating the segment's flush record.",
    ["The failing step's next folds complete (the chat's compaction record advances and exactly one flush record exists per folded segment) instead of compaction-failed lines",
     "Exactly one compaction-failed ledger line still lands per genuinely failed fold attempt, with the phase and verbatim reason, so the class stays countable",
     "Compaction still never breaks a turn: the caller fail-opens to the raw tail exactly as before",
     "The full suite is green, including the compaction failure-ledger tests"]);
  if (key === "usage-failed") return base(
    ["usage.ts"],
    "Usage accounting stops failing: " + n + " ledgered usage-record failures, and model spend must land in .sam/usage.jsonl instead of dying at the append - the usage summaries and the dashboard's usage-today number keep reporting the frozen totals as truth while the ledger is dead, so an unrecorded spend is also an understated one.",
    ["The next model responses record their usage lines in usage.jsonl again instead of usage-failed lines",
     "Exactly one usage-failed ledger line still lands per genuinely failed touch, with the model (on a write) and verbatim reason, so the class stays countable",
     "Accounting still never breaks a turn: a failed usage write returns null and the turn completes exactly as before",
     "A failed usage read still fails closed (one ledger line, then the rethrow) instead of folding to a false zero, exactly as its readers expect",
     "The full suite is green, including the accounting failure-ledger tests"]);
  if (key === "session-caps-failed") return base(
    ["session-caps.ts"],
    "The session-cap ledger stops failing: " + n + " ledgered session-caps failures, and a completed turn's spend record (or a cap trip) must land in .sam/session-caps.jsonl instead of dying at the append - while the write threw, a finished turn could be reported failed and a real model error masked by the accounting error in its place.",
    ["The next turns record their session-cap lines (and a cap trip records once) instead of session-caps-failed lines",
     "Exactly one session-caps-failed ledger line still lands per genuinely failed write, naming which write and the verbatim reason, so the class stays countable",
     "Accounting still never breaks a turn: recordSessionTurn and noteCapTrip never throw, and the graceful cap reply still returns",
     "The full suite is green, including the accounting failure-ledger tests"]);
  if (key === "skill-use-failed") return base(
    ["skill-use.ts", "own-tools.ts"],
    "Skill-use visibility stops failing: " + n + " ledgered skill-use record failures, and a model's skill read must land in .sam/skill-use.jsonl instead of dying at the append or the read - the dashboard rail, chat header, and status keep folding the frozen ledger as truth while it is dead, so an unrecorded use is also an invisible one, and a dead read kills the whole status payload raw instead of surfacing as a countable line.",
    ["The next skill reads record their skill-use lines again instead of skill-use-failed lines, and skill-use reads return the recorded entries again",
     "Exactly one skill-use-failed ledger line still lands per genuinely failed touch, naming the skill on a write and the verbatim reason, so the class stays countable",
     "Visibility still never breaks the skill read it records: recordSkillUse never throws, the sam_read_skill result returns exactly as before, and no success skill-use activity line rides a record that did not land",
     "A failed skill-use read still fails closed (one ledger line, then the rethrow) instead of folding to a false empty history or dying raw, exactly as its readers expect",
     "The full suite is green, including the skill-use failure-ledger tests"]);
  if (key.startsWith("worthiness-failed:")) return base(
    ["worthiness.ts", "heartbeat.ts", "loop-revisit.ts"],
    "The worthiness gate's ledger stops failing: '" + label + "' has ledgered " + n + " failures, and an assessment must land in .sam/delivery-ledger.jsonl instead of dying at the read or the append - the ledger is the gate's only memory (the duplicate cooldown and the hourly rate cap read nothing else), so while it is dead the gate decides on a frozen past and the status delivered/suppressed counts keep folding that frozen file as truth.",
    ["The next proactive deliveries record their assessments in delivery-ledger.jsonl again instead of worthiness-failed lines, and duplicate/rate decisions move with them",
     "Exactly one worthiness-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "The gate still never breaks the delivery it judges: assessDelivery returns its verdict on a dead ledger (law rules alone when the read died) exactly as callers expect",
     "A failed worthiness read on a direct surface (the status counts, the deliveries list) still fails closed (one ledger line, then the rethrow) instead of folding to zero counts or dying raw, and an assessment's read never ledgers twice for one touch",
     "The full suite is green, including the worthiness failure-ledger tests"]);
  if (key.startsWith("verification-failed:")) return base(
    ["verification.ts", "file-edits.ts", "code.ts", "approved-test-runner.ts"],
    "The verification ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a code change (or a build/test verdict) must land in .sam/verifications.jsonl instead of dying at the append or the read - the ledger is the verify-on-stop gate every done claim answers to, so while it is dead the gate folds a frozen past: an unrecorded change can read clean, a lost verdict leaves verified work unverified, and a dead read throws out of status and close checks.",
    ["The next code changes and approved build/test runs record their events in verifications.jsonl again instead of verification-failed lines, and the gate state moves with them",
     "Exactly one verification-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "Recording still never breaks the work it records: recordChange and recordVerification return whether the record landed instead of throwing on an append failure, while a failed read still fails closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the verification failure-ledger tests"]);
  if (key.startsWith("goldfish-failed:")) return base(
    ["goldfish.ts", "coding.ts", "engine.ts", "status.ts"],
    "The goldfish records ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a fresh-context review (or its record) must land in .sam/goldfish.jsonl instead of dying at the append or the read - the records are the reviewer's own coverage ledger and the last word on done, so while they are dead a spent review's verdict is lost (the drains close blocked on a misleading 'could not run') and every status / session-gate fold keeps reading the frozen records as truth.",
    ["The next fresh-context reviews record their verdicts in goldfish.jsonl again instead of goldfish-failed lines, and goldfish status / coverage move with them",
     "Exactly one goldfish-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "The reviewer still fails closed on a dead ledger: a failed append ledgers and rethrows (an unrecorded PASS is never spent as reviewed-and-done), and a failed read ledgers and rethrows exactly as callers expect",
     "The full suite is green, including the goldfish failure-ledger tests"]);
  if (key.startsWith("code-write-failed:")) return base(
    ["code.ts", "coding.ts", "status.ts"],
    "The code-writes ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a C1 code write (or its record) must land in .sam/code-writes.jsonl instead of dying at the append or the read - the ledger is the hands' own record and the coding loop counts a task's new writes by slicing it, so while it is dead the close summary loses the write's diff, and a folded-empty read would close a task 'no changes' over work it actually wrote.",
    ["The next code writes record their writes-ledger lines again instead of code-write-failed lines, and code writes / coding close summaries move with them",
     "Exactly one code-write-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "Recording still never breaks the write it records: a failed append ledgers once and the write returns with its artifact, activity, and verify-on-stop records landed, while a failed read still fails closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the code-writes failure-ledger tests"]);
  if (key === "backup-failed") return base(
    ["backup.ts"],
    "The nightly state backup stops failing: " + n + " ledgered backup failures, and the P9 run must produce its verified archive instead of dying where only the systemd journal can see it.",
    ["The nightly backup run completes and writes its success line with a manifest-verified archive instead of backup-failed lines",
     "Exactly one backup-failed ledger line still lands per genuinely failed run, with the verbatim reason, so the class stays countable",
     "The full suite is green, including the backup failure-ledger tests"]);
  if (key.startsWith("outbox-failed:")) return base(
    ["delivery-outbox.ts", "heartbeat.ts", "loop-revisit.ts"],
    "The delivery outbox ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a delivery event (queued, delivered, attempt-failed, suppressed) must land in .sam/delivery-outbox.jsonl instead of dying at the append or the read - the outbox is the durable delivery ledger, so while it is dead a queued delivery is owed that nobody can prove was owed, a delivered record stays pending and is sent twice, and the status counts keep folding the frozen file as truth.",
    ["The next heartbeat and second-answer deliveries record their outbox events again instead of outbox-failed lines, and pending / delivered / suppressed counts move with them",
     "Exactly one outbox-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "Recording still never reclassifies the work it records: a failed transition append ledgers once and the mark reports whether it landed instead of throwing, while a failed queue append and a failed read still fail closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the delivery outbox failure-ledger tests"]);
  if (key.startsWith("heartbeat-log-failed:")) return base(
    ["heartbeat.ts", "brief.ts", "status.ts"],
    "The heartbeat log ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a tick event (consolidate, job, job-unchanged, job-failed, delivery, tick-failed) must land in .sam/heartbeats.jsonl instead of dying at the append or the read - the log is the engine room's audit record and the tick guard's own failure line rides its append, so while it is dead a stage failure can kill the whole tick with no activity trace, and status / the daily brief keep folding the frozen log as truth (failed-job counts, last-tick state).",
    ["The next ticks record their heartbeat log lines again instead of heartbeat-log-failed lines, and the status heartbeat log / brief failed-job counts move with them",
     "Exactly one heartbeat-log-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "The append still never breaks the tick it records: appendLog returns whether the line landed instead of throwing, and tickStageFailure's activity line lands even when the log append died, while a failed read still fails closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the heartbeat log failure-ledger tests"]);
  if (key.startsWith("activity-failed:")) return base(
    ["activity.ts", "self-work.ts", "observability.ts", "status.ts"],
    "The activity ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a read of .sam/activity.jsonl must return the recorded history instead of dying at the filesystem touch - this ledger is the record every failure kind lands in and the defect queue, observability, status, and the CLI all fold it as truth, so while its read is dead the queue reports zero defects and every failure count reads zero: perfect health reported by a blind instrument.",
    ["The next activity reads return the recorded lines again instead of activity-failed lines, and the defect queue / observability / status folds move with them",
     "Exactly one activity-failed ledger line still lands per genuinely failed read where the append path lives, naming the verbatim reason, so the class stays countable",
     "Recording still never breaks the work it records: recordActivity still never throws, while a failed read still fails closed (one ledger attempt, then the rethrow) exactly as callers expect",
     "The full suite is green, including the activity failure-ledger tests"]);
  if (key.startsWith("execution-audit-failed:")) return base(
    ["approved-test-runner.ts", "status.ts"],
    "The execution-audit ledger stops failing: '" + label + "' has ledgered " + n + " failures, and an approved test run event (requested, started, finished) must land in .sam/execution-audit.jsonl instead of dying at the append or the read - the ledger is the approved runner's own record, so while it is dead an audit append can spend a consumed one-use authorization without the run executing, discard a finished run's result before its verification settles, and status keeps folding the frozen file as the audit history.",
    ["The next approved build/test runs record their requested / started / finished events again instead of execution-audit-failed lines, and the status audit tail moves with them",
     "Exactly one execution-audit-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "Recording still never breaks the run it records: a failed append ledgers once and the request, execution, result, and verification settle proceed exactly as before, while a failed read still fails closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the execution-audit failure-ledger tests"]);
  if (key.startsWith("team-messages-failed:")) return base(
    ["team-runtime.ts", "status.ts"],
    "The team-messages ledger stops failing: '" + label + "' has ledgered " + n + " failures, and a standing team message (assignment, work, review, result) must land in .sam/team-messages.jsonl instead of dying at the append or the read - the ledger is the team's own record of its exchanges and status folds it as truth, so while it is dead a finished run can be reclassified failed by its own bookkeeping, and a dead or torn read reports a team that never said anything.",
    ["The next standing team runs record their assignment / work / review / result messages again instead of team-messages-failed lines, and team status moves with them",
     "Exactly one team-messages-failed ledger line still lands per genuinely failed touch, naming the phase and the verbatim reason, so the class stays countable",
     "Recording still never reclassifies the run it records: a failed append ledgers once and the run's verdict, result, and activity / chat mirroring proceed exactly as before, while a failed read still fails closed (one ledger line, then the rethrow) exactly as callers expect",
     "The full suite is green, including the team-messages failure-ledger tests"]);
  if (key.startsWith("standing-file-failed:")) return base(
    ["standing-files.ts", "agent-turn.ts"],
    "Standing file reads stop failing: '" + label + "' has ledgered " + n + " failures, and a profile's standing file (persona, owner brief, ops notes) must load from .sam/standing/<profile>/ instead of dying at the read - while it is dead the file silently vanishes from every system prompt (and, before the per-file guard, took the healthy files after it with it), a state indistinguishable from the owner clearing the files, and the status standing summary keeps dying raw on the same touch.",
    ["The next turns assemble their prompts with the standing files present again instead of standing-file-failed lines, and the standing summary reads the files back",
     "Exactly one standing-file-failed ledger line still lands per genuinely failed touch, naming the profile, the file, and the verbatim reason, so the class stays countable",
     "Prompt assembly still never breaks a turn on a broken file: the failed file is skipped, its healthy siblings still assemble, and a read already ledgered by the reader is never recorded twice",
     "A failed direct read still fails closed (one ledger line, then the rethrow) instead of folding the file as absent, exactly as its readers expect",
     "The full suite is green, including the standing-file failure-ledger tests"]);
  if (key.startsWith("recall-failed:")) return base(
    ["recall.ts", "agent-turn.ts"],
    "Recall assembly stops failing: '" + label + "' has ledgered " + n + " failures, and the memory a profile already holds (episodes, decisions, open loops, message-relevant records) must assemble into the turn's context instead of dying at that seam - while it is dead SAM answers with no memory at all (or silently without the relevant records), a state indistinguishable from SAM simply knowing nothing, which is the S1 defect class (asking again, or burning tool calls hunting).",
    ["The next turns open with what SAM already knows again instead of recall-failed lines, and the relevant records ride in the recall block",
     "Exactly one recall-failed ledger line still lands per genuinely failed seam per call, naming the phase and the verbatim reason, so the class stays countable",
     "Recall still never breaks a turn: a failed seam drops only its own section, the surviving sections still assemble, and a total failure reads as an empty memory exactly as before",
     "The full suite is green, including the recall failure-ledger tests"]);
  if (key === "delivery-failed") return base(
    ["heartbeat.ts", "delivery-outbox.ts", "loop-revisit.ts"],
    "Heartbeat deliveries stop failing: " + n + " ledgered delivery failures, and a changed heartbeat update must reach its channel (or the channel's failure must be fixed at its cause) instead of retrying silently and giving up at the attempt cap.",
    ["The next changed heartbeat updates land delivered in the outbox instead of delivery-failed lines, on the fresh-send, recovery, and second-answer paths",
     "Exactly one delivery-failed ledger line still lands per genuinely failed attempt, with the verbatim reason and attempt count, and the terminal settle at the cap is named, so the class stays countable",
     "The full suite is green, including the delivery failure-ledger tests"]);
  if (key === "skill-install-failure") return base(
    ["skill-registry.ts"],
    "Skill installs stop failing on resolvable references: " + n + " ledgered install failures, and a search result SAM picks must either install or refuse at proposal time with the real reason, never die mid-install on a reference that was never installable.",
    ["The failing reference shapes refuse at proposal/search time naming the reason, and an installable pick installs end to end",
     "A genuinely dead reference still ledgers failed with its verbatim reason - failures stay honest and countable",
     "The full suite is green, including the installRef and scan tests"]);
  if (key === "action-failed") return base(
    ["actions.ts"],
    "Gated action executions stop failing: " + n + " ledgered execution failures, and a proposal the owner approved must either execute or land failed with a corrected re-proposal, never a dead card. NOTE: this class's likely file is the gate's own executor, so this spec is owner-only by the hard boundary - it is recorded for the owner, never queued for SAM's hands.",
    ["Each ledgered failure shape is reproduced and either executes on approval or lands failed with the reason and, where a correction is unambiguous, a fresh corrected proposal",
     "Proposal-time validation refuses any new card in a shape that cannot execute",
     "The full suite is green, including the gate executor tests"]);
  if (key === "loop-failed") return base(
    ["loop-revisit.ts"],
    "Open-loop revisits stop failing: " + n + " ledgered revisit failures, and a due loop's re-check must complete (or reschedule with the reason recorded) instead of dying.",
    ["The failing revisit shape completes or reschedules with its reason on the loop record",
     "A failed re-check still never wedges the heartbeat tick",
     "The full suite is green, including the revisit tests"]);
  if (key === "background-failed") return base(
    ["background.ts"],
    "Background tasks stop failing: " + n + " ledgered failures, and a handed-off task must run to a posted result (or a posted failure with the real reason) instead of dying silently.",
    ["The failing task shape posts its result or its honest failure into its chat",
     "A stale running task is still recovered as failed by the next drain instead of wedging",
     "The full suite is green, including the background drain tests"]);
  if (key === "coding-failed" || key === "coding-blocked") return base(
    ["coding.ts"],
    "Coding tasks stop closing " + (key === "coding-failed" ? "failed" : "blocked") + ": " + n + " ledgered, and the loop must iterate on the failure as data (or name the true blocker) instead of closing on the first bad state.",
    ["The closing shape is reproduced and the loop either iterates past it or closes blocked naming the exact missing piece",
     "A task still never closes done unverified, unreviewed, or uncommitted",
     "The full suite is green, including the coding loop tests"]);
  if (key === "engine-failed" || key === "engine-blocked") return base(
    ["engine.ts"],
    "Managed engine runs stop closing " + (key === "engine-failed" ? "failed" : "blocked") + ": " + n + " ledgered, and a run must either complete its verify/review/commit close or name the exact blocker that stopped it.",
    ["The closing shape is reproduced with a fake engine binary and the close names its true cause",
     "Unreviewed or unverified engine work still never closes done",
     "The full suite is green, including the engine drain tests"]);
  if (key === "subagent-failed") return base(
    ["subagents.ts"],
    "Sub-agent runs stop closing failed: " + n + " ledgered failures, and a helper child's turn must either return its result (folded into the owner's chat when quiet) or fail with the true cause fixed at its seam instead of recurring.",
    ["The failing child shape is reproduced in a test and the child either returns or fails once with its verbatim reason on the record",
     "Exactly one subagent-failed ledger line still lands per genuinely failed child, so the class stays countable",
     "The full suite is green, including the sub-agent drive tests"]);
  if (key === "delegate-failed") return base(
    ["coding-operatives.ts"],
    "Coding delegations stop closing failed: " + n + " ledgered failures, and an approved delegation must either finish its run with its diff and test record or close failed naming the exact cause (launch, lease, worktree, or the operative's own exit) instead of recurring.",
    ["The closing shape is reproduced with a fake operative spawn and the close names its true cause",
     "A delegation still never pushes and never opens a pull request, whatever its outcome",
     "The full suite is green, including the coding-operatives tests"]);
  if (key === "team-failed" || key === "team-blocked") return base(
    ["team-runtime.ts"],
    "Standing team runs stop closing " + (key === "team-failed" ? "failed" : "blocked") + ": " + n + " ledgered, and a run must either finish with the reviewer's verdict on the record or close naming the exact cause (a member call dying, the budget, or review never approving) instead of recurring.",
    ["The closing shape is reproduced with a stub completer and the close names its true cause",
     "Exactly one team-" + (key === "team-failed" ? "failed" : "blocked") + " ledger line still lands per closed run, so the class stays countable",
     "The full suite is green, including the standing team tests"]);
  if (key === "connector-pair-failed") return base(
    ["connector-pairing.ts"],
    "Connector self-pairing stops failing on resolvable shapes: " + n + " ledgered failures, and a pairing attempt must either complete (registered, bound, tested, pinned) or refuse before any state is written with the real reason, never die mid-pairing and roll back.",
    ["The failing pairing shape refuses up front naming the reason, and a sound pairing completes end to end",
     "A genuinely dead pairing still ledgers connector-pair-failed with its verbatim reason and rolls back fully - failures stay honest and countable",
     "The full suite is green, including the connector-pairing tests"]);
  return base(
    [],
    "The '" + label + "' class stops recurring: it is the top ledgered defect with " + n + " occurrences, and its cause must be found from the ledgered evidence and fixed at that seam.",
    ["The failure shape is reproduced from the ledgered evidence in a test",
     "The fix lands with the full suite green and the class stays ledgered so its absence is countable",
     "The recorded self-audit still reads true after the fix (no capability was widened or lost silently)"]);
}

/** Classify one ledger line into a defect class, or null when
 *  the line is not a failure record. Deterministic: kind first,
 *  then the summary's own shape (the error text for turn
 *  failures, the job name for heartbeat failures, the skill
 *  prefix for execution failures). */
export function classifyDefect(line: ActivityLine): { key: string; label: string } | null {
  const summary = line.summary ?? "";
  switch (line.kind) {
    case "tool-budget":
      return { key: "tool-budget", label: "tool-budget endings (exhaustion and step-limit)" };
    case "loader-loop":
      return { key: "loader-loop", label: "loader loops (turns that only loaded tools)" };
    case "turn-failed": {
      const error = summary.includes("): ") ? summary.slice(summary.indexOf("): ") + 3) : summary;
      if (/unsafe model output/i.test(error)) return { key: "turn-failed:unsafe-output", label: "turn failures: unsafe model output" };
      if (/empty model response/i.test(error)) return { key: "turn-failed:empty-response", label: "turn failures: empty model response" };
      if (/too many tool calls/i.test(error)) return { key: "turn-failed:too-many-tool-calls", label: "turn failures: too many tool calls" };
      if (/timed out|timeout/i.test(error)) return { key: "turn-failed:timeout", label: "turn failures: model timeout" };
      if (/not configured/i.test(error)) return { key: "turn-failed:not-configured", label: "turn failures: model not configured" };
      return { key: "turn-failed:other", label: "turn failures: " + error.slice(0, 60) };
    }
    case "turn-retry":
      return { key: "turn-retry", label: "turns needing a context-reset retry" };
    case "heartbeat-failed": {
      const m = summary.match(/Heartbeat '([^']+)'/);
      const name = m ? m[1] : "unnamed";
      return { key: "heartbeat-failed:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: "heartbeat job failures (" + name + ")" };
    }
    case "tick-failed": {
      const m = summary.match(/tick stage '([^']+)'/);
      const stage = m ? m[1] : "unknown";
      return { key: "tick-failed:" + stage.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: "heartbeat tick stage failures (" + stage + ")" };
    }
    case "consolidate-failed": {
      if (/skill curator/i.test(summary)) return { key: "consolidate-failed:curator", label: "consolidation sub-step failures (skill curator)" };
      return { key: "consolidate-failed:corrections", label: "consolidation sub-step failures (correction routing)" };
    }
    case "compaction-failed": {
      const m = summary.match(/^Compaction ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "compaction-failed:" + phase, label: "compaction failures (" + phase + " step)" };
    }
    case "failed":
      if (/^skill:/i.test(summary)) return { key: "skill-install-failure", label: "skill install failures" };
      return { key: "action-failed", label: "gated action execution failures" };
    case "loop-failed":
      return { key: "loop-failed", label: "open-loop revisit failures" };
    case "usage-failed":
      return { key: "usage-failed", label: "usage accounting failures" };
    case "session-caps-failed":
      return { key: "session-caps-failed", label: "session-cap ledger failures" };
    case "skill-use-failed":
      return { key: "skill-use-failed", label: "skill-use ledger failures" };
    case "worthiness-failed": {
      const m = summary.match(/^Worthiness ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "worthiness-failed:" + phase, label: "worthiness ledger failures (" + phase + " step)" };
    }
    case "verification-failed": {
      const m = summary.match(/^Verification ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "verification-failed:" + phase, label: "verification ledger failures (" + phase + " step)" };
    }
    case "goldfish-failed": {
      const m = summary.match(/^Goldfish ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "goldfish-failed:" + phase, label: "goldfish ledger failures (" + phase + " step)" };
    }
    case "code-write-failed": {
      const m = summary.match(/^Code write ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "code-write-failed:" + phase, label: "code-writes ledger failures (" + phase + " step)" };
    }
    case "backup-failed":
      return { key: "backup-failed", label: "state backup failures" };
    case "outbox-failed": {
      const m = summary.match(/^Delivery outbox ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "outbox-failed:" + phase, label: "delivery outbox ledger failures (" + phase + " step)" };
    }
    case "heartbeat-log-failed": {
      const m = summary.match(/^Heartbeat log ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "heartbeat-log-failed:" + phase, label: "heartbeat log ledger failures (" + phase + " step)" };
    }
    case "activity-failed": {
      const m = summary.match(/^Activity ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "activity-failed:" + phase, label: "activity ledger failures (" + phase + " step)" };
    }
    case "execution-audit-failed": {
      const m = summary.match(/^Execution audit ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "execution-audit-failed:" + phase, label: "execution-audit ledger failures (" + phase + " step)" };
    }
    case "team-messages-failed": {
      const m = summary.match(/^Team messages ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "team-messages-failed:" + phase, label: "team-messages ledger failures (" + phase + " step)" };
    }
    case "standing-file-failed": {
      const m = summary.match(/^Standing file ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "standing-file-failed:" + phase, label: "standing file failures (" + phase + " step)" };
    }
    case "recall-failed": {
      const m = summary.match(/^Recall ([a-z]+) failed/);
      const phase = m ? m[1] : "unknown";
      return { key: "recall-failed:" + phase, label: "recall failures (" + phase + " step)" };
    }
    case "delivery-failed":
      return { key: "delivery-failed", label: "heartbeat delivery failures" };
    case "bridge-failed":
      return { key: "bridge-failed", label: "telegram bridge update failures" };
    case "bridge-poll-failed":
      return { key: "bridge-poll-failed", label: "telegram bridge poll failures" };
    case "background-failed":
      return { key: "background-failed", label: "background task failures" };
    case "coding-failed":
      return { key: "coding-failed", label: "coding tasks closing failed" };
    case "coding-blocked":
      return { key: "coding-blocked", label: "coding tasks closing blocked" };
    case "engine-failed":
      return { key: "engine-failed", label: "engine runs closing failed" };
    case "engine-blocked":
      return { key: "engine-blocked", label: "engine runs closing blocked" };
    case "subagent-failed":
      return { key: "subagent-failed", label: "sub-agent runs closing failed" };
    case "delegate-failed":
      return { key: "delegate-failed", label: "coding delegations closing failed" };
    case "team-failed":
      return { key: "team-failed", label: "standing team runs closing failed" };
    case "team-blocked":
      return { key: "team-blocked", label: "standing team runs closing blocked" };
    case "connector-pair-failed":
      return { key: "connector-pair-failed", label: "connector self-pairing failures" };
    default:
      return null;
  }
}

/** Rank every defect class in the ledger: count descending,
 *  most recent first on a tie, key ascending last - the same
 *  ledger always yields the same ranking. The known-defect
 *  registry is seeded beside the ledger: each known defect
 *  enters at count 1 with its recorded date as its first and
 *  last sighting, so a real recurring class (or a fresher
 *  one-off) always outranks it, and it tops the queue only
 *  when the ledger is quiet. Known keys are namespaced
 *  ("known:") so they can never merge with a ledger class. */
export function rankDefects(root: string): DefectClass[] {
  const groups = new Map<string, DefectClass & { actorSet: Set<string> }>();
  for (const line of readActivity(root, 100_000)) {
    const cls = classifyDefect(line);
    if (!cls) continue;
    let g = groups.get(cls.key);
    if (!g) {
      g = { key: cls.key, label: cls.label, count: 0, firstAt: line.at, lastAt: line.at, actors: [], evidence: "", source: "ledger", actorSet: new Set() };
      groups.set(cls.key, g);
    }
    g.count += 1;
    if (line.at < g.firstAt) g.firstAt = line.at;
    if (line.at >= g.lastAt) { g.lastAt = line.at; g.evidence = (line.summary ?? "").slice(0, 200); }
    g.actorSet.add(line.actor);
  }
  const ranked: DefectClass[] = [...groups.values()].map(g => ({ key: g.key, label: g.label, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, actors: [...g.actorSet].sort(), evidence: g.evidence, source: "ledger" as const }));
  for (const known of KNOWN_DEFECTS) {
    if (ranked.some(r => r.key === known.key)) continue;
    ranked.push({ key: known.key, label: known.label, count: 1, firstAt: known.recordedAt, lastAt: known.recordedAt, actors: [], evidence: known.evidence, source: "known" });
  }
  ranked.sort((a, b) => (b.count - a.count) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || (a.key < b.key ? -1 : 1));
  return ranked;
}

/** Build the spec for the top defect, grounded in the recorded
 *  audit (read, never run - refreshing the map is the audit's
 *  own job). Pure assembly: records nothing. Spec identity is
 *  stable: when the previous recorded run's spec names this
 *  same top class with the same count and the same last
 *  sighting, its id is reused (see the module header), so the
 *  work bridge's worked-once guard binds across runs; any
 *  growth mints a fresh id. */
export function buildSelfWorkSpec(root: string, audit: SelfAudit | null = readSelfAudit(root), now: Date = new Date()): SelfWorkRun {
  const ranked = rankDefects(root);
  const top = ranked[0] ?? null;
  let spec: SelfWorkSpec | null = null;
  if (top) {
    const t = templateFor(top.key, top.label, top.count);
    const ownerOnly = t.files.some(f => SELF_WORK_PROTECTED_FILES.includes(f));
    let blockedBy: string | null = null;
    if (!audit) blockedBy = "no capability self-audit has been recorded yet - run 'sam self-audit run' first, so the pick rests on the true map (SELF-WORK step 0)";
    else if (t.files.length && !audit.code.root) blockedBy = "the recorded self-audit reads no designated code root (cannot: coder hands) - designating one is the operator's act, so this fix has no workbench yet";
    let previous: SelfWorkRun | null = null;
    try { previous = readSelfWork(root); } catch { previous = null; }
    const prevSpec = previous?.spec ?? null;
    const prevTop = previous?.ranked?.[0] ?? null;
    const unchanged = prevSpec !== null && prevTop !== null
      && prevSpec.defectKey === top.key && prevSpec.count === top.count
      && prevTop.key === top.key && prevTop.lastAt === top.lastAt;
    spec = {
      id: unchanged ? prevSpec.id : "selfwork-" + randomUUID().slice(0, 8),
      defectKey: top.key, label: top.label, count: top.count, source: top.source ?? "ledger", evidence: top.evidence,
      endGoal: t.endGoal, doneLooksLike: t.doneLooksLike, notDone: t.notDone,
      files: t.files, ownerOnly, blockedBy,
    };
  }
  return { at: now.toISOString(), auditAt: audit?.at ?? null, ranked, spec };
}

// ---- The recorded run (singleton SQLite store) ----------------

function storePath(root: string) { return join(resolve(root), ".sam", "self-work.json"); }
function storeDbPath(root: string) { return join(resolve(root), ".sam", "self-work.db"); }

function parseRun(data: unknown): SelfWorkRun | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<SelfWorkRun>;
  if (typeof value.at !== "string" || !value.at || !Array.isArray(value.ranked)) return null;
  return value as SelfWorkRun;
}
function openStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(storeDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS self_work (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS self_work_fixes (spec_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacy(db, root);
  return db;
}
function migrateLegacy(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM self_work WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = storePath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseRun(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO self_work (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function storeExists(root: string): boolean {
  return existsSync(storeDbPath(root)) || existsSync(storePath(root));
}

/** The latest recorded self-work run through the store's own
 *  shape, or null when none has ever run - a pure read on an
 *  install with no store creates nothing. */
export function readSelfWork(root: string): SelfWorkRun | null {
  if (!storeExists(root)) return null;
  const db = openStore(root);
  try {
    const row = db.prepare("SELECT data FROM self_work WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseRun(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function saveRun(root: string, run: SelfWorkRun): void {
  const db = openStore(root);
  try {
    db.prepare("INSERT INTO self_work (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(run));
  } finally { db.close(); }
}

/** Run the picker: rank the ledger, write the top spec, record
 *  the run, and ledger one counts-only line. Returns the run. */
export function runSelfWork(root: string, now: Date = new Date()): SelfWorkRun {
  const run = buildSelfWorkSpec(root, readSelfAudit(root), now);
  saveRun(root, run);
  if (run.spec) {
    recordActivity(root, "sam", "self-work", "Self-work spec " + run.spec.id + " written: " + run.spec.defectKey + " x" + String(run.spec.count) + (run.spec.ownerOnly ? " (owner-only)" : "") + (run.spec.blockedBy ? " (blocked)" : "") + " - " + String(run.ranked.length) + " defect class(es) ranked");
  } else {
    recordActivity(root, "sam", "self-work", "Self-work run: no ledgered defect classes found - no spec written");
  }
  return run;
}

// ---- Step 2: the work bridge (spec -> gated coding task) ----

export interface SelfWorkFix {
  specId: string;
  defectKey: string;
  label: string;
  count: number;
  taskId: string;
  chatId: string;
  queuedAt: string;
  /** The ONE gate's git-push proposal created for a done fix's
   *  branch - the only landing door. Null until reconcile. */
  proposalId: string | null;
  /** The per-fix digest line, written exactly once when the
   *  coding task reaches a terminal state. */
  digest: string | null;
  digestedAt: string | null;
}

export interface SelfWorkFixView extends SelfWorkFix {
  taskStatus: CodingTask["status"] | null;
}

function parseFix(data: unknown): SelfWorkFix | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<SelfWorkFix>;
  if (typeof value.specId !== "string" || !value.specId || typeof value.taskId !== "string" || !value.taskId) return null;
  return value as SelfWorkFix;
}

/** Every recorded fix, oldest first - a pure read on an install
 *  with no store creates nothing. */
export function listSelfWorkFixes(root: string): SelfWorkFix[] {
  if (!storeExists(root)) return [];
  const db = openStore(root);
  try {
    const rows = db.prepare("SELECT data FROM self_work_fixes ORDER BY rowid").all() as Array<{ data: string }>;
    const items: SelfWorkFix[] = [];
    for (const row of rows) {
      try { const fix = parseFix(JSON.parse(row.data)); if (fix) items.push(fix); } catch { /* a malformed row is skipped, never fatal */ }
    }
    return items;
  } finally { db.close(); }
}

function saveFix(root: string, fix: SelfWorkFix): void {
  const db = openStore(root);
  try {
    db.prepare("INSERT INTO self_work_fixes (spec_id, data) VALUES (?, ?) ON CONFLICT(spec_id) DO UPDATE SET data = excluded.data").run(fix.specId, JSON.stringify(fix));
  } finally { db.close(); }
}

/** Fix records joined with their coding task's live status -
 *  the read shape status and the run text carry. */
export function selfWorkFixViews(root: string): SelfWorkFixView[] {
  return listSelfWorkFixes(root).map(fix => ({ ...fix, taskStatus: getCodingTask(root, fix.taskId)?.status ?? null }));
}

/** The coding task's spec text: the recorded three-part spec
 *  verbatim in shape - end goal, done conditions, not-done
 *  fences, likely files, and the ledgered evidence - plus the
 *  self-work framing (this is SAM fixing SAM in the workbench
 *  clone; the landing is a separate gated act). */
export function selfWorkFixSpecText(spec: SelfWorkSpec): string {
  const lines = [
    "Self-work fix (SELF-WORK loop): the top recurring defect in SAM's own activity ledger, specced by the deterministic self-work picker and worked here in the designated code root, which is a clone of SAM's own repository.",
    "",
    "Defect: " + spec.label + " (" + spec.defectKey + "), " + (spec.source === "known" ? "a known defect seeded beside the ledger from the recorded registry (not a ledgered recurrence)" : "ledgered " + String(spec.count) + " time(s)") + ".",
    "Evidence: " + spec.evidence,
    ...(spec.files.length ? ["Likely files: " + spec.files.map(f => "src/" + f).join(", ")] : []),
    "",
    "End goal: " + spec.endGoal,
    "",
    "Done looks like:",
    ...spec.doneLooksLike.map(d => "- " + d),
    "",
    "Not done:",
    ...spec.notDone.map(d => "- " + d),
    "",
    "Boundaries: fix the cause in the code, never the symptom; do not edit the approval gate, the approval policy, or any allowlist code (owner-only, forever); do not widen any budget, fence, or permission to make the failures stop; the work lands only as a local branch the owner can push through the approval gate - never push, never open a pull request.",
  ];
  return lines.join("\n");
}

/** Queue the RECORDED top spec as a coding task (step 2's first
 *  act). Every refusal names its reason: no recorded run, an
 *  owner-only spec (the hard boundary - recorded for the owner,
 *  never SAM's hands), a blocked spec (its clearing act is
 *  named on the spec), a fix already in flight (one at a time),
 *  a spec already worked, or no designated code root. On
 *  success the task waits in the coding queue for the heartbeat
 *  tick's drain, in a dedicated self-work chat bound to the
 *  core profile. */
export function queueSelfWorkFix(root: string, now: Date = new Date()): SelfWorkFix {
  const run = readSelfWork(root);
  if (!run?.spec) throw new Error("No self-work spec has been recorded yet - run 'sam self-work run' first; the work bridge takes the recorded spec, never a fresh opinion.");
  const spec = run.spec;
  if (spec.ownerOnly) throw new Error("Spec " + spec.id + " (" + spec.defectKey + ") is OWNER-ONLY: its likely files touch SAM's gate, policy, or allowlist machinery, which the SELF-WORK hard boundary keeps out of SAM's own hands forever. It is recorded for the owner and is never queued.");
  if (spec.blockedBy) throw new Error("Spec " + spec.id + " (" + spec.defectKey + ") is blocked: " + spec.blockedBy);
  const fixes = listSelfWorkFixes(root);
  const tasks = listCodingTasks(root);
  const inFlight = fixes.find(f => { const t = tasks.find(t => t.id === f.taskId); return t !== undefined && (t.status === "queued" || t.status === "running"); });
  if (inFlight) throw new Error("A self-work fix is already in flight: spec " + inFlight.specId + " (" + inFlight.defectKey + "), coding task " + inFlight.taskId + " - one fix at a time; it closes through the coding loop before another queues.");
  if (fixes.some(f => f.specId === spec.id)) throw new Error("Spec " + spec.id + " (" + spec.defectKey + ") already has a fix record - a spec is worked once; the next recorded run's spec is the next candidate.");
  if (!codeRoot(root)) throw new Error("No code root is designated on this install, so a self-work fix has no workbench. The operator designates one with: sam code set-root <path>.");
  const store = new ChatStore(root);
  let chatId: string;
  try { chatId = store.create(("Self-work: " + spec.label).slice(0, 120), "sam").id; } finally { store.close(); }
  const task = queueCodingTask(root, { actor: "sam", chatId, spec: selfWorkFixSpecText(spec) });
  const fix: SelfWorkFix = {
    specId: spec.id, defectKey: spec.defectKey, label: spec.label, count: spec.count,
    taskId: task.id, chatId, queuedAt: now.toISOString(), proposalId: null, digest: null, digestedAt: null,
  };
  saveFix(root, fix);
  recordActivity(root, "sam", "self-work-fix", "Self-work fix queued: spec " + spec.id + " (" + spec.defectKey + " x" + String(spec.count) + ") -> coding task " + task.id + " in the designated code root; it lands only through the git-push approval gate");
  return fix;
}

function fixDigestLine(fix: SelfWorkFix, task: CodingTask, proposalId: string | null): string {
  const head = "Self-fix " + fix.specId + " (" + fix.defectKey + " x" + String(fix.count) + "): " + task.status;
  if (task.status === "done") {
    const files = task.changes.length ? String(task.changes.length) + " file(s) changed" : "no files changed";
    if (task.git?.mode === "branch" && task.git.branch) {
      const commits = String(task.git.commits.length) + " local commit(s)";
      return head + " - " + files + " on " + task.git.branch + ", " + commits + "; " + (proposalId
        ? "git-push proposal " + proposalId.slice(0, 8) + " waits on the owner's approval - nothing lands without it"
        : "no push proposal could be recorded - the branch waits for the owner's 'sam coding push' act");
    }
    return head + " - " + files + "; the code root is not a git repository, so there is no branch to land";
  }
  const reason = (task.result ?? "no reason recorded").replace(/\s+/g, " ").slice(0, 160);
  return head + " - " + reason;
}

/** Close the loop on recorded fixes (step 2's second act),
 *  deterministically: for each fix whose coding task reached a
 *  terminal state, create the landing proposal when the task
 *  closed DONE on a clean branch (adopting an existing pending
 *  git-push proposal for that branch - the gate never holds
 *  two cards for one push) and write the ONE digest line.
 *  In-flight tasks are left exactly as they are. Returns the
 *  updated fix records. */
export function reconcileSelfWorkFixes(root: string, now: Date = new Date()): SelfWorkFix[] {
  const out: SelfWorkFix[] = [];
  for (const fix of listSelfWorkFixes(root)) {
    if (fix.digest) { out.push(fix); continue; }
    const task = getCodingTask(root, fix.taskId);
    if (!task) {
      fix.digest = "Self-fix " + fix.specId + " (" + fix.defectKey + " x" + String(fix.count) + "): coding task record no longer exists - nothing landed; re-spec from the ledger if the class still recurs";
      fix.digestedAt = now.toISOString();
      saveFix(root, fix);
      recordActivity(root, "sam", "self-work-fix", fix.digest);
      out.push(fix);
      continue;
    }
    if (task.status === "queued" || task.status === "running") { out.push(fix); continue; }
    let proposalId = fix.proposalId;
    let proposalNote = "";
    if (task.status === "done" && task.git?.mode === "branch" && task.git.branch && task.git.pending.length === 0 && !proposalId) {
      const branch = task.git.branch;
      const existing = listActions(root).find(a => {
        if (a.kind !== "git-push" || a.status !== "pending") return false;
        try { return (JSON.parse(a.detail) as { branch?: unknown }).branch === branch; } catch { return false; }
      });
      if (existing) proposalId = existing.id;
      else {
        try {
          proposalId = proposeAction(root, { actor: task.actor, kind: "git-push", title: "Push " + branch + " (self-work fix " + fix.specId + ": " + fix.defectKey + ")", detail: JSON.stringify({ branch }), chatId: task.chatId }).id;
        } catch (e) { proposalNote = " (push proposal refused: " + (e instanceof Error ? e.message : "unknown") + ")"; }
      }
    }
    fix.proposalId = proposalId;
    fix.digest = fixDigestLine(fix, task, proposalId) + proposalNote;
    fix.digestedAt = now.toISOString();
    saveFix(root, fix);
    recordActivity(root, task.actor, "self-work-fix", fix.digest);
    out.push(fix);
  }
  return out;
}

/** One advance of the standing loop: reconcile finished fixes
 *  first (old business closes before new work queues), then
 *  queue the recorded spec when it is workable. A queue refusal
 *  is data, not a failure - it rides back as the note the run
 *  text prints. */
export function advanceSelfWork(root: string, now: Date = new Date()): { queued: SelfWorkFix | null; queueNote: string | null; fixes: SelfWorkFix[] } {
  reconcileSelfWorkFixes(root, now);
  let queued: SelfWorkFix | null = null;
  let queueNote: string | null = null;
  try { queued = queueSelfWorkFix(root, now); }
  catch (e) { queueNote = e instanceof Error ? e.message : "queue refused"; }
  return { queued, queueNote, fixes: reconcileSelfWorkFixes(root, now) };
}

/** The run as plain text (the sam-self-work script job's
 *  stdout shape): the ranked queue and the three-part spec a
 *  person - or the loop's next step - reads, plus the step-2
 *  fix lines when the work bridge has records (a fix in flight,
 *  a queue refusal worth naming, and the per-fix digests).
 *  Stable text when nothing changed is what Phase C diffing
 *  silences on. */
export function selfWorkText(run: SelfWorkRun, opts: { fixes?: SelfWorkFixView[]; queueNote?: string | null } = {}): string {
  const lines: string[] = ["Self-work - " + run.at];
  lines.push("Capability map: " + (run.auditAt ? "self-audit recorded " + run.auditAt : "none recorded"));
  if (!run.ranked.length) {
    lines.push("", "No ledgered defect classes. Nothing to spec.");
  } else {
    lines.push("", "Defect queue (ranked; known defects seeded beside the ledger):");
    for (const d of run.ranked.slice(0, 5)) lines.push("- " + d.key + ": " + String(d.count) + "x, last " + d.lastAt + " - " + d.label + (d.source === "known" ? " [known defect, seeded]" : ""));
    const spec = run.spec;
    if (spec) {
      lines.push("", "Top spec " + spec.id + " - " + spec.label + " (" + String(spec.count) + "x)");
      if (spec.source === "known") lines.push("Source: the known-defect registry - recorded as real, never ledgered; it topped the queue because the ledger is quiet, not because it recurred.");
      lines.push("Evidence: " + spec.evidence);
      if (spec.files.length) lines.push("Likely files: " + spec.files.map(f => "src/" + f).join(", "));
      if (spec.ownerOnly) lines.push("Boundary: OWNER-ONLY - this spec touches the gate/policy/allowlist machinery; it is recorded for the owner and is never queued for SAM's own hands.");
      if (spec.blockedBy) lines.push("Blocked by: " + spec.blockedBy);
      lines.push("", "End goal: " + spec.endGoal, "", "Done looks like:");
      for (const d of spec.doneLooksLike) lines.push("- " + d);
      lines.push("", "Not done:");
      for (const d of spec.notDone) lines.push("- " + d);
    }
  }
  const fixes = opts.fixes ?? [];
  if (fixes.length || opts.queueNote) {
    lines.push("", "Self-work fixes:");
    if (opts.queueNote) lines.push("- Not queued: " + opts.queueNote);
    for (const f of fixes.slice(-3)) {
      lines.push("- " + (f.digest ?? ("Fix " + f.specId + " (" + f.defectKey + " x" + String(f.count) + "): coding task " + (f.taskStatus ?? "missing") + " in the code workbench")));
    }
  }
  return lines.join("\n");
}

/** The installed self-work job, if any: a script-mode heartbeat
 *  job running sam-self-work. */
export function selfWorkJob(root: string): HeartbeatJob | null {
  return heartbeatJobs(root).find(j => j.mode === "script" && j.script === SELF_WORK_SCRIPT) ?? null;
}

export function selfWorkStatus(root: string): { installed: boolean; job: HeartbeatJob | null; script: string; lastRun: SelfWorkRun | null; fixes: SelfWorkFixView[] } {
  return { installed: selfWorkJob(root) !== null, job: selfWorkJob(root), script: SELF_WORK_SCRIPT, lastRun: readSelfWork(root), fixes: selfWorkFixViews(root) };
}

/** Install the standing self-work job: one wall-clock script
 *  job on the Phase C surface, profile sam, riding the
 *  worthiness gate and the delivery outbox when a channel is
 *  named. Installing twice refuses - there is one self-work
 *  loop, not a stack of them. A channel is named by id or by
 *  its registry name. */
export function installSelfWork(root: string, opts: { channelId?: string | null; schedule?: string; timezone?: string } = {}): HeartbeatJob {
  const existing = selfWorkJob(root);
  if (existing) throw new Error("The self-work loop is already installed as job '" + existing.name + "' (" + existing.id + ") - remove that heartbeat job first if it should move.");
  let channelId: string | null = null;
  if (opts.channelId) {
    const found = channels(root).find(c => c.id === opts.channelId || c.name === opts.channelId);
    if (!found) throw new Error("Unknown channel '" + opts.channelId + "'. Channels: " + (channels(root).map(c => c.name).join(", ") || "none"));
    channelId = found.id;
  }
  return addScheduledJob(root, {
    name: SELF_WORK_JOB_NAME, profile: "sam",
    schedule: opts.schedule ?? "daily at 6am",
    timezone: opts.timezone ?? "America/New_York",
    script: SELF_WORK_SCRIPT, channelId,
  });
}

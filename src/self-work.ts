import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { readActivity, recordActivity, type ActivityLine } from "./activity.js";
import { channels } from "./channels.js";
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
}

export interface SelfWorkSpec {
  id: string;
  defectKey: string;
  label: string;
  count: number;
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
  const base = (files: string[], endGoal: string, doneLooksLike: string[]): SpecTemplate => ({
    files, endGoal, doneLooksLike,
    notDone: [
      "Claiming the class fixed from a single quiet run - the ledger must show the class absent across later comparable work, or a regression test must pin the failure shape",
      "Widening any allowlist, gate, budget number, or fence to make the symptom stop instead of fixing its cause",
      "Editing SAM's own gate, policy, or allowlist code (owner-only, forever) or landing anything except through the existing approval gate",
    ],
  });
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
    case "failed":
      if (/^skill:/i.test(summary)) return { key: "skill-install-failure", label: "skill install failures" };
      return { key: "action-failed", label: "gated action execution failures" };
    case "loop-failed":
      return { key: "loop-failed", label: "open-loop revisit failures" };
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
    default:
      return null;
  }
}

/** Rank every defect class in the ledger: count descending,
 *  most recent first on a tie, key ascending last - the same
 *  ledger always yields the same ranking. */
export function rankDefects(root: string): DefectClass[] {
  const groups = new Map<string, DefectClass & { actorSet: Set<string> }>();
  for (const line of readActivity(root, 100_000)) {
    const cls = classifyDefect(line);
    if (!cls) continue;
    let g = groups.get(cls.key);
    if (!g) {
      g = { key: cls.key, label: cls.label, count: 0, firstAt: line.at, lastAt: line.at, actors: [], evidence: "", actorSet: new Set() };
      groups.set(cls.key, g);
    }
    g.count += 1;
    if (line.at < g.firstAt) g.firstAt = line.at;
    if (line.at >= g.lastAt) { g.lastAt = line.at; g.evidence = (line.summary ?? "").slice(0, 200); }
    g.actorSet.add(line.actor);
  }
  const ranked = [...groups.values()].map(g => ({ key: g.key, label: g.label, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, actors: [...g.actorSet].sort(), evidence: g.evidence }));
  ranked.sort((a, b) => (b.count - a.count) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || (a.key < b.key ? -1 : 1));
  return ranked;
}

/** Build the spec for the top defect, grounded in the recorded
 *  audit (read, never run - refreshing the map is the audit's
 *  own job). Pure assembly: records nothing. */
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
    spec = {
      id: "selfwork-" + randomUUID().slice(0, 8),
      defectKey: top.key, label: top.label, count: top.count, evidence: top.evidence,
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
  const db = new Database(storeDbPath(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS self_work (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
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

/** The run as plain text (the sam-self-work script job's
 *  stdout shape): the ranked queue and the three-part spec a
 *  person - or the loop's next step - reads. Stable text when
 *  nothing changed is what Phase C diffing silences on. */
export function selfWorkText(run: SelfWorkRun): string {
  const lines: string[] = ["Self-work - " + run.at];
  lines.push("Capability map: " + (run.auditAt ? "self-audit recorded " + run.auditAt : "none recorded"));
  if (!run.ranked.length) {
    lines.push("", "No ledgered defect classes. Nothing to spec.");
    return lines.join("\n");
  }
  lines.push("", "Defect queue (ledgered, ranked):");
  for (const d of run.ranked.slice(0, 5)) lines.push("- " + d.key + ": " + String(d.count) + "x, last " + d.lastAt + " - " + d.label);
  const spec = run.spec;
  if (spec) {
    lines.push("", "Top spec " + spec.id + " - " + spec.label + " (" + String(spec.count) + "x)");
    lines.push("Evidence: " + spec.evidence);
    if (spec.files.length) lines.push("Likely files: " + spec.files.map(f => "src/" + f).join(", "));
    if (spec.ownerOnly) lines.push("Boundary: OWNER-ONLY - this spec touches the gate/policy/allowlist machinery; it is recorded for the owner and is never queued for SAM's own hands.");
    if (spec.blockedBy) lines.push("Blocked by: " + spec.blockedBy);
    lines.push("", "End goal: " + spec.endGoal, "", "Done looks like:");
    for (const d of spec.doneLooksLike) lines.push("- " + d);
    lines.push("", "Not done:");
    for (const d of spec.notDone) lines.push("- " + d);
  }
  return lines.join("\n");
}

/** The installed self-work job, if any: a script-mode heartbeat
 *  job running sam-self-work. */
export function selfWorkJob(root: string): HeartbeatJob | null {
  return heartbeatJobs(root).find(j => j.mode === "script" && j.script === SELF_WORK_SCRIPT) ?? null;
}

export function selfWorkStatus(root: string): { installed: boolean; job: HeartbeatJob | null; script: string; lastRun: SelfWorkRun | null } {
  return { installed: selfWorkJob(root) !== null, job: selfWorkJob(root), script: SELF_WORK_SCRIPT, lastRun: readSelfWork(root) };
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

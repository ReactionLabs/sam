import { readActivity, recordActivity } from "./activity.js";
import { listActions } from "./actions.js";
import { listBackgroundTasks } from "./background.js";
import { codingSummary } from "./coding.js";
import { deliverySummary } from "./delivery-outbox.js";
import { engineStatus } from "./engine.js";
import { addScheduledJob, heartbeatChannelBlocker, heartbeatChannelId, heartbeatJobs, heartbeatLog, type HeartbeatJob } from "./heartbeat.js";
import { runSense, type SenseResult, type SenseRunner } from "./senses.js";

/**
 * The morning brief (Plan Phase E item 3; the parity list's item 3:
 * "A brief, not a report: one daily digest job over calendar,
 * leads, and stack health that says the few things that matter...
 * Config on top of 1+2, not new machinery").
 *
 * Until this module, nothing assembled the owner's day. The
 * senses were two raw reader calls; the needs-you state was
 * scattered across four stores (pending approvals, the delivery
 * outbox, heartbeat verdicts, the work queues); and the only
 * digest-shaped job was a per-mini starter prompt with no senses
 * behind it, so the owner had to open the dashboard and assemble
 * the picture himself.
 *
 * - DETERMINISTIC: the brief is assembled in code from the
 *   stores, never by a model call (the episodes / curator
 *   precedent). It costs nothing, it cannot hallucinate a
 *   section, and its text is exactly what the tests assert.
 * - HONEST SECTIONS: every source yields ok, empty, or
 *   unavailable, and an unavailable source says so in one line
 *   (the senses reader is not installed yet, so agenda and mail
 *   read that way until the operator installs it) - a section is
 *   never silently dropped and never invented.
 * - CORE ONLY: the brief is the core profile's picture of the
 *   owner's day (it rides the core-only senses), so the tool
 *   seam refuses scoped profiles and visitors; the CLI is the
 *   operator's own door and acts as the core.
 * - DELIVERY IS PHASE C's: "sam-brief" is one more entry on the
 *   script-job allowlist (SAM's own read-only CLI reports), and
 *   `brief install` creates the daily wall-clock script job.
 *   Diffing, the worthiness gate, and the durable outbox sit
 *   downstream unchanged - this module builds no delivery
 *   machinery of its own.
 */

export const BRIEF_JOB_NAME = "morning brief";
export const BRIEF_SCRIPT = "sam-brief";
const MAX_BRIEF_CHARS = 4_000;
const MAX_SECTION_ITEMS = 5;

export interface BriefSection { name: string; state: "ok" | "empty" | "unavailable"; lines: string[] }
export interface BriefResult { at: string; text: string; sections: BriefSection[] }

/** One reader-output item -> one plain line. The reader's JSON
 *  shape is its own; the brief picks the fields a person scans
 *  (a title-ish field, a time-ish field, a sender) and never
 *  carries the raw payload. Non-object items pass as text. */
function itemLine(item: unknown): string | null {
  if (typeof item === "string") return item.trim() ? item.trim().slice(0, 120) : null;
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object") {
        const nested = v as Record<string, unknown>;
        for (const nk of ["dateTime", "date", "time"]) {
          const nv = nested[nk];
          if (typeof nv === "string" && nv.trim()) return nv.trim();
        }
      }
    }
    return null;
  };
  const title = pick("summary", "title", "subject", "name");
  const when = pick("start", "dateTime", "when", "time");
  const from = pick("from", "sender", "organizer");
  const parts = [when, from, title].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return parts.join(" - ").slice(0, 120);
}

/** Reader output -> at most MAX_SECTION_ITEMS lines plus a
 *  "and N more" tail. JSON arrays are itemized; anything else is
 *  carried as plain text lines (the output is data, capped). */
export function senseItemLines(output: string): { lines: string[]; total: number } {
  const raw = (output ?? "").trim();
  if (!raw) return { lines: [], total: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).items) ? (parsed as Record<string, unknown>).items as unknown[] : null);
    if (arr) {
      const lines: string[] = [];
      for (const item of arr) { const line = itemLine(item); if (line) lines.push(line); }
      const total = lines.length;
      const shown = lines.slice(0, MAX_SECTION_ITEMS);
      if (total > shown.length) shown.push("and " + String(total - shown.length) + " more");
      return { lines: shown, total };
    }
  } catch { /* not JSON: fall through to text lines */ }
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean).map(l => l.slice(0, 120));
  const total = lines.length;
  const shown = lines.slice(0, MAX_SECTION_ITEMS);
  if (total > shown.length) shown.push("and " + String(total - shown.length) + " more");
  return { lines: shown, total };
}

function senseSection(name: string, result: SenseResult, emptyLine: string): BriefSection {
  if (!result.ok) {
    const reason = result.error ?? "the read failed";
    const line = /not installed/i.test(reason)
      ? "Not readable yet: the senses reader is not installed on this machine, so this section lights up when the operator installs and authorizes it."
      : "Not readable this time: " + reason.split(". ")[0].slice(0, 160) + ".";
    return { name, state: "unavailable", lines: [line] };
  }
  const { lines, total } = senseItemLines(result.output);
  if (!total) return { name, state: "empty", lines: [emptyLine] };
  return { name, state: "ok", lines };
}

function needsYouSection(root: string, now: Date): BriefSection {
  const lines: string[] = [];
  const pending = listActions(root).filter(a => a.status === "pending");
  if (pending.length) {
    const byKind = new Map<string, number>();
    for (const a of pending) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    const kinds = [...byKind.entries()].map(([k, n]) => k + (n > 1 ? " x" + String(n) : "")).join(", ");
    lines.push(String(pending.length) + (pending.length === 1 ? " approval" : " approvals") + " waiting for you: " + kinds);
  }
  const deliveries = deliverySummary(root);
  if (deliveries.pending) lines.push(String(deliveries.pending) + (deliveries.pending === 1 ? " delivery" : " deliveries") + " still pending in the outbox");
  if (deliveries.failed) lines.push(String(deliveries.failed) + (deliveries.failed === 1 ? " delivery" : " deliveries") + " failed and need a look");
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const failedJobs = heartbeatLog(root, 500).filter(e => e.type === "job-failed" && typeof e.at === "string" && Date.parse(e.at as string) >= dayAgo);
  for (const e of failedJobs.slice(-3)) lines.push("Heartbeat job failed in the last day: " + String(e.name ?? "unnamed") + (typeof e.error === "string" ? " (" + (e.error as string).slice(0, 80) + ")" : ""));
  if (!lines.length) return { name: "Needs you", state: "empty", lines: ["Nothing is waiting on you: no approvals, no stuck deliveries, no failed jobs in the last day."] };
  return { name: "Needs you", state: "ok", lines };
}

function watchesSection(root: string): BriefSection {
  const jobs = heartbeatJobs(root);
  if (!jobs.length) return { name: "Watches", state: "empty", lines: ["No heartbeat jobs are running."] };
  const log = heartbeatLog(root, 500);
  const lines: string[] = [];
  for (const job of jobs) {
    const entries = log.filter(e => e.name === job.name && (e.type === "job" || e.type === "job-unchanged" || e.type === "job-failed"));
    const last = entries[entries.length - 1];
    if (!last) { lines.push(job.name + ": no verdict yet"); continue; }
    const at = typeof last.at === "string" ? (last.at as string).slice(11, 16) + " UTC" : "";
    if (last.type === "job-unchanged") lines.push(job.name + ": unchanged as of " + at);
    else if (last.type === "job-failed") lines.push(job.name + ": last run failed" + (at ? " at " + at : ""));
    else {
      const preview = typeof last.replyPreview === "string" ? (last.replyPreview as string).split("\n")[0].replace(/^-\s*/, "").slice(0, 100) : "";
      lines.push(job.name + ": changed at " + at + (preview ? " - " + preview : ""));
    }
  }
  return { name: "Watches", state: "ok", lines };
}

function queuesSection(root: string, env: NodeJS.ProcessEnv): BriefSection {
  const backgroundOpen = listBackgroundTasks(root).filter(t => t.status === "queued" || t.status === "running").length;
  const coding = codingSummary(root);
  const engine = engineStatus(root, env);
  const codingOpen = coding.queued + coding.running;
  const engineOpen = engine.queued + engine.running;
  const lines: string[] = [];
  if (backgroundOpen) lines.push(String(backgroundOpen) + (backgroundOpen === 1 ? " background task" : " background tasks") + " queued or running");
  if (codingOpen) lines.push(String(codingOpen) + (codingOpen === 1 ? " coding task" : " coding tasks") + " queued or running");
  if (engineOpen) lines.push(String(engineOpen) + (engineOpen === 1 ? " engine run" : " engine runs") + " queued or running");
  if (!lines.length) return { name: "Work queues", state: "empty", lines: ["No background, coding, or engine work is waiting."] };
  return { name: "Work queues", state: "ok", lines };
}

export interface BriefDeps { now?: Date; env?: NodeJS.ProcessEnv; runner?: SenseRunner; timezone?: string }

/** Assemble the brief. Deterministic, no model call; the senses
 *  are the only subprocess work, and each read ledgers itself in
 *  runSense. One brief activity line records the section states -
 *  never any content, which is the owner's private data. */
export async function buildBrief(root: string, deps: BriefDeps = {}): Promise<BriefResult> {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const timezone = deps.timezone ?? "America/New_York";
  const agenda = await runSense(root, "sam", "agenda", { days: 1, now, env, runner: deps.runner });
  const mail = await runSense(root, "sam", "mail", { query: "in:inbox newer_than:1d", max: 10, env, runner: deps.runner });
  const sections: BriefSection[] = [
    senseSection("Today", agenda, "Nothing on today's calendar."),
    senseSection("Mail", mail, "No new mail in the last day."),
    needsYouSection(root, now),
    watchesSection(root),
    queuesSection(root, env),
  ];
  let dateLine: string;
  try { dateLine = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now); }
  catch { dateLine = now.toISOString().slice(0, 10); }
  let text = "Morning brief - " + dateLine + "\n";
  for (const s of sections) {
    text += "\n" + s.name + ":\n" + s.lines.map(l => "- " + l).join("\n") + "\n";
  }
  if (text.length > MAX_BRIEF_CHARS) text = text.slice(0, MAX_BRIEF_CHARS - 24).trimEnd() + "\n- (brief truncated)";
  recordActivity(root, "sam", "brief", briefLedgerSummary(sections));
  return { at: now.toISOString(), text: text.trimEnd(), sections };
}

/** The ONE writer for the brief activity line, so the
 *  scorecard's parser below can never drift from the seam it
 *  counts. Its shape is byte-identical to what buildBrief wrote
 *  inline before this writer existed: the section names
 *  lowercased, in the brief's fixed section order, each with
 *  its state - never any section content, which is the owner's
 *  private data. */
export function briefLedgerSummary(sections: BriefSection[]): string {
  return "Morning brief assembled: " + sections.map(s => s.name.toLowerCase() + "=" + s.state).join(", ");
}

const BRIEF_SECTION_NAMES = ["today", "mail", "needs you", "watches", "work queues"];
const BRIEF_STATES = ["ok", "empty", "unavailable"];

/** Parse one brief ledger summary. Only the fixed shape
 *  parses: the five sections in their fixed order, each named
 *  exactly as the writer names it, each state from the fixed
 *  ok / empty / unavailable vocabulary. Anything else (a
 *  missing or reordered section, an unknown state, trailing
 *  text) returns null, so a drifted shape counts as
 *  unparseable instead of being silently miscounted. */
export function parseBriefSummary(summary: string): { sections: { name: string; state: string }[] } | null {
  const m = /^Morning brief assembled: (.+)$/.exec(summary);
  if (!m) return null;
  const parts = (m[1] ?? "").split(", ");
  if (parts.length !== BRIEF_SECTION_NAMES.length) return null;
  const sections: { name: string; state: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const eq = part.lastIndexOf("=");
    if (eq < 0) return null;
    const name = part.slice(0, eq);
    const state = part.slice(eq + 1);
    if (name !== BRIEF_SECTION_NAMES[i]) return null;
    if (!BRIEF_STATES.includes(state)) return null;
    sections.push({ name, state });
  }
  return { sections };
}

/** The brief assembly scorecard (2026-11-20, the
 *  measured-proof series): every assembled brief has ledgered
 *  as a "brief" line since the brief landed, but the class was
 *  never folded - it was written inline at its only seam, with
 *  no ONE writer and no reader, so how often a brief has ever
 *  been assembled, and whether its sections read ok, empty, or
 *  unavailable in aggregate, was invisible even though the
 *  section states are the brief's whole honesty signal. An
 *  assembled brief is the brief working as designed, so the
 *  verdict is attention only when a line is unparseable, else
 *  clear. This text folds the class to counts only, on ONE
 *  line: the parsed brief count, the summed per-state section
 *  counts, and the total. No stamp, no actor, no section
 *  content, and no verbatim summary enters the text. A pure
 *  read: it creates nothing, spends no model call, and
 *  assembles no brief - buildBrief itself is untouched apart
 *  from riding the ONE writer. */
export function briefScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "brief" });
  let briefs = 0;
  let unparseable = 0;
  const states = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseBriefSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    briefs += 1;
    for (const s of parsed.sections) states.set(s.state, (states.get(s.state) ?? 0) + 1);
  }
  const parts: string[] = [];
  parts.push("Brief assemblies: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(briefs) + " briefs");
  parts.push(String(states.get("ok") ?? 0) + " ok sections");
  parts.push(String(states.get("empty") ?? 0) + " empty sections");
  parts.push(String(states.get("unavailable") ?? 0) + " unavailable sections");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

/** The installed morning-brief job, if any: a script-mode
 *  heartbeat job running sam-brief. */
export function briefJob(root: string): HeartbeatJob | null {
  return heartbeatJobs(root).find(j => j.mode === "script" && j.script === BRIEF_SCRIPT) ?? null;
}

export function briefStatus(root: string): { installed: boolean; job: HeartbeatJob | null; script: string } {
  const job = briefJob(root);
  return { installed: job !== null, job, script: BRIEF_SCRIPT };
}

/** Install the daily brief: one wall-clock script job on the
 *  Phase C surface, profile sam, riding the worthiness gate and
 *  the delivery outbox when a channel is named. Installing twice
 *  refuses - there is one brief, not a stack of them. A channel
 *  is named by id or by its registry name, and the naming is
 *  judged by the ONE source every heartbeat creation door uses
 *  (heartbeatChannelBlocker in heartbeat.ts): an unknown channel
 *  refuses before anything is created, naming the registry with
 *  ids and the fold correction when exactly one registered
 *  channel matches the bad name folded for case and separators;
 *  a name that passes resolves to its id through
 *  heartbeatChannelId, exactly as the CLI heartbeat doors
 *  resolve it. The brief job IS a heartbeat job, so its channel
 *  door carries no refusal text of its own. The already-
 *  installed check fires first (the duplicate is the owner's
 *  first problem either way). addScheduledJob and the job store
 *  stay permissive by design - only this door's refusal shape
 *  is gated. */
export function installBrief(root: string, opts: { channelId?: string | null; schedule?: string; timezone?: string } = {}): HeartbeatJob {
  const existing = briefJob(root);
  if (existing) throw new Error("The morning brief is already installed as job '" + existing.name + "' (" + existing.id + ") - remove that heartbeat job first if it should move.");
  let channelId: string | null = null;
  if (opts.channelId) {
    const channelBlocker = heartbeatChannelBlocker(root, opts.channelId);
    if (channelBlocker) throw new Error(channelBlocker);
    channelId = heartbeatChannelId(root, opts.channelId);
  }
  return addScheduledJob(root, {
    name: BRIEF_JOB_NAME, profile: "sam",
    schedule: opts.schedule ?? "daily at 8am",
    timezone: opts.timezone ?? "America/New_York",
    script: BRIEF_SCRIPT, channelId,
  });
}

import { fileURLToPath } from "node:url";

// Real cron (Phase C item 1): one scheduling surface for heartbeat
// jobs. A job's schedule is an interval (the legacy shape, minutes
// between runs), a wall-clock time, a 5-field cron expression, or a
// natural-language phrase compiled to cron - plus a per-job IANA
// timezone the next-run computation honors across DST. The plan
// doc's shape: "one scheduling surface accepting intervals,
// wall-clock times, 5-field cron, and natural language compiled to
// cron; per-job timezone; a no-agent script mode".
//
// Cron semantics are the standard ones: minute hour day-of-month
// month day-of-week, with * / lists / ranges / steps, month and
// weekday names, day-of-week 0 and 7 both Sunday, and the classic
// rule that when BOTH day-of-month and day-of-week are restricted
// a day matches when EITHER does. Next-run search walks local
// calendar days in the job's timezone (never raw UTC minutes), so
// a 9am job stays at 9am across a DST jump, and a time inside the
// spring-forward gap simply does not fire that day.

export type ScheduleKind = "interval" | "cron" | "once";
export interface CompiledSchedule { kind: ScheduleKind; minutes: number | null; cron: string | null; onceAt: string | null }

// The owner's timezone (Telegram reminder gaps, 2026-11-10): a
// scheduled job the owner asked for in conversation ("remind me at
// 8am") must mean 8am where the OWNER lives, not 8am UTC on a box
// that happens to run UTC. The install's owner timezone is the
// SAM_OWNER_TIMEZONE env value when it names a real IANA zone, and
// America/New_York otherwise (Dip's timezone, and the morning
// brief's standing default). An explicit per-job timezone always
// wins over this default; an invalid env value falls back instead
// of breaking every schedule compile.
export function ownerTimezone(): string {
  const env = process.env.SAM_OWNER_TIMEZONE;
  if (env) { try { return validateTimezone(env); } catch { /* fall through to the default */ } }
  return "America/New_York";
}

const FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domRestricted: boolean; dowRestricted: boolean }

function fieldValues(raw: string, field: number): Set<number> {
  const [lo, hi] = FIELD_RANGES[field];
  const names = field === 3 ? MONTH_NAMES : field === 4 ? DOW_NAMES : null;
  const out = new Set<number>();
  const token = (t: string): number => {
    const named = names?.[t.toLowerCase()];
    if (named !== undefined) return named;
    if (!/^\d+$/.test(t)) throw new Error("Invalid cron field value: " + t);
    return Number(t);
  };
  for (const part of raw.split(",")) {
    if (!part) throw new Error("Invalid cron field: " + raw);
    const [base, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error("Invalid cron step: " + part);
    let from: number, to: number;
    if (base === "*") { from = lo; to = hi; }
    else if (base.includes("-")) {
      const [a, b] = base.split("-");
      from = token(a); to = token(b);
      if (from > to) throw new Error("Invalid cron range: " + part);
    } else { from = token(base); to = stepRaw === undefined ? from : hi; }
    if (from < lo || to > hi) throw new Error("Cron value out of range (" + lo + "-" + hi + "): " + part);
    for (let v = from; v <= to; v += step) out.add(field === 4 && v === 7 ? 0 : v);
  }
  if (!out.size) throw new Error("Invalid cron field: " + raw);
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week): " + expr);
  return {
    minute: fieldValues(parts[0], 0), hour: fieldValues(parts[1], 1),
    dom: fieldValues(parts[2], 2), month: fieldValues(parts[3], 3), dow: fieldValues(parts[4], 4),
    domRestricted: parts[2] !== "*", dowRestricted: parts[4] !== "*",
  };
}

export function validateTimezone(timezone: string): string {
  if (typeof timezone !== "string" || !/^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/.test(timezone) && timezone !== "UTC") throw new Error("Invalid timezone (use an IANA name like America/New_York): " + timezone);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new Error("Unknown timezone: " + timezone); }
  return timezone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); formatters.set(timezone, f); }
  return f;
}
interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }
function localParts(timezone: string, at: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}
// Minutes the timezone is ahead of UTC at an instant (negative west).
function tzOffsetMinutes(timezone: string, at: Date): number {
  const p = localParts(timezone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}
// Convert a wall-clock time in the timezone to a UTC instant. Two
// offset passes settle DST-adjacent times; the caller verifies the
// result's local parts, so a time inside the spring-forward gap
// (whose conversion lands on a different local time) never fires.
function localToUtc(timezone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMinutes(timezone, new Date(guess)) * 60000;
  utc = guess - tzOffsetMinutes(timezone, new Date(utc)) * 60000;
  return new Date(utc);
}

function dayMatches(f: CronFields, y: number, mo: number, d: number): boolean {
  if (!f.month.has(mo)) return false;
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const domHit = f.dom.has(d), dowHit = f.dow.has(dow);
  if (f.domRestricted && f.dowRestricted) return domHit || dowHit;
  if (f.domRestricted) return domHit;
  if (f.dowRestricted) return dowHit;
  return true;
}

// The next instant strictly after `after` at which the expression
// fires in the timezone, or null inside a 4-year search horizon.
export function nextCronRun(expr: string, timezone: string, after: Date): Date | null {
  const f = parseCron(expr);
  validateTimezone(timezone);
  const start = localParts(timezone, after);
  const hours = [...f.hour].sort((a, b) => a - b), minutes = [...f.minute].sort((a, b) => a - b);
  let y = start.year, mo = start.month, d = start.day;
  for (let day = 0; day < 1466; day++) {
    if (dayMatches(f, y, mo, d)) {
      for (const h of hours) for (const mi of minutes) {
        const utc = localToUtc(timezone, y, mo, d, h, mi);
        if (utc.getTime() <= after.getTime()) continue;
        const p = localParts(timezone, utc);
        if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) return utc;
      }
    }
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return null;
}

export function cronMatchesAt(expr: string, timezone: string, at: Date): boolean {
  const f = parseCron(expr);
  const p = localParts(timezone, at);
  return f.minute.has(p.minute) && f.hour.has(p.hour) && dayMatches(f, p.year, p.month, p.day);
}

// ---- Natural language -> cron -------------------------------------

function parseClock(raw: string): { hour: number; minute: number } {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "noon") return { hour: 12, minute: 0 };
  if (t === "midnight") return { hour: 0, minute: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) throw new Error("Cannot read the time '" + raw + "' (try 9am, 9:30pm, or 14:00)");
  let hour = Number(m[1]); const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) throw new Error("Cannot read the time '" + raw + "'");
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (!m[3] && hour > 23) throw new Error("Cannot read the time '" + raw + "'");
  return { hour, minute };
}

const DOW_WORDS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SCHEDULE_EXAMPLES = "try: 'every 30 minutes', 'daily at 9am', 'weekdays at 8:30am', 'every monday at 9am', 'monthly on the 1st at 9am', 'once at 8am tomorrow', 'once at 2026-11-11 08:00', or a 5-field cron expression";

// One-shot schedules (Telegram reminder gaps, 2026-11-10): "remind
// me at 8am today" is not a daily job - it fires ONCE at one
// wall-clock moment in the job's timezone and then retires. The
// accepted shapes name the moment with a date (ISO, in the job's
// timezone) or with today / tomorrow plus a clock time. The
// compiled shape carries the absolute UTC instant; a moment
// already past refuses here, at compile time, so a one-shot that
// can never fire is never stored (and never shown as a card).
function compileOnce(text: string, timezone: string): CompiledSchedule | null {
  let ymd: { y: number; mo: number; d: number } | null = null;
  let clockRaw: string | null = null;
  let m = text.match(/^once (?:at |on )?(\d{4})-(\d{2})-(\d{2})(?:[ t]+at)?[ t]+(\d{1,2}:\d{2})$/);
  if (m) { ymd = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }; clockRaw = m[4]; }
  if (!ymd) {
    m = text.match(/^once at (.+?) (today|tomorrow)$/) || text.match(/^once (today|tomorrow) at (.+)$/);
    if (m) {
      const which = m[1] === "today" || m[1] === "tomorrow" ? m[1] : m[2];
      clockRaw = m[1] === "today" || m[1] === "tomorrow" ? m[2] : m[1];
      const nowLocal = localParts(timezone, new Date());
      const base = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + (which === "tomorrow" ? 1 : 0)));
      ymd = { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() };
    }
  }
  if (!ymd || clockRaw === null) return null;
  const c = parseClock(clockRaw);
  const utc = localToUtc(timezone, ymd.y, ymd.mo, ymd.d, c.hour, c.minute);
  const parts = localParts(timezone, utc);
  if (parts.year !== ymd.y || parts.month !== ymd.mo || parts.day !== ymd.d || parts.hour !== c.hour || parts.minute !== c.minute) {
    throw new Error("That one-shot time does not exist in " + timezone + " (it falls in a daylight-saving gap) - pick a different time");
  }
  if (utc.getTime() <= Date.now()) throw new Error("That one-shot time is already past in " + timezone + " - a reminder that can never fire is not stored; pick a future time");
  return { kind: "once", minutes: null, cron: null, onceAt: utc.toISOString() };
}

// Compile one schedule phrase to the stored shape. Accepts a raw
// 5-field cron expression verbatim (validated), interval phrases,
// one-shot phrases, and the wall-clock phrases an owner actually
// says. Anything else throws with the supported shapes named, so a
// refusal teaches. The timezone interprets one-shot dates and
// today/tomorrow; it defaults to the owner's timezone.
export function compileSchedule(input: string, timezone: string = ownerTimezone()): CompiledSchedule {
  const raw = (input ?? "").trim();
  if (!raw) throw new Error("Empty schedule - " + SCHEDULE_EXAMPLES);
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(raw) && !/[a-z]{3,}/i.test(raw.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\b/gi, ""))) {
    parseCron(raw); return { kind: "cron", minutes: null, cron: raw.replace(/\s+/g, " "), onceAt: null };
  }
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  if (text.startsWith("once")) { const once = compileOnce(text, validateTimezone(timezone)); if (once) return once; }
  let m = text.match(/^every (\d+) (minute|minutes|min|hour|hours|hr)$/);
  if (m) { const n = Number(m[1]) * (m[2].startsWith("h") ? 60 : 1); if (n < 5 || n > 10080) throw new Error("Interval must be 5 to 10080 minutes"); return { kind: "interval", minutes: n, cron: null, onceAt: null }; }
  if (text === "every minute") throw new Error("Interval must be 5 to 10080 minutes");
  if (text === "every hour") return { kind: "interval", minutes: 60, cron: null, onceAt: null };
  m = text.match(/^(?:daily|every day)(?: at (.+))?$/) || text.match(/^at (.+?) (?:daily|every day)$/);
  if (m) { const c = parseClock(m[1] ?? "9am"); return { kind: "cron", minutes: null, cron: `${c.minute} ${c.hour} * * *`, onceAt: null }; }
  m = text.match(/^(?:weekdays|every weekday)(?: at (.+))?$/) || text.match(/^at (.+?) (?:on )?weekdays$/);
  if (m) { const c = parseClock(m[1] ?? "9am"); return { kind: "cron", minutes: null, cron: `${c.minute} ${c.hour} * * 1-5`, onceAt: null }; }
  m = text.match(/^(?:weekly on|every) ([a-z]+)(?: at (.+))?$/) || text.match(/^at (.+?) (?:on|every) ([a-z]+)$/);
  if (m) {
    const dowWord = m.length === 3 ? m[1] : m[2];
    const timeRaw = m.length === 3 ? m[2] : m[1];
    const dow = DOW_WORDS[dowWord];
    if (dow !== undefined) { const c = parseClock(timeRaw ?? "9am"); return { kind: "cron", minutes: null, cron: `${c.minute} ${c.hour} * * ${dow}`, onceAt: null }; }
  }
  m = text.match(/^monthly on the (\d{1,2})(?:st|nd|rd|th)?(?: at (.+))?$/) || text.match(/^monthly on day (\d{1,2})(?: at (.+))?$/);
  if (m) { const dom = Number(m[1]); if (dom < 1 || dom > 31) throw new Error("Day of month must be 1 to 31"); const c = parseClock(m[2] ?? "9am"); return { kind: "cron", minutes: null, cron: `${c.minute} ${c.hour} ${dom} * *`, onceAt: null }; }
  m = text.match(/^at (.+)$/);
  if (m) { const c = parseClock(m[1]); return { kind: "cron", minutes: null, cron: `${c.minute} ${c.hour} * * *`, onceAt: null }; }
  // A raw cron expression with month/weekday names lands here.
  try { parseCron(raw); return { kind: "cron", minutes: null, cron: raw.replace(/\s+/g, " "), onceAt: null }; } catch { /* fall through to the teaching refusal */ }
  throw new Error("Cannot read the schedule '" + input + "' - " + SCHEDULE_EXAMPLES);
}

// A one-line human description of a stored schedule, for lists and
// the `next` verb: the phrase the owner gave, or the cron itself.
export function describeSchedule(job: { minutes: number; cron?: string | null; schedule?: string | null; timezone?: string; onceAt?: string | null }): string {
  if (job.onceAt) return (job.schedule ?? "once") + " (once at " + job.onceAt + (job.timezone ? ", " + job.timezone : "") + ")";
  if (job.schedule) return job.schedule + (job.cron ? " (" + job.cron + (job.timezone && job.timezone !== "UTC" ? ", " + job.timezone : "") + ")" : "");
  if (job.cron) return "cron " + job.cron + (job.timezone && job.timezone !== "UTC" ? " (" + job.timezone + ")" : "");
  return "every " + job.minutes + " minutes";
}

// ---- No-agent script mode ------------------------------------------
// A script job runs one of SAM's OWN read-only CLI reports and its
// stdout is the job's output - zero model calls, zero model cost.
// The allowlist is a fixed map in code, never data: there is no way
// to name an arbitrary command, a flag, or a shell. Arbitrary shell
// stays out until Phase D's approvals engine lands.
export const SCRIPT_JOB_COMMANDS: Record<string, { description: string; argv: (root: string) => string[] }> = {
  "sam-overview": { description: "The sam overview snapshot (approvals, activity, heartbeats, people, connectors)", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "overview"] },
  "sam-backups": { description: "The backup archive list (sam backup list)", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "backup", "list"] },
  "sam-curator": { description: "The skill curator pass over the library (sam skills curator)", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "skills", "curator"] },
  "sam-deliveries": { description: "The notification-worthiness ledger (sam deliveries list)", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "deliveries", "list"] },
  "sam-brief": { description: "The morning brief (sam brief today): today's agenda and mail through the senses, what needs the owner, the watches' latest verdicts, and the open work queues - assembled deterministically, no model call", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "brief", "today"] },
  "sam-self-audit": { description: "The capability self-audit (sam self-audit run): SAM's own tools, connectors, code root, gates, engine, senses, skills, and channels inventoried in code, with what he can and cannot do and the reason for every cannot - the SELF-WORK program's step 0 map, recorded in .sam/self-audit.db; its text carries no clock reading so a held map stays P3-silent and a real capability change is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "self-audit", "run"] },
  "sam-prompt-audit": { description: "The prompt audit (sam prompt-audit run): SAM's shipped prompts scored in code over the live surfaces a turn receives (core capability statement, plain-style instruction, every own-tool description, budget/loader stub texts) across five dimensions - role clarity, decision rules, tool-use discipline, honesty under uncertainty, output hygiene - with every failed anchored check a named finding; recorded in .sam/prompt-audit.db so prompt changes are measured before/after; its text carries no clock reading so a held score stays P3-silent and a real prompt change is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "prompt-audit", "run"] },
  "sam-context-audit": { description: "The context audit (sam context-audit run): what a chat turn actually loads, measured in code - recall fitting (whole lines, message-relevant section protected, omissions marked), the law block's character cap with omissions named, standing law assembling last, compaction bounds, no stored message entering the prompt twice - plus a measured fixed system load per profile against a named budget; recorded in .sam/context-audit.db so context changes are measured before/after; its text carries no clock reading so a held score stays P3-silent and a real context change is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "context-audit", "run"] },
  "sam-loop-audit": { description: "The loop audit (sam loop-audit run): SAM's turn loop scored in code - the verification gate over a synthetic ledger, the chat-turn verification close (ledger bookkeeping plus one plain owner line), the repeated-failure repair guard (signature + stub), route-tiered budgets, the open-loop store coming due, and the honest budget / loader / retry endings - plus the live loop state (verification, open and due loops); recorded in .sam/loop-audit.db so loop changes are measured before/after; its text carries no clock reading so a held score stays P3-silent and a real loop change is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "loop-audit", "run"] },
  "sam-eval-battery": { description: "The behavior eval battery (sam eval-battery run): 27 realistic Dip tasks - inquiry questions counted honestly, memory recall inside its fences, gated proposals, coding tasks, honest-limit cases, and the Q2 answer judge over its fixed set - executed in code against the real machinery in scratch state, compared against the previous recorded run (improved / held / regressed); recorded in .sam/eval-battery.db so a prompt or harness change ships only if the battery improves or holds", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "eval-battery", "run"] },
  "sam-task-battery": { description: "The task battery (sam battery run): five fixed, versioned real jobs - research with citations, a multi-file coding job, an orchestration job with a build lane (a measured fail while the known unsafe-output weak spot stands), a memory do-not-store case, and a timed cold-chat question - executed in code against the real machinery in scratch homes, scored pass or fail with evidence; recorded in .sam/task-battery.db so whether Sam got better at real jobs is a number, and its scorecard text carries no clock or duration reading so a held score stays P3-silent", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "battery", "run"] },
  "sam-answer-judge": { description: "The answer judge trend (sam answer-judge scorecard): the Q2 judge's recorded verdicts as one plain-text scorecard - scored and malformed counts, mean overall, per-dimension means, weakest dimension, verdict counts - over .sam/answer-judge.jsonl; a pure read that spends no model call (judge runs stay the operator's --live act), and its text carries no clock reading so held scores stay P3-silent and a moved mean is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "answer-judge", "scorecard"] },
  "sam-deliveries-scorecard": { description: "The worthiness ledger trend (sam deliveries scorecard): every proactive delivery the S5 gate delivered or held, folded to counts only - assessments, delivered, held by reason class (duplicate / rate limit / law deny / law allowlist), per profile and per kind; a pure read that judges nothing new and spends no model call, and its text carries no stamp, fingerprint, preview, or law term so a day the gate judges nothing new stays P3-silent and the first held verdict is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "deliveries", "scorecard"] },
  "sam-auth-status": { description: "The auth status trend (sam models scorecard): the detected model routes, profile pins, configured providers, engine cli-reuse route, senses, and codex login state as one plain-text scorecard - healthy verdict, key env NAMES as present/absent (values never print), the setup baseline's currency, and each target's last probe bucket; a pure read that spends no model call (probing stays the operator's --live act), and its text carries no clock reading so a held install stays P3-silent and drift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "models", "scorecard"] },
  "sam-doctor": { description: "The doctor trend (sam doctor scorecard): the live stores' integrity, the daemon socket's staleness and modes, the env's completeness, the model endpoint's TCP reachability, the daemon version match, and the control token's form and mode as one plain-text scorecard - verdict, per-status counts, and one id: status line per check; a pure read that applies NO fix (sam doctor --fix stays the operator's act) and spends no model call (the model check is a TCP connect that sends no request and never uses the key), and its text carries no evidence, version, host, mode, or reason so a held install stays P3-silent and a flipped check is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "doctor", "scorecard"] },
  "sam-backup-drill": { description: "The backup restore drill (sam backup scorecard): the newest nightly state backup verified against its manifest (sha256 per file, integrity_check per database) and booted - the real stores opened on the extracted copy and counted - so a backup that no longer verifies or boots is found the next morning, not on restore day; recorded as one backup-drill ledger line with counts only, and its text carries no archive name and no clock reading so a held backup stays P3-silent and a drill failure is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "backup", "scorecard"] },
  "sam-self-work": { description: "The self-work loop (sam self-work work): SAM's activity ledger ranked as a defect queue in code, the top recurring defect written as a three-part spec (end goal / done looks like / not-done) grounded in the recorded capability self-audit - a spec touching the gate/policy/allowlist machinery is stamped owner-only and never queued, and a spec whose fix needs a door the audit reads cannot is stamped blocked; the recorded spec then queues as a gated coding task in the code workbench (one fix in flight), finished fixes land only as git-push proposals on the ONE approval gate, and each fix earns exactly one digest line; its text carries no clock reading so a held queue stays P3-silent and a moved count or a new spec is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "self-work", "work"] },
  "sam-stack-watch": { description: "The Nines stack watch (sam watches stack): candidates total, newest candidate, alert verdicts, and the entered paper-setups count - read through the Nines connector and counted in code, never by a model from a paged list; a full page reports a floor, never a fake exact count", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "watches", "stack"] },
  "sam-verify": { description: "The verify-on-stop trend (sam verify scorecard): the verification ledger, goldfish coverage, and the combined session gate folded to states and counts only - verification state, pending count, build/test-after-change, goldfish state with total and uncovered counts, session closable and outcome; a pure read that records nothing, runs no build or test, spends no model call, and never reviews (the approved test runner and `sam goldfish review` stay the operator's acts), and its text carries no clock reading, pending path, hash, gate reason, finding, or spec so a held state stays P3-silent and a flip is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "verify", "scorecard"] },
  "sam-outbox": { description: "The delivery outbox trend (sam heartbeats outbox-scorecard): the durable delivery queue every changed channel delivery passes through after the worthiness gate, folded to counts only - pending, delivered, suppressed, failed, recovered; a pure read that sends nothing, retries nothing, and settles nothing (redelivery rides the heartbeat tick), and its text carries no stamp, delivery text, job name, channel id, or reason so a day nothing moves stays P3-silent and the first pending, recovered, or failed delivery is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "heartbeats", "outbox-scorecard"] },
  "sam-actions": { description: "The approval gate trend (sam actions scorecard): the ONE gate's own queue folded to counts only - pending, done, rejected, failed, and pending per kind; a pure read that approves nothing, rejects nothing, and executes nothing (deciding stays the owner's act), and its text carries no stamp, title, detail, actor, or result so a day nothing is proposed or decided stays P3-silent and the first new pending proposal is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "actions", "scorecard"] },
  "sam-turn-failures": { description: "The turn failure trend (sam observe scorecard): the activity ledger's turn-failed lines folded to counts only - the total dead-turn count and counts per fixed reason bucket; a pure read that retries nothing and prints no reason (counting the class stays the seam's job, fixing it stays the work lane's), and its text carries no stamp, chat id, actor, or verbatim reason so a day no turn dies stays P3-silent and the first new dead turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "scorecard"] },
  "sam-heartbeat-failures": { description: "The heartbeat failure trend (sam heartbeats failure-scorecard): the activity ledger's heartbeat-failed lines folded to counts only - the total failed-job count, counts per fixed mode (agent, script, script-exit), and counts per fixed reason bucket; a pure read that retries nothing and prints no job name or reason (counting the class stays the isolation seam's job, fixing it stays the work lane's), and its text carries no stamp, job name, actor, or verbatim reason so a day no job dies stays P3-silent and the first new failed job is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "heartbeats", "failure-scorecard"] },
  "sam-tool-budget": { description: "The tool budget trend (sam observe budget-scorecard): the activity ledger's tool-budget lines folded to counts only - the total ended-turn count and counts per fixed end (calls, steps, other); a pure read that retries nothing and prints no tool name or summary (counting the class stays the budget seam's job, fixing it stays the work lane's), and its text carries no stamp, actor, tool name, or verbatim summary so a day no turn ends on budget stays P3-silent and the first new truncated turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "budget-scorecard"] },
  "sam-bridge-polls": { description: "The bridge poll trend (sam channels poll-scorecard): the activity ledger's bridge-poll-failed lines folded to counts only - the total failed-burst count and counts per fixed reason bucket (timeout, reset, http, network, other); a pure read that retries nothing and prints no channel name or reason (counting the class stays the bridge seam's job, fixing the network path stays the operator's call), and its text carries no stamp, channel name, actor, or verbatim reason so a day no poll fails stays P3-silent and the first new failed burst is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "channels", "poll-scorecard"] },
  "sam-message-failures": { description: "The queued message failure trend (sam observe message-scorecard): the activity ledger's message-failed lines folded to counts only - the total failed queued-turn count, the total failed-message count, and counts per fixed reason bucket; a pure read that retries or resends nothing and prints no chat id or reason (counting the class stays the queue drain's job, resending stays the owner's act), and its text carries no stamp, chat id, actor, or verbatim reason so a day no queued turn dies stays P3-silent and the first new failed queued turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "message-scorecard"] },
  "sam-turn-deadlines": { description: "The turn deadline trend (sam observe deadline-scorecard): the activity ledger's turn-deadline lines folded to counts only - the total deadline-hit turn count and the summed calls and rounds spent before the deadline; a pure read that retries nothing and prints no tool name or deadline (counting the class stays the turn control's job, moving the deadline stays the operator's act), and its text carries no stamp, actor, tool name, deadline reading, or verbatim summary so a day no turn hits its deadline stays P3-silent and the first new deadline-hit turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "deadline-scorecard"] },
  "sam-action-failures": { description: "The action failure trend (sam actions failure-scorecard): the activity ledger's failed lines folded to counts only - the total failed-action count, counts per action kind (the fixed ACTION_KINDS enum), and counts per fixed reason bucket (http, not-found, other); a pure read that retries or re-executes nothing and prints no title, detail, or reason (counting the class stays the decision seam's job, re-executing stays the owner's act), and its text carries no stamp, title, detail, actor, URL, or verbatim reason so a day no action fails stays P3-silent and the first new failed action is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "actions", "failure-scorecard"] },
  "sam-citation-rejections": { description: "The source citation rejection trend (sam observe citation-scorecard): the activity ledger's source-citation-rejected lines folded to counts only - the total replies-with-rejections count, the summed rejected citations, and the summed registered sources those replies were offered; a pure read that retries nothing and prints no source descriptor or summary (counting the class stays the citation pass's job, fixing a fabricating model stays the work lane's act), and its text carries no stamp, chat id, actor, source descriptor, or verbatim summary so a day no reply fabricates a citation stays P3-silent and the first new fabricated citation is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "citation-scorecard"] },
  "sam-source-citations": { description: "The source citation trend (sam observe source-scorecard): the activity ledger's source-citation lines folded to counts only - the total replies-with-sources count, the summed cited sources, the summed registered sources, and the distinct-chat count as a number only; a pure read that retries nothing and prints no chat id, source descriptor, or summary (counting the class stays the scorecard's job, attaching sources stays the turn's job), and its text carries no stamp, chat id, actor, source descriptor, or verbatim summary so a day no reply attaches sources stays P3-silent and a malformed line or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "source-scorecard"] },
  "sam-contacts": { description: "The contact trend (sam contacts scorecard): the activity ledger's contact lines folded to counts only on one line - the added, updated, and removed counts, the summed no-drafts count, and the total contact-line count; a pure read that touches no contact and prints no slug or summary (counting the class stays the scorecard's job, changing a contact stays the owner's act), and its text carries no stamp, actor, slug, or verbatim summary so a day no contact changes stays P3-silent and a malformed line or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "contacts", "scorecard"] },
  "sam-loop-checks": { description: "The loop check trend (sam observe loop-check-scorecard): the activity ledger's loop-check lines folded to counts only on one line - counts per fixed verification-state bucket (unverified, failed, other), the summed pending-file count, and the total closed-over-code turn count; a pure read that closes no turn and prints no path or summary (counting the class stays the scorecard's job, closing a turn stays the loops' job), and its text carries no stamp, actor, path, or verbatim summary so a day no turn closes over unverified or failed code stays P3-silent and a new short close or a malformed line is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "loop-check-scorecard"] },
  "sam-reasoning-leaks": { description: "The reasoning leak trend (sam observe reasoning-scorecard): the activity ledger's reasoning-leak-blocked lines folded to counts only - the total blocked-reply count, counts per fixed seam bucket (save, connector, own-tools, other), and counts per fixed signal; a pure read that retries nothing and prints no summary (counting the class stays the reply guard's job, fixing a narrating model stays the work lane's act), and its text carries no stamp, actor, or verbatim summary so a day no reply is blocked stays P3-silent and the first new blocked reply is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "reasoning-scorecard"] },
  "sam-loader-loops": { description: "The loader loop trend (sam observe loop-scorecard): the activity ledger's loader-loop and preparation-loop lines folded to counts only - the total stopped-turn count, counts per fixed kind (loader, preparation, other), and the summed calls the stopped turns spent; a pure read that retries nothing and prints no tool name or summary (counting the class stays the guard seam's job, fixing a looping chat stays the work lane's act), and its text carries no stamp, actor, tool name, or verbatim summary so a day no turn is stopped stays P3-silent and the first new stopped turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "loop-scorecard"] },
  "sam-narration": { description: "The narration withholding trend (sam observe narration-scorecard): the activity ledger's narration-channel lines folded to counts only - the total withheld-turn count and the summed withheld rounds and chars; a pure read that retries nothing and prints no chat id or summary (counting the class stays the narration channel's job, quieting a narrating model stays the work lane's act), and its text carries no stamp, actor, chat id, or verbatim summary so a day no narration is withheld stays P3-silent and the first new withholding is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "narration-scorecard"] },
  "sam-tripwires": { description: "The turn-economy tripwire trend (sam observe tripwire-scorecard): the activity ledger's spelunk-tripwire and research-tripwire lines folded to counts only - the total tripped-turn count, counts per fixed wire (spelunk, research, other), and the summed calls at trip; a pure read that retries nothing and prints no summary (counting the class stays the scorecard's job, steering a tripped turn stays the guard's job), and its text carries no stamp, actor, or verbatim summary so a day no wire trips stays P3-silent and the first new tripped turn is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "tripwire-scorecard"] },
  "sam-scratch-refusals": { description: "The scratch-write refusal trend (sam observe scratch-scorecard): the activity ledger's scratch-write-refused lines folded to counts only - the total refused-write count and counts per fixed extension bucket (py, sh, js, mjs, cjs, other); a pure read that retries nothing and prints no path or summary (counting the class stays the scorecard's job, refusing a scratch write stays the guard's job), and its text carries no stamp, actor, path, or verbatim summary so a day no write is refused stays P3-silent and the first refusal is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "scratch-scorecard"] },
  "sam-compactions": { description: "The compaction trend (sam compaction scorecard): the activity ledger's compaction lines folded to counts only - the total fold count, counts per fixed route bucket (flushed, visitor, other), and the summed folded and kept-verbatim counts; a pure read that folds nothing and prints no chat id or summary (counting the class stays the scorecard's job, folding a chat stays compaction's job), and its text carries no stamp, actor, chat id, or verbatim summary so a day no chat folds stays P3-silent and the first new fold is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "compaction", "scorecard"] },
  "sam-python-runs": { description: "The Python run trend (sam code python-scorecard): the activity ledger's python-run lines folded to counts only - the total run count, counts per fixed outcome bucket (ok, failed, refused, other), sandbox runs, pass-through runs, and timed-out runs; a pure read that runs nothing and prints no hash, path, sandbox name, pass-through name, or summary (counting the class stays the scorecard's job, running Python stays the runner's job), and its text carries no stamp, actor, hash, path, or verbatim summary so a day no run goes wrong stays P3-silent and the first bad run is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "code", "python-scorecard"] },
  "sam-reach": { description: "The reach trend (sam reach scorecard): the activity ledger's reach lines folded to counts only - the total call count, counts per fixed action bucket (search, read, other), distinct channel and action counts as numbers only, and the no-query call count; a pure read that reaches for nothing and prints no channel name or any part of a query, and claims nothing about call outcomes, which the ledger line does not carry (counting the class stays the scorecard's job, reaching stays runReach's job), and its text carries no stamp, actor, channel name, or query so a quiet day stays P3-silent and a malformed line or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "reach", "scorecard"] },
  "sam-code-writes": { description: "The code-write trend (sam code write-scorecard): the activity ledger's code-write lines folded to counts only - the total write count, counts per fixed kind bucket (created, edited, other), summed added and removed lines, and the distinct-file count as a number only; a pure read that writes nothing and prints no path or summary (counting the class stays the scorecard's job, writing stays the C1 hands' job), and its text carries no stamp, actor, path, or verbatim summary so a quiet day stays P3-silent and a malformed line, a mix shift, or a churn spike is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "code", "write-scorecard"] },
  "sam-code-runs": { description: "The code-run trend (sam code run-scorecard): the activity ledger's code-run lines folded to counts only - the total run count, counts per fixed outcome bucket (ok, failed, error, other), timed-out runs, and the distinct-command count as a number only; a pure read that runs nothing and prints no command name or summary (counting the class stays the scorecard's job, running commands stays the C2 verify hands' job), and its text carries no stamp, actor, command name, or verbatim summary so a day no run goes wrong stays P3-silent and the first bad run is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "code", "run-scorecard"] },
  "sam-skill-uses": { description: "The skill-use trend (sam skills use-scorecard): the activity ledger's skill-use lines folded to counts only - the total use count, distinct skill and chat counts as numbers only, and the no-chat use count; a pure read that reads no skill and prints no skill name or chat id (counting the class stays the scorecard's job, recording a use stays recordSkillUse's job), and its text carries no stamp, actor, skill name, chat id, or verbatim summary so a day no skill is used stays P3-silent and a malformed line, a mix shift, or auto-selection going silent is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "skills", "use-scorecard"] },
  "sam-subagents": { description: "The sub-agent trend (sam subagent scorecard): the activity ledger's subagent-spawn, subagent-done, subagent-failed, and subagent-folded lines folded to counts only - counts per lifecycle stage and the distinct-child count as a number only; a pure read that spawns nothing and prints no child id, role, chat id, result, or reason (counting the class stays the scorecard's job, spawning a helper stays the turn's job), and its text carries no stamp, actor, child id, role, chat id, or verbatim summary so a day no helper runs stays P3-silent and a failed child, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "subagent", "scorecard"] },
  "sam-coding": { description: "The coding-task trend (sam coding scorecard): the activity ledger's coding-queued, coding-started, coding-done, coding-blocked, coding-failed, and coding-review lines folded to counts only - counts per lifecycle stage, the done split with summed verified files and iterations, blocked counts per fixed reason bucket, review counts per verdict bucket, and the distinct-task count as a number only; a pure read that queues or drains nothing and prints no title, reason, or finding (counting the class stays the scorecard's job, running coding work stays the loop's job), and its text carries no stamp, actor, title, or verbatim summary so a quiet day stays P3-silent and a blocked or failed task, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "coding", "scorecard"] },
  "sam-history-trims": { description: "The history trim trend (sam observe history-scorecard): the activity ledger's turn-history-trimmed lines folded to counts only on one line - the trimmed-turn count, the summed folded rounds, and the total; a pure read that trims nothing and prints no summary (counting the class stays the scorecard's job, trimming a turn stays the loops' job), and its text carries no stamp, actor, or verbatim summary so a day no turn outgrows the request window stays P3-silent and a malformed line or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "history-scorecard"] },
  "sam-corrections": { description: "The correction trend (sam observe correction-scorecard): the activity ledger's correction lines folded to counts only on one line - the proposed count, the distinct-rule count as a number only, and the total; a pure read that proposes nothing and prints no rule statement (counting the class stays the scorecard's job, routing a correction stays the gate's job), and its text carries no stamp, actor, or verbatim summary so a day no correction lands stays P3-silent and a new correction, a repeat rule, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "correction-scorecard"] },
  "sam-provider-retries": { description: "The provider-retry trend (sam observe provider-scorecard): the activity ledger's provider-retry lines folded to counts only on one line - the parsed retry count, counts per fixed status bucket (overload 5xx, rate-limit 429, other), the distinct-chat count as a number only, the summed backoff ms, and the total; a pure read that retries nothing and prints no chat id or summary (counting the class stays the scorecard's job, riding out a transient failure stays the provider's job), and its text carries no stamp, actor, chat id, or verbatim summary so a day no turn retries stays P3-silent and a new provider hiccup, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "provider-scorecard"] },
  "sam-turn-resets": { description: "The turn-reset trend (sam observe reset-scorecard): the activity ledger's turn-reset lines folded to counts only on one line - the parsed reset count, the summed in-flight requests aborted, the summed queued messages cancelled, the summed stopped seconds, the distinct-chat count as a number only, and the total; a pure read that resets nothing and prints no chat id or summary (counting the class stays the scorecard's job, stopping a turn stays the owner's Reset press), and its text carries no stamp, actor, chat id, or verbatim summary so a day no owner stops a turn stays P3-silent and a new Reset press, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "reset-scorecard"] },
  "sam-suppressions": { description: "The capture-guard suppression trend (sam observe suppression-scorecard): the activity ledger's memory-suppression and memory-suppressed lines folded to counts only on one line - the parsed recorded count, the summed already-matching records awaiting the owner's purge decision, the blocked-write count with counts per fixed via bucket (episodes, compaction, other), the distinct-profile count as a number only, and the total; a pure read that suppresses nothing and prints no profile name, needle, fingerprint, suppression id, or summary (counting the class stays the scorecard's job, holding a write stays the guard's job), and its text carries no stamp, actor, profile name, needle, fingerprint, suppression id, or verbatim summary so a day the guard neither gains a suppression nor holds a write stays P3-silent and a new suppression, a held write, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "suppression-scorecard"] },
  "sam-turn-costs": { description: "The turn-cost trend (sam observe turn-cost-scorecard): the activity ledger's turn-cost lines folded to counts only on one line - the parsed large-turn count, the summed tool calls and rounds from the lines' headers, the largest turn's call count, and the distinct-tool count as a number only; a pure read that runs no turn and prints no tool name or summary (counting the class stays the scorecard's job, spending the calls stays the turn's job), and its text carries no stamp, actor, tool name, or verbatim summary so a day no turn runs large stays P3-silent and a new large turn, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "observe", "turn-cost-scorecard"] },
  "sam-orchestration": { description: "The orchestration trend (sam orchestrate scorecard): the activity ledger's orchestration-planned, orchestration-hired, orchestration-lane-done, orchestration-lane-replaced, orchestration-lane-failed, and orchestration-job-done lines folded to counts only - counts per lifecycle stage, the summed planned lanes, the summed verified-of-total lanes at close, closed counts per fixed status bucket, and the distinct-job count as a number only; a pure read that plans or runs nothing and prints no job id, lane name, or failure (counting the class stays the scorecard's job, running a job stays the door's job), and its text carries no stamp, actor, job id, lane name, or verbatim summary so a quiet day stays P3-silent and a dead or replaced lane, a job that closed short of done, a malformed line, or a mix shift is the news", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "orchestrate", "scorecard"] },
};
export function scriptCommandNames(): string[] { return Object.keys(SCRIPT_JOB_COMMANDS); }
export function scriptArgv(root: string, name: string): string[] {
  const cmd = SCRIPT_JOB_COMMANDS[name];
  if (!cmd) throw new Error("Unknown script '" + name + "'. Allowlisted scripts: " + scriptCommandNames().join(", "));
  return cmd.argv(root);
}

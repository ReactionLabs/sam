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
  "sam-self-audit": { description: "The capability self-audit (sam self-audit run): SAM's own tools, connectors, code root, gates, engine, senses, skills, and channels inventoried in code, with what he can and cannot do and the reason for every cannot - the SELF-WORK program's step 0 map, recorded in .sam/self-audit.db", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "self-audit", "run"] },
  "sam-self-work": { description: "The self-work spec picker (sam self-work run): SAM's activity ledger ranked as a defect queue in code, the top recurring defect written as a three-part spec (end goal / done looks like / not-done) grounded in the recorded capability self-audit - a spec touching the gate/policy/allowlist machinery is stamped owner-only and a spec whose fix needs a door the audit reads cannot is stamped blocked; it writes specs only, fixes nothing, and queues nothing", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "self-work", "run"] },
  "sam-stack-watch": { description: "The Nines stack watch (sam watches stack): candidates total, newest candidate, alert verdicts, and the entered paper-setups count - read through the Nines connector and counted in code, never by a model from a paged list; a full page reports a floor, never a fake exact count", argv: (root) => [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "--workspace", root, "watches", "stack"] },
};
export function scriptCommandNames(): string[] { return Object.keys(SCRIPT_JOB_COMMANDS); }
export function scriptArgv(root: string, name: string): string[] {
  const cmd = SCRIPT_JOB_COMMANDS[name];
  if (!cmd) throw new Error("Unknown script '" + name + "'. Allowlisted scripts: " + scriptCommandNames().join(", "));
  return cmd.argv(root);
}

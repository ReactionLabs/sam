import test from "node:test";
import assert from "node:assert/strict";
import { compileSchedule, cronMatchesAt, nextCronRun, parseCron, validateTimezone } from "./schedule.js";

test("cron parsing: fields, lists, ranges, steps, and names", () => {
  const f = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
  assert.deepEqual([...f.minute], [0, 15, 30, 45]);
  assert.deepEqual([...f.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...f.dom], [1, 15]);
  assert.deepEqual([...f.month], [1, 2, 3]);
  assert.deepEqual([...f.dow], [1, 2, 3, 4, 5]);
  assert.equal(f.domRestricted, true);
  assert.equal(f.dowRestricted, true);
  // Day-of-week 7 is Sunday, same as 0.
  assert.deepEqual([...parseCron("0 0 * * 7").dow], [0]);
  assert.throws(() => parseCron("61 * * * *"), /out of range/);
  assert.throws(() => parseCron("* * * *"), /exactly 5 fields/);
  assert.throws(() => parseCron("x * * * *"), /Invalid cron field value/);
});

test("nextCronRun: daily wall clock in the job's own timezone", () => {
  // 2026-11-09T12:00Z is 07:00 in New York (EST, UTC-5): the next
  // 9am local is today at 14:00Z.
  const next = nextCronRun("0 9 * * *", "America/New_York", new Date("2026-11-09T12:00:00Z"));
  assert.equal(next?.toISOString(), "2026-11-09T14:00:00.000Z");
  // Strictly after: asking at exactly 9am local gives tomorrow.
  const after = nextCronRun("0 9 * * *", "America/New_York", new Date("2026-11-09T14:00:00Z"));
  assert.equal(after?.toISOString(), "2026-11-10T14:00:00.000Z");
  assert.equal(nextCronRun("0 9 * * *", "UTC", new Date("2026-11-09T12:00:00Z"))?.toISOString(), "2026-11-10T09:00:00.000Z");
});

test("nextCronRun: a 9am job stays at 9am across the spring DST jump", () => {
  // US DST 2027: springs forward Sun 2027-03-14 (EST -> EDT).
  const sat = nextCronRun("0 9 * * *", "America/New_York", new Date("2027-03-13T13:00:00Z")); // Sat 08:00 EST
  assert.equal(sat?.toISOString(), "2027-03-13T14:00:00.000Z"); // Sat 9am EST
  const sun = nextCronRun("0 9 * * *", "America/New_York", new Date(sat!.getTime()));
  assert.equal(sun?.toISOString(), "2027-03-14T13:00:00.000Z"); // Sun 9am EDT - one hour earlier in UTC, same wall clock
  const mon = nextCronRun("0 9 * * *", "America/New_York", new Date(sun!.getTime()));
  assert.equal(mon?.toISOString(), "2027-03-15T13:00:00.000Z");
  // A time inside the skipped hour (2:30am on jump day) never fires that day.
  const gap = nextCronRun("30 2 * * *", "America/New_York", new Date("2027-03-13T12:00:00Z"));
  assert.equal(gap?.toISOString(), "2027-03-15T06:30:00.000Z"); // Mon 2:30 EDT
});

test("nextCronRun: weekday, monthly, and dom/dow OR semantics", () => {
  // 2026-11-09 is a Monday. Weekdays-only from Monday 10am UTC -> Tuesday 9am.
  assert.equal(nextCronRun("0 9 * * 1-5", "UTC", new Date("2026-11-09T10:00:00Z"))?.toISOString(), "2026-11-10T09:00:00.000Z");
  // From Friday 10am -> Monday 9am.
  assert.equal(nextCronRun("0 9 * * 1-5", "UTC", new Date("2026-11-13T10:00:00Z"))?.toISOString(), "2026-11-16T09:00:00.000Z");
  // Monthly on the 1st.
  assert.equal(nextCronRun("0 9 1 * *", "UTC", new Date("2026-11-09T10:00:00Z"))?.toISOString(), "2026-12-01T09:00:00.000Z");
  // Both dom and dow restricted: EITHER matches (the 15th OR any Monday).
  assert.equal(nextCronRun("0 9 15 * 1", "UTC", new Date("2026-11-09T10:00:00Z"))?.toISOString(), "2026-11-15T09:00:00.000Z");
  assert.equal(cronMatchesAt("0 9 15 * 1", "UTC", new Date("2026-11-16T09:00:00Z")), true); // Monday the 16th
  assert.equal(cronMatchesAt("0 9 15 * 1", "UTC", new Date("2026-11-17T09:00:00Z")), false);
  // Feb 29 exists inside the horizon.
  assert.equal(nextCronRun("0 12 29 2 *", "UTC", new Date("2027-01-01T00:00:00Z"))?.toISOString(), "2028-02-29T12:00:00.000Z");
});

test("compileSchedule: intervals, wall clock, natural language, raw cron", () => {
  assert.deepEqual(compileSchedule("every 30 minutes"), { kind: "interval", minutes: 30, cron: null, onceAt: null });
  assert.deepEqual(compileSchedule("every 2 hours"), { kind: "interval", minutes: 120, cron: null, onceAt: null });
  assert.deepEqual(compileSchedule("every hour"), { kind: "interval", minutes: 60, cron: null, onceAt: null });
  assert.throws(() => compileSchedule("every 2 minutes"), /5 to 10080/);
  assert.deepEqual(compileSchedule("daily at 9am"), { kind: "cron", minutes: null, cron: "0 9 * * *", onceAt: null });
  assert.deepEqual(compileSchedule("daily at 9:30pm"), { kind: "cron", minutes: null, cron: "30 21 * * *", onceAt: null });
  assert.deepEqual(compileSchedule("daily"), { kind: "cron", minutes: null, cron: "0 9 * * *", onceAt: null });
  assert.deepEqual(compileSchedule("weekdays at 8:30am"), { kind: "cron", minutes: null, cron: "30 8 * * 1-5", onceAt: null });
  assert.deepEqual(compileSchedule("every monday at 9am"), { kind: "cron", minutes: null, cron: "0 9 * * 1", onceAt: null });
  assert.deepEqual(compileSchedule("weekly on friday at 17:00"), { kind: "cron", minutes: null, cron: "0 17 * * 5", onceAt: null });
  assert.deepEqual(compileSchedule("monthly on the 1st at 9am"), { kind: "cron", minutes: null, cron: "0 9 1 * *", onceAt: null });
  assert.deepEqual(compileSchedule("at 14:00"), { kind: "cron", minutes: null, cron: "0 14 * * *", onceAt: null });
  assert.deepEqual(compileSchedule("0 9 * * 1-5"), { kind: "cron", minutes: null, cron: "0 9 * * 1-5", onceAt: null });
  assert.deepEqual(compileSchedule("0 9 * * mon-fri"), { kind: "cron", minutes: null, cron: "0 9 * * mon-fri", onceAt: null });
  assert.throws(() => compileSchedule("whenever it feels right"), /Cannot read the schedule/);
  assert.throws(() => compileSchedule("daily at teatime"), /Cannot read the time/);
});

test("validateTimezone: IANA names pass, junk refuses", () => {
  assert.equal(validateTimezone("America/New_York"), "America/New_York");
  assert.equal(validateTimezone("UTC"), "UTC");
  assert.throws(() => validateTimezone("Mars/Olympus"), /Unknown timezone/);
  assert.throws(() => validateTimezone("not a zone"), /Invalid timezone/);
});

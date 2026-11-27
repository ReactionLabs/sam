import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timezoneBlocker, timezoneNames, validateTimezone } from "./schedule.js";
import { addScheduledJob, heartbeatJobs } from "./heartbeat.js";

// The timezone gate: a job's timezone is a registry name
// (the platform's IANA list plus "UTC") that a person
// picks at the schedule doors. The ONE seam every
// schedule rides, validateTimezone in schedule.ts,
// refused a bad name in two improvised pieces - a name
// failing the shape regex died on "Invalid timezone (use
// an IANA name like America/New_York): X", a well-shaped
// unknown name died on "Unknown timezone: X" - neither
// offering a fold correction, so a separator-folded name
// ("America/New York", "america-new-york") dead-ended.
// timezoneBlocker in schedule.ts is now the ONE source
// carrying the refusal text; validateTimezone throws it
// before any schedule is compiled or stored. Stored job
// timezones stay permissive by design (jobNextRun falls
// back per its own rules).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-timezone-gate-")); }

test("timezone gate: real IANA names and UTC read no blocker", () => {
  assert.equal(timezoneBlocker("America/New_York"), null);
  assert.equal(timezoneBlocker("Europe/London"), null);
  assert.equal(timezoneBlocker("UTC"), null);
  assert.equal(validateTimezone("America/New_York"), "America/New_York");
});

test("timezone gate: the registry is the platform IANA list plus UTC", () => {
  const names = timezoneNames();
  assert.ok(names.includes("America/New_York"));
  assert.ok(names.includes("UTC"));
  assert.ok(names.length > 400);
  // Folded for case and separators the registry has no
  // collisions, so a fold correction is never ambiguous.
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  assert.equal(new Set(names.map(fold)).size, names.length);
});

test("timezone gate: an unknown zone names the IANA form, no correction", () => {
  assert.equal(
    timezoneBlocker("Mars/Olympus"),
    "Unknown timezone \"Mars/Olympus\". Timezones are IANA names (like America/New_York)",
  );
  assert.equal(
    timezoneBlocker("not a zone"),
    "Unknown timezone \"not a zone\". Timezones are IANA names (like America/New_York)",
  );
});

test("timezone gate: a separator-folded name is refused with the correction", () => {
  assert.match(timezoneBlocker("America/New York")!, /Did you mean "America\/New_York"\?$/);
  assert.match(timezoneBlocker("america-new-york")!, /Did you mean "America\/New_York"\?$/);
  assert.match(timezoneBlocker("AMERICA NEW YORK")!, /Did you mean "America\/New_York"\?$/);
  assert.match(timezoneBlocker("America_New_York")!, /Did you mean "America\/New_York"\?$/);
});

test("timezone gate: names Intl itself resolves read no blocker, as before", () => {
  // Intl resolves timezone names case-insensitively and
  // accepts aliases the supported-values list omits; the
  // gate never narrows what already worked.
  assert.equal(timezoneBlocker("america/new_york"), null);
  assert.equal(timezoneBlocker("AMERICA/NEW_YORK"), null);
  assert.equal(timezoneBlocker("US/Eastern"), null);
  assert.equal(timezoneBlocker("Asia/Kolkata"), null);
  assert.equal(validateTimezone("america/new_york"), "america/new_york");
});

test("timezone gate: a non-string or empty value refuses with no correction", () => {
  assert.equal(timezoneBlocker(42), "Unknown timezone \"42\". Timezones are IANA names (like America/New_York)");
  assert.equal(timezoneBlocker(""), "Unknown timezone \"\". Timezones are IANA names (like America/New_York)");
  assert.equal(timezoneBlocker(undefined), "Unknown timezone \"undefined\". Timezones are IANA names (like America/New_York)");
});

test("timezone gate: the seam throws the ONE source and stores no job", () => {
  const root = fresh();
  try {
    assert.throws(
      () => validateTimezone("america-new-york"),
      /Unknown timezone "america-new-york"\. Timezones are IANA names \(like America\/New_York\)\. Did you mean "America\/New_York"\?$/,
    );
    assert.throws(
      () => addScheduledJob(root, { name: "badtz", profile: "trading", schedule: "daily at 9am", timezone: "America/New York", prompt: "x" }),
      /Did you mean "America\/New_York"\?$/,
    );
    assert.equal(heartbeatJobs(root).length, 0);
    const job = addScheduledJob(root, { name: "goodtz", profile: "trading", schedule: "daily at 9am", timezone: "America/New_York", prompt: "x" });
    assert.equal(job.timezone, "America/New_York");
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

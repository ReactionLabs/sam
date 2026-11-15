import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  bindEvent, eventBindings, eventFailureSummary, isEventLedgered,
  readEventStore, unbindEvent, updateEventBinding,
} from "./events.js";
import { classifyDefect } from "./self-work.js";

// Event store failure visibility (gap found 2026-11-14,
// hourly run 20:04): the event store is the signed-webhook
// door's registry - every binding's profile and secret env
// name, plus the seen-id dedupe set - and every touch opened
// it raw: a dead events.db threw into whichever catch wrapped
// the call (the door server dresses it as a generic 502),
// none naming the store. Each touch now ledgers ONE
// event-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// the door still fails closed (never folded as no bindings,
// which would silently close every signed door).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-events-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "event-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "events.db"), { force: true });
  mkdirSync(join(root, ".sam", "events.db"), { recursive: true });
}

const BINDING = { name: "lead-arrived", profile: "dip", secretEnv: "SAM_EVENT_SECRET_LEAD" };

test("event-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(eventFailureSummary("read", "unable to open\n  database   file"), "Event read failed: unable to open database file");
  assert.equal(eventFailureSummary("write", "disk gone"), "Event write failed: disk gone");
  assert.equal(eventFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "event-failed", summary: eventFailureSummary(phase, "boom") }),
      { key: "event-failed:" + phase, label: "event store failures (" + phase + " step)" },
    );
  }
});

test("event-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    bindEvent(root, BINDING);
    plantDeadStore(root);

    assert.throws(() => eventBindings(root), (e: unknown) => isEventLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Event read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "event-failed:read", label: "event store failures (read step)" });

    assert.throws(() => readEventStore(root), (e: unknown) => isEventLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the snapshot touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Event read failed: "), lines[1].summary);

    assert.throws(() => bindEvent(root, { name: "other", profile: "dip", secretEnv: "SAM_EVENT_SECRET_OTHER" }), (e: unknown) => isEventLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "a bind over a dead store ledgers exactly one line total");
    assert.ok(lines[2].summary.startsWith("Event write failed: "), lines[2].summary);

    assert.throws(() => unbindEvent(root, "lead-arrived"), (e: unknown) => isEventLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the unbind touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Event write failed: "), lines[3].summary);

    assert.throws(() => updateEventBinding(root, "lead-arrived", { profile: "sam" }), (e: unknown) => isEventLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the update touch ledgers exactly one more line");
    assert.ok(lines[4].summary.startsWith("Event write failed: "), lines[4].summary);

    assert.ok(!JSON.stringify(lines).includes("lead-arrived"), "no binding name ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("SAM_EVENT_SECRET"), "no secret env name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event-failed: an absent store reads as no bindings, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(eventBindings(root), []);
    assert.deepEqual(readEventStore(root), { bindings: [], seenIds: [] });
    assert.equal(unbindEvent(root, "nope"), false);
    assert.equal(updateEventBinding(root, "nope", { profile: "sam" }), null);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => bindEvent(root, { name: "Bad Name!", profile: "dip", secretEnv: "SAM_EVENT_SECRET_X" }), /Invalid event name/);
    assert.throws(() => bindEvent(root, { name: "fine", profile: "Bad Profile!", secretEnv: "SAM_EVENT_SECRET_X" }), /Invalid profile/);
    assert.throws(() => bindEvent(root, { name: "fine", profile: "dip", secretEnv: "lowercase_env" }), /secretEnv must be/);
    bindEvent(root, BINDING);
    assert.throws(() => bindEvent(root, BINDING), /already exists/);
    assert.throws(() => updateEventBinding(root, "lead-arrived", { profile: "Bad Profile!" }), /Invalid profile/);
    assert.throws(() => updateEventBinding(root, "lead-arrived", { secretEnv: "lowercase_env" }), /secretEnv must be/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event-failed: a healthy store binds, reads, updates, and unbinds with zero failure lines", () => {
  const root = scratch();
  try {
    const bound = bindEvent(root, BINDING);
    assert.deepEqual(eventBindings(root), [bound]);
    assert.deepEqual(readEventStore(root), { bindings: [bound], seenIds: [] });
    const updated = updateEventBinding(root, "lead-arrived", { profile: "sam" });
    assert.equal(updated?.profile, "sam");
    assert.equal(updateEventBinding(root, "ghost", { profile: "sam" }), null);
    assert.equal(unbindEvent(root, "lead-arrived"), true);
    assert.deepEqual(eventBindings(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    bindEvent(root, BINDING);
    const raw = openDatabase(join(root, ".sam", "events.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON event_bindings BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => bindEvent(root, { name: "other", profile: "dip", secretEnv: "SAM_EVENT_SECRET_OTHER" }), (e: unknown) => isEventLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Event write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

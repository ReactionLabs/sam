import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptEvent, bindEvent, eventBindingBlocker, eventBindings } from "./events.js";

// The binding-name gate for the CLI event accept door:
// every other naming door reads its registry through a
// ONE source in its owning module before acting - but
// CLI `events accept <name>` resolved the name through
// its own inline find and on a miss threw the bare
// "Unknown event", not even echoing the name it was
// given, naming no registry, and offering no fold
// correction, so a folded name ("Lead Arrived" for
// "lead-arrived") dead-ended with nothing to act on.
// eventBindingBlocker in events.ts is now the ONE source
// carrying the refusal text: the CLI accept door throws
// it before reading the secret env or signing anything.
// acceptEvent's webhook 404 keeps the bare text BY
// DESIGN (an unauthenticated network caller gets no
// registry enumeration), and eventBindings / the event
// store stay permissive by design, so neither is gated
// here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-event-binding-gate-")); }

function bind(root: string, name: string): void {
  bindEvent(root, { name, profile: "sam", secretEnv: "SAM_EVENT_TEST_SECRET" });
}

test("event binding gate: a bound name reads no blocker", () => {
  const root = fresh();
  try {
    bind(root, "lead-arrived");
    assert.equal(eventBindingBlocker(root, "lead-arrived"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event binding gate: an unknown name names the registry, and an empty registry reads none", () => {
  const root = fresh();
  try {
    assert.equal(
      eventBindingBlocker(root, "lead-arrived"),
      "Unknown event \"lead-arrived\". Bound events: none",
    );
    bind(root, "lead-arrived");
    assert.equal(
      eventBindingBlocker(root, "nosuchevent"),
      "Unknown event \"nosuchevent\". Bound events: lead-arrived",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event binding gate: a folded name is refused with the correction", () => {
  const root = fresh();
  try {
    bind(root, "lead-arrived");
    assert.equal(
      eventBindingBlocker(root, "Lead Arrived"),
      "Unknown event \"Lead Arrived\". Bound events: lead-arrived. Did you mean \"lead-arrived\"?",
    );
    assert.equal(
      eventBindingBlocker(root, "LEAD_ARRIVED"),
      "Unknown event \"LEAD_ARRIVED\". Bound events: lead-arrived. Did you mean \"lead-arrived\"?",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event binding gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    bind(root, "lead-arrived");
    bind(root, "lead_arrived");
    assert.equal(
      eventBindingBlocker(root, "Lead Arrived"),
      "Unknown event \"Lead Arrived\". Bound events: lead-arrived, lead_arrived",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event binding gate: the door's check accepts nothing and changes no binding", () => {
  const root = fresh();
  try {
    bind(root, "lead-arrived");
    const blocker = eventBindingBlocker(root, "Lead Arrived");
    assert.ok(blocker);
    // The door throws this text before calling acceptEvent;
    // pin that the check alone leaves the registry as it was.
    assert.deepEqual(eventBindings(root).map(b => b.name), ["lead-arrived"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event binding gate: the webhook door keeps the bare 404 with no registry leak", async () => {
  const root = fresh();
  try {
    bind(root, "lead-arrived");
    const result = await acceptEvent(root, { name: "Lead Arrived", rawBody: "{}", signature: "deadbeef" });
    assert.equal(result.status, 404);
    assert.equal(result.error, "Unknown event");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

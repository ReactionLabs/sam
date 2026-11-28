import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindEvent, eventBindings, eventUnbindBlocker, findEventBinding, unbindEvent, type EventBinding } from "./events.js";

// The event gate for the events unbind door: bindings are
// listed by name, but `sam events unbind <name>` rode
// unbindEvent alone and carried no description, so an
// unknown name - or a real binding name typed folded
// ("Lead Arrived" for "lead-arrived") - silently returned
// {removed:false}, naming nothing, at the door that closes
// a signed webhook door: an unbind the owner believes
// landed leaves the door open, and one that never existed
// reads exactly the same. The name IS the key, so the
// registry the blocker names is the bindings themselves,
// each described ONLY by name and profile - a binding's
// secret env name is door data by this module's own
// failure discipline and never enters a refusal. The CLI
// unbind door now resolves through findEventBinding
// (throwing eventUnbindBlocker, the ONE source over the
// event bindings registry alone for this door, before
// anything is removed) and removes by the resolved name;
// unbindEvent keeps its boolean contract (false on a
// miss) for internal callers - the store seam stays
// permissive by design.

function fresh(): { root: string; first: EventBinding; second: EventBinding } {
  const root = mkdtempSync(join(tmpdir(), "sam-event-unbind-gate-"));
  const first = bindEvent(root, { name: "lead-arrived", profile: "sam", secretEnv: "SAM_EVENT_LEAD_SECRET" });
  const second = bindEvent(root, { name: "deploy-done", profile: "trading", secretEnv: "SAM_EVENT_DEPLOY_SECRET" });
  return { root, first, second };
}

function describe(b: EventBinding): string {
  return b.name + " (profile " + b.profile + ")";
}

test("event unbind gate: an exact name reads no blocker and removes by the resolved name", () => {
  const { root, first } = fresh();
  try {
    assert.equal(eventUnbindBlocker(root, first.name), null);
    const resolved = findEventBinding(root, first.name);
    assert.equal(resolved.name, first.name);
    assert.equal(unbindEvent(root, resolved.name), true);
    assert.deepEqual(eventBindings(root).map(b => b.name), ["deploy-done"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: a folded name is refused with the correction, removes nothing, and names no secret env", () => {
  const { root, first, second } = fresh();
  try {
    const blocker = eventUnbindBlocker(root, "Lead Arrived")!;
    assert.equal(
      blocker,
      "Event binding not found: \"Lead Arrived\". Event bindings: "
        + describe(first) + ", " + describe(second)
        + ". Did you mean \"lead-arrived\"?",
    );
    assert.doesNotMatch(blocker, /SAM_EVENT|SECRET/);
    assert.throws(() => findEventBinding(root, "Lead Arrived"), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.equal(eventBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: an upper-case folded name corrects the same way", () => {
  const { root, second } = fresh();
  try {
    const blocker = eventUnbindBlocker(root, "DEPLOY-DONE")!;
    assert.match(blocker, new RegExp("\\. Did you mean \"" + second.name + "\"\\?$"));
    assert.equal(eventBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: an unknown name names the registry with no correction", () => {
  const { root, first, second } = fresh();
  try {
    const blocker = eventUnbindBlocker(root, "ghost")!;
    assert.equal(
      blocker,
      "Event binding not found: \"ghost\". Event bindings: " + describe(first) + ", " + describe(second),
    );
    assert.throws(() => findEventBinding(root, "ghost"));
    assert.equal(eventBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-event-unbind-gate-"));
  try {
    assert.equal(eventUnbindBlocker(root, "ghost"), "Event binding not found: \"ghost\". Event bindings: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-event-unbind-gate-"));
  try {
    bindEvent(root, { name: "a.bc", profile: "sam", secretEnv: "SAM_EVENT_A_SECRET" });
    bindEvent(root, { name: "a-bc", profile: "sam", secretEnv: "SAM_EVENT_B_SECRET" });
    const blocker = eventUnbindBlocker(root, "A BC")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(eventBindings(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event unbind gate: the store seam keeps its boolean contract", () => {
  const { root, first } = fresh();
  try {
    assert.equal(unbindEvent(root, "nope"), false);
    assert.equal(unbindEvent(root, first.name), true);
    assert.equal(unbindEvent(root, first.name), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

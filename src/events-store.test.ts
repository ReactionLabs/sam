import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptEvent, bindEvent, eventBindings, readEventStore, signEvent, unbindEvent, updateEventBinding, type EventBinding } from "./events.js";
import type { TurnRoute } from "./budgets.js";

// State convergence (UNIFICATION item 4, twenty-sixth store): the
// event door's two stores migrated from whole-file rewrites
// (event-bindings.json + event-ids.json) to one SQLite store.
// These tests pin the migration contract: legacy files import in
// order with every field intact, are renamed (never deleted), a
// malformed file imports nothing and stays put (reading as no
// bindings instead of throwing), a pure read creates nothing,
// single-row mutations cannot lose each other, and the dedupe
// guard resolves through the migrated store with the 500-id
// prune keeping exactly the newest ids.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-events-store-")); }

const LEADS: EventBinding = { name: "leads", profile: "sam", secretEnv: "SAM_EVENT_LEADS" };
const DEPLOYS: EventBinding = { name: "deploys", profile: "trading", secretEnv: "SAM_EVENT_DEPLOYS" };

test("events store: legacy bindings and seen ids import in order, fields intact, files renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "event-bindings.json"), JSON.stringify([LEADS, DEPLOYS], null, 2));
    writeFileSync(join(root, ".sam", "event-ids.json"), JSON.stringify(["leads:lead-1", "deploys:dep-1", "leads:lead-2"]));
    assert.deepEqual(eventBindings(root), [LEADS, DEPLOYS]);
    assert.deepEqual(readEventStore(root), { bindings: [LEADS, DEPLOYS], seenIds: ["leads:lead-1", "deploys:dep-1", "leads:lead-2"] });
    assert.equal(existsSync(join(root, ".sam", "events.db")), true);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json")), false);
    assert.equal(existsSync(join(root, ".sam", "event-ids.json")), false);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json.migrated")), true);
    assert.equal(existsSync(join(root, ".sam", "event-ids.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "event-bindings.json.migrated"), "utf8")) as unknown;
    assert.deepEqual(kept, [LEADS, DEPLOYS]);
    // A bind over the migrated store rides the DB; duplicates still refuse.
    const mail: EventBinding = { name: "mail", profile: "dip", secretEnv: "SAM_EVENT_MAIL" };
    assert.deepEqual(bindEvent(root, mail), mail);
    assert.throws(() => bindEvent(root, LEADS), /Event binding already exists: leads/);
    assert.deepEqual(eventBindings(root), [LEADS, DEPLOYS, mail]);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("events store: malformed legacy files import nothing and stay in place, reading as no bindings", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "event-bindings.json"), "{ not json");
    writeFileSync(join(root, ".sam", "event-ids.json"), "{ also not json");
    assert.deepEqual(eventBindings(root), []);
    assert.deepEqual(readEventStore(root), { bindings: [], seenIds: [] });
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json")), true);
    assert.equal(existsSync(join(root, ".sam", "event-ids.json")), true);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json.migrated")), false);
    assert.equal(existsSync(join(root, ".sam", "event-ids.json.migrated")), false);
    // A non-array bindings payload imports nothing; junk rows in a
    // valid array are skipped at import while good rows land.
    writeFileSync(join(root, ".sam", "event-bindings.json"), JSON.stringify({ nope: true }));
    assert.deepEqual(eventBindings(root), []);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json.migrated")), false);
    writeFileSync(join(root, ".sam", "event-bindings.json"), JSON.stringify([LEADS, { name: "bad" }, "junk", DEPLOYS]));
    assert.deepEqual(eventBindings(root), [LEADS, DEPLOYS]);
    assert.equal(existsSync(join(root, ".sam", "event-bindings.json.migrated")), true);
    // A fresh bind over an unimportable file still lands in the DB.
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "event-bindings.json"), "{ not json");
      assert.deepEqual(bindEvent(root2, LEADS), LEADS);
      assert.deepEqual(eventBindings(root2), [LEADS]);
      assert.equal(existsSync(join(root2, ".sam", "event-bindings.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("events store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(eventBindings(root), []);
    assert.deepEqual(readEventStore(root), { bindings: [], seenIds: [] });
    assert.equal(unbindEvent(root, "leads"), false);
    assert.equal(updateEventBinding(root, "leads", { profile: "dip" }), null);
    assert.equal(existsSync(join(root, ".sam", "events.db")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("events store: interleaved bind, update, and unbind all survive (no whole-file lost update)", async () => {
  const root = fresh();
  try {
    bindEvent(root, LEADS);
    bindEvent(root, DEPLOYS);
    const patched = updateEventBinding(root, "deploys", { profile: "dip" });
    assert.deepEqual(patched, { name: "deploys", profile: "dip", secretEnv: "SAM_EVENT_DEPLOYS" });
    assert.throws(() => updateEventBinding(root, "deploys", { profile: "Bad Profile" }), /Invalid profile/);
    assert.throws(() => updateEventBinding(root, "deploys", { secretEnv: "lowercase" }), /environment variable NAME/);
    assert.equal(updateEventBinding(root, "ghost", { profile: "dip" }), null);
    assert.equal(unbindEvent(root, "leads"), true);
    assert.equal(unbindEvent(root, "leads"), false);
    assert.deepEqual(eventBindings(root), [{ name: "deploys", profile: "dip", secretEnv: "SAM_EVENT_DEPLOYS" }]);
    // Cap: fill to 32 bindings total, the 33rd refuses.
    for (let i = 0; i < 31; i++) {
      bindEvent(root, { name: "evt" + i, profile: "sam", secretEnv: "SAM_EVENT_X" });
    }
    assert.equal(eventBindings(root).length, 32);
    assert.throws(() => bindEvent(root, { name: "one-more", profile: "sam", secretEnv: "SAM_EVENT_X" }), /Event binding limit reached/);
    assert.equal(unbindEvent(root, "evt0"), true);
    assert.deepEqual(bindEvent(root, { name: "one-more", profile: "sam", secretEnv: "SAM_EVENT_X" }), { name: "one-more", profile: "sam", secretEnv: "SAM_EVENT_X" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("events store: the dedupe guard resolves through the migrated store and the prune keeps the newest 500", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacyIds: string[] = [];
    for (let i = 0; i < 500; i++) legacyIds.push("leads:old-" + i);
    writeFileSync(join(root, ".sam", "event-bindings.json"), JSON.stringify([LEADS]));
    writeFileSync(join(root, ".sam", "event-ids.json"), JSON.stringify(legacyIds));
    const env = { SAM_EVENT_LEADS: "event-secret" };
    const calls: Array<{ route: TurnRoute }> = [];
    const runTurn = async (_chatId: string, _content: string, route: TurnRoute) => { calls.push({ route }); return "Noted."; };
    // A legacy seen id is a duplicate through the migrated store:
    // no second wake.
    const legacyRaw = JSON.stringify({ type: "lead.arrived", id: "old-499", data: { name: "Ada" } });
    const dup = await acceptEvent(root, { name: "leads", rawBody: legacyRaw, signature: signEvent(env.SAM_EVENT_LEADS, legacyRaw), env, runTurn });
    assert.equal(dup.duplicate, true);
    assert.equal(calls.length, 0);
    // A fresh id wakes once, lands in the DB, and prunes exactly
    // the oldest legacy id (the store holds the newest 500).
    const freshRaw = JSON.stringify({ type: "lead.arrived", id: "new-1", data: { name: "Ada" } });
    const ok = await acceptEvent(root, { name: "leads", rawBody: freshRaw, signature: signEvent(env.SAM_EVENT_LEADS, freshRaw), env, runTurn });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    const store = readEventStore(root);
    assert.equal(store.seenIds.length, 500);
    assert.equal(store.seenIds[0], "leads:old-1");
    assert.equal(store.seenIds[499], "leads:new-1");
    assert.equal(existsSync(join(root, ".sam", "event-ids.json")), false);
    // And the fresh id is now itself a duplicate.
    const again = await acceptEvent(root, { name: "leads", rawBody: freshRaw, signature: signEvent(env.SAM_EVENT_LEADS, freshRaw), env, runTurn });
    assert.equal(again.duplicate, true);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

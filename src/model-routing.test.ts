import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRoutingTable, resolveModelForRoute, tierForRoute } from "./model-routing.js";
import { recordUsage, readUsage, usageSummary } from "./usage.js";
import { statusSnapshot } from "./cli-views.js";

test("model routing: routes map to tiers (poll cheap, chat main, background deep)", () => {
  assert.equal(tierForRoute("heartbeat"), "cheap");
  assert.equal(tierForRoute("chat"), "main");
  assert.equal(tierForRoute("background"), "deep");
});

test("model routing: tier env wins for its route, main is the fallback", () => {
  const env = { SAM_MODEL: "main-1", SAM_MODEL_CHEAP: "cheap-1", SAM_MODEL_DEEP: "deep-1" } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveModelForRoute({ route: "heartbeat", env }), { model: "cheap-1", tier: "cheap", source: "cheap-env" });
  assert.deepEqual(resolveModelForRoute({ route: "chat", env }), { model: "main-1", tier: "main", source: "main-env" });
  assert.deepEqual(resolveModelForRoute({ route: "background", env }), { model: "deep-1", tier: "deep", source: "deep-env" });
  const bare = { SAM_MODEL: "main-1" } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveModelForRoute({ route: "heartbeat", env: bare }), { model: "main-1", tier: "cheap", source: "main-env" });
  assert.deepEqual(resolveModelForRoute({ route: "background", env: bare }), { model: "main-1", tier: "deep", source: "main-env" });
  assert.deepEqual(resolveModelForRoute({ route: "chat", env: {} as NodeJS.ProcessEnv }), { model: null, tier: "main", source: "main-env" });
});

test("model routing: a profile pin always wins over the tier table", () => {
  const env = { SAM_MODEL: "main-1", SAM_MODEL_CHEAP: "cheap-1" } as NodeJS.ProcessEnv;
  assert.deepEqual(
    resolveModelForRoute({ route: "heartbeat", profileModel: "pinned-9", env }),
    { model: "pinned-9", tier: "cheap", source: "profile" },
  );
  const table = modelRoutingTable(env);
  assert.deepEqual(table.map(r => r.route), ["heartbeat", "chat", "background"]);
  assert.equal(table[0].model, "cheap-1");
});

test("usage: records aggregate by model, route, tier, and actor; filters narrow", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-usage-"));
  try {
    assert.equal(usageSummary(root).calls, 0);
    recordUsage(root, { actor: "trading", route: "heartbeat", tier: "cheap", model: "cheap-1", promptTokens: 100, completionTokens: 20 });
    recordUsage(root, { actor: "trading", route: "heartbeat", tier: "cheap", model: "cheap-1", promptTokens: 50, completionTokens: 10, totalTokens: 60 });
    recordUsage(root, { actor: "sam", route: "background", tier: "deep", model: "main-1", promptTokens: 900, completionTokens: 300 });
    // Invalid counts record nothing - accounting never invents numbers.
    assert.equal(recordUsage(root, { actor: "sam", route: "chat", tier: "main", model: "main-1", promptTokens: -1, completionTokens: 5 }), null);
    assert.equal(readUsage(root).length, 3);
    const all = usageSummary(root);
    assert.equal(all.calls, 3);
    assert.equal(all.totalTokens, 120 + 60 + 1200);
    assert.equal(all.byRoute.heartbeat.calls, 2);
    assert.equal(all.byRoute.background.totalTokens, 1200);
    assert.equal(all.byTier.cheap.totalTokens, 180);
    assert.equal(all.byModel["cheap-1"].calls, 2);
    assert.equal(all.byActor.trading.calls, 2);
    assert.ok(all.lastAt);
    assert.equal(usageSummary(root, { actor: "sam" }).calls, 1);
    assert.equal(usageSummary(root, { route: "heartbeat" }).totalTokens, 180);
    // The CLI/dashboard snapshot carries routing + spend in one shape.
    const snap = statusSnapshot(root);
    assert.equal(snap.usage.calls, 3);
    assert.equal(snap.models.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

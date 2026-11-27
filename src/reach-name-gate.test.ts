import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachActionBlocker, reachChannelBlocker, resetReachCache, runReach } from "./reach.js";

// The reach name gate: runReach is the ONE seam every reach
// call rides (the sam_reach chat tool and the CLI `reach call`
// door), and its registry is the agent-reach CLI's own live
// channel declaration - but the channel lookup folded case
// only, the action lookup was exact, and both refusals were
// improvised with no fold correction, so a folded name
// ("you-tube" for a declared "youtube", "Search" for a
// declared "search") dead-ended even though the intended
// name was unambiguous, while every sibling registry refusal
// names its registry as the refusal and corrects the fold
// through its ONE source. reachChannelBlocker and
// reachActionBlocker in reach.ts are now those ONE sources,
// and runReach returns them as the same BAD_INPUT data it
// returned before (reach errors are data by design, never
// throws), before any call is spent. The declared registry
// itself stays the CLI's live declaration.

function stubBin(root: string, channels: unknown): string {
  const path = join(root, "agent-reach-stub.js");
  writeFileSync(path, `
const a = process.argv.slice(2);
if (a[0] === "channels") {
  console.log(JSON.stringify({ channels: ${JSON.stringify(channels)} }));
} else if (a[0] === "youtube" && a[1] === "search") {
  console.log(JSON.stringify({ ok: true, items: [{ title: "Hit", url: "https://example.com/v", text: "Found." }] }));
} else {
  console.log(JSON.stringify({ ok: false, error: { code: "BAD_INPUT", message: "unhandled" } }));
}
`);
  return path;
}

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-reach-name-gate-")); }

test("reach name gate: an unknown channel refuses in the ONE source's words, naming the declared registry, and spends no call", async () => {
  const root = fresh();
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root, [{ id: "youtube", actions: ["search", "subtitle"] }, { id: "web", actions: ["search", "read"] }]) };
    resetReachCache();
    const result = await runReach({ channel: "myspace", action: "search", query: "x" }, env);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "BAD_INPUT");
    assert.equal(result.error?.message, "Unknown channel \"myspace\". Declared channels: youtube, web");
    assert.equal(reachChannelBlocker([{ id: "youtube", actions: [] }, { id: "web", actions: [] }], "myspace"), result.error?.message);
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

test("reach name gate: a folded channel name refuses with the correction", async () => {
  const root = fresh();
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root, [{ id: "youtube", actions: ["search", "subtitle"] }]) };
    resetReachCache();
    const result = await runReach({ channel: "You Tube", action: "search", query: "x" }, env);
    assert.equal(result.ok, false);
    assert.equal(result.error?.message, "Unknown channel \"You Tube\". Declared channels: youtube. Did you mean \"youtube\"?");
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

test("reach name gate: an ambiguous fold names no correction", async () => {
  const channels = [{ id: "youtube", actions: ["search"] }, { id: "you-tube", actions: ["search"] }];
  const blocker = reachChannelBlocker(channels, "You Tube");
  assert.ok(blocker !== null && !blocker.includes("Did you mean"), "two folded matches, no correction offered");
  assert.equal(reachChannelBlocker(channels, "youtube"), null, "an exact declared name reads no blocker");
  assert.equal(reachChannelBlocker(channels, "YouTube"), null, "the case-folded lookup still reads no blocker");
});

test("reach name gate: a folded action refuses with the correction and an unknown action names the registry without one", async () => {
  const root = fresh();
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root, [{ id: "youtube", actions: ["search", "subtitle"] }]) };
    resetReachCache();
    const folded = await runReach({ channel: "youtube", action: "Search", query: "x" }, env);
    assert.equal(folded.ok, false);
    assert.equal(folded.error?.message, "Channel youtube does not declare action \"Search\". Its actions: search, subtitle. Did you mean \"search\"?");
    const unknown = await runReach({ channel: "youtube", action: "post", query: "x" }, env);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.message, "Channel youtube does not declare action \"post\". Its actions: search, subtitle");
    assert.equal(reachActionBlocker({ id: "youtube", actions: ["search"] }, "search"), null, "a declared action reads no blocker");
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

test("reach name gate: a declared channel and action still call through", async () => {
  const root = fresh();
  try {
    const env = { ...process.env, SAM_AGENT_REACH_BIN: stubBin(root, [{ id: "youtube", actions: ["search", "subtitle"] }]) };
    resetReachCache();
    const result = await runReach({ channel: "YouTube", action: "search", query: "news" }, env);
    assert.equal(result.ok, true);
    assert.equal(result.items?.[0].title, "Hit");
  } finally { rmSync(root, { recursive: true, force: true }); resetReachCache(); }
});

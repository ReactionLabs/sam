import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORCH_MAX_DEPTH, buildConsolidatedResult, getJob, laneWorkerPrompt, listLanes,
  openWorkerLane, orchestrate, planJob, remainingPool, setOrchestrationRunnerForTests,
  type LaneSpec,
} from "./orchestration.js";

function freshRoot(): string { return mkdtempSync(join(tmpdir(), "orch-")); }
function lane(partial: Partial<LaneSpec> & { name: string }): LaneSpec {
  return {
    kind: "research",
    goal: "goal for " + partial.name,
    doneLooksLike: "done shape for " + partial.name,
    notDoneLooksLike: "not done shape for " + partial.name,
    landsAt: "the job report",
    ...partial,
  };
}

test("plan refuses a lane without the full three-part done-shape", () => {
  const root = freshRoot();
  assert.throws(() => planJob(root, { ask: "x", lanes: [lane({ name: "a", doneLooksLike: " " })] }), /done-shape/);
  assert.throws(() => planJob(root, { ask: "x", lanes: [lane({ name: "a", landsAt: "" })] }), /done-shape/);
  assert.throws(() => planJob(root, { ask: "x", lanes: [] }), /at least one lane/);
});

test("plan sizes the team against the live pool and refuses what cannot fit", () => {
  const root = freshRoot();
  const five = ["a", "b", "c", "d", "e"].map(name => lane({ name, kind: "build" }));
  assert.throws(() => planJob(root, { ask: "too big", lanes: five }), /does not fit the remaining worker pool/);
  const left = remainingPool(root, "sam");
  assert.equal(left.rounds, 6); assert.equal(left.maxCalls, 16);
});

test("scoped permissions: default-deny and no widening past the kind's hand", () => {
  const root = freshRoot();
  assert.throws(() => planJob(root, { ask: "x", lanes: [lane({ name: "a", tools: ["sam_nonsense"] })] }), /default-deny/);
  assert.throws(() => planJob(root, { ask: "x", lanes: [lane({ name: "a", kind: "research", tools: ["sam_code"] })] }), /widen past/);
  const { lanes } = planJob(root, { ask: "x", lanes: [lane({ name: "a", kind: "research", tools: ["sam_workspace_read"] })] });
  assert.deepEqual(lanes[0].tools, ["sam_workspace_read"]);
});

test("scoped context: a worker's brief carries its own lane's facts and law, not another lane's", () => {
  const root = freshRoot();
  const { lanes } = planJob(root, {
    ask: "two lanes",
    lanes: [
      lane({ name: "alpha", facts: ["ALPHA-FACT"], lawLines: ["alpha law"] }),
      lane({ name: "beta", facts: ["BETA-FACT"] }),
    ],
  });
  const prompt = laneWorkerPrompt(lanes.find(l => l.name === "alpha")!, []);
  assert.match(prompt, /ALPHA-FACT/); assert.match(prompt, /alpha law/);
  assert.doesNotMatch(prompt, /BETA-FACT/);
});

test("depth cap: only a depth-1 coordinate lane opens workers, and workers never spawn", () => {
  const root = freshRoot();
  const { lanes } = planJob(root, {
    ask: "coordinated",
    lanes: [lane({
      name: "lead", kind: "coordinate",
      workers: [lane({ name: "w1" })],
    })],
  });
  const lead = lanes.find(l => l.name === "lead")!;
  const w1 = lanes.find(l => l.name === "w1")!;
  assert.equal(lead.depth, 1); assert.equal(w1.depth, 2); assert.equal(w1.parentLaneId, lead.id);
  const w2 = openWorkerLane(root, lead.id, lane({ name: "w2" }));
  assert.equal(w2.depth, ORCH_MAX_DEPTH);
  assert.throws(() => openWorkerLane(root, w1.id, lane({ name: "w3" })), /Workers never spawn/);
  assert.throws(() => planJob(root, {
    ask: "nested too deep",
    lanes: [lane({ name: "plain", workers: [lane({ name: "x" })] })],
  }), /Only a coordinate lane/);
});

test("lifecycle: lanes run, verify, and close into one consolidated result", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async (_root, l) => {
    if (l.name === "dig") return "The launch code is 47-ALPHA, per brief.md.";
    if (l.name === "write") return "Wrote the summary.";
    return "result";
  });
  try {
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(join(root, "out", "page.md"), "Launch code 47-ALPHA inside.\n");
    const { job, lanes } = await orchestrate(root, {
      ask: "research the brief and write the page",
      lanes: [
        lane({ name: "dig", kind: "research" }),
        lane({ name: "write", kind: "build", dependsOn: ["dig"], landsAt: "out/page.md", verify: { artifact: "out/page.md", mustMention: ["47-ALPHA"] } }),
      ],
    });
    assert.equal(job.status, "done");
    assert.equal(lanes.find(l => l.name === "dig")!.verdict, "verified");
    assert.equal(lanes.find(l => l.name === "write")!.verdict, "verified");
    assert.match(job.consolidated!, /Landed:/);
    assert.match(job.consolidated!, /dig/);
    assert.equal(getJob(root, job.id)!.status, "done");
    assert.equal(listLanes(root, job.id).length, 2);
  } finally { setOrchestrationRunnerForTests(null); }
});

test("verification gates delivery: a rejected build is replaced once, then lands", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async (r, l) => {
    if (l.attempts === 1) return "Done, trust me."; // no artifact written: coordinator must reject
    mkdirSync(join(r, "out"), { recursive: true });
    writeFileSync(join(r, "out", "page.md"), "Now with the REQUIRED-TOKEN inside.\n");
    return "Wrote it for real this time.";
  });
  try {
    const { job, lanes } = await orchestrate(root, {
      ask: "build the page",
      lanes: [lane({ name: "write", kind: "build", landsAt: "out/page.md", verify: { artifact: "out/page.md", mustMention: ["REQUIRED-TOKEN"] } })],
    });
    const write = lanes.find(l => l.name === "write")!;
    assert.equal(write.status, "done"); assert.equal(write.attempts, 2); assert.equal(write.verdict, "verified");
    assert.equal(job.status, "done");
  } finally { setOrchestrationRunnerForTests(null); }
});

test("unverified claims do not land: a sourceless research result is named, not delivered", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async () => "I recall the code is probably 99-ZZZ, from memory.");
  try {
    const { job, lanes } = await orchestrate(root, { ask: "find the code", lanes: [lane({ name: "dig", kind: "research" })] });
    const dig = lanes[0];
    assert.equal(dig.verdict, "unverified");
    assert.equal(job.status, "blocked");
    assert.match(job.consolidated!, /Blocked:/);
    assert.doesNotMatch(job.consolidated!, /Landed:/);
    assert.equal(lanes.length, 1);
  } finally { setOrchestrationRunnerForTests(null); }
});

test("stuck worker: a throwing worker is replaced once, then the lane fails by name", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async (_r, l) => {
    if (l.name === "flaky" && l.attempts === 1) throw new Error("worker died mid-lane");
    if (l.name === "flaky") return "Recovered result, per notes.md.";
    throw new Error("permanent boom");
  });
  try {
    const { job, lanes } = await orchestrate(root, {
      ask: "two research lanes",
      lanes: [lane({ name: "flaky" }), lane({ name: "doomed" })],
    });
    const flaky = lanes.find(l => l.name === "flaky")!;
    const doomed = lanes.find(l => l.name === "doomed")!;
    assert.equal(flaky.status, "done"); assert.equal(flaky.attempts, 2);
    assert.equal(doomed.status, "failed"); assert.equal(doomed.attempts, 2);
    assert.match(doomed.blocker!, /permanent boom/);
    assert.equal(job.status, "partial");
    assert.match(job.consolidated!, /doomed/);
  } finally { setOrchestrationRunnerForTests(null); }
});

test("a lane whose dependency did not land is blocked by name, never run silently", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async () => { throw new Error("build exploded"); });
  try {
    const { lanes } = await orchestrate(root, {
      ask: "build then verify",
      lanes: [
        lane({ name: "make", kind: "build", landsAt: "out/x.md" }),
        lane({ name: "check", kind: "verify", dependsOn: ["make"] }),
      ],
    });
    const check = lanes.find(l => l.name === "check")!;
    assert.equal(check.status, "failed");
    assert.match(check.blocker!, /Dependency make did not land/);
  } finally { setOrchestrationRunnerForTests(null); }
});

test("invisibility: the consolidated result carries no lane internals, the store keeps them for on-ask detail", async () => {
  const root = freshRoot();
  setOrchestrationRunnerForTests(async () => "The fact is 47-ALPHA, per brief.md.");
  try {
    const { job, lanes } = await orchestrate(root, {
      ask: "quiet job",
      lanes: [lane({ name: "dig", facts: ["INTERNAL-SENTINEL-FACT"], lawLines: ["internal law sentinel"] })],
    });
    assert.doesNotMatch(job.consolidated!, /INTERNAL-SENTINEL-FACT/);
    assert.doesNotMatch(job.consolidated!, /sub-agent|worker prompt/i);
    const detail = listLanes(root, job.id);
    assert.equal(detail[0].facts[0], "INTERNAL-SENTINEL-FACT");
    assert.equal(detail[0].name, "dig");
    const rebuilt = buildConsolidatedResult(getJob(root, job.id)!, detail);
    assert.equal(rebuilt, job.consolidated);
    assert.equal(lanes.length, 1);
  } finally { setOrchestrationRunnerForTests(null); }
});

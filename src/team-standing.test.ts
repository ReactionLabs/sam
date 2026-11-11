import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { addTeamMember, listTeamMembers, parseReview, removeTeamMember, routeTask, runStandingTeam, teamStatus } from "./team-runtime.js";
import { ChatStore } from "./chats.js";
import { listActions } from "./actions.js";
import { OperativeRegistry } from "./operatives.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-standing-")); }

test("review verdicts fail closed unless the first line approves", () => {
  assert.equal(parseReview("VERDICT: approve\nThe test covers it.").verdict, "approve");
  assert.equal(parseReview("VERDICT: request-changes\nAdd a test.").verdict, "request-changes");
  assert.equal(parseReview("Looks fine to me.").verdict, "request-changes");
});

test("the lead routes by role and the reviewer cannot be the worker", () => {
  const members = [
    { name: "ada", role: "builder" as const, capabilities: ["build"], tools: [], model: "builder-model", budget: { maxCalls: 4 } },
    { name: "bea", role: "researcher" as const, capabilities: ["research"], tools: [], model: "research-model", budget: { maxCalls: 4 } },
    { name: "cy", role: "reviewer" as const, capabilities: ["review"], tools: [], model: "review-model", budget: { maxCalls: 4 } },
  ];
  assert.equal(routeTask(members, "Build the widget").worker.name, "ada");
  assert.equal(routeTask(members, "Research the prior art").worker.name, "bea");
  assert.equal(routeTask(members, "Build the widget").reviewer.name, "cy");
  assert.throws(() => routeTask([members[2]], "Build it"), /needs a reviewer|No team member/);
});

test("builder revises once and the reviewer's other model approves; the gate is not bypassed", async () => {
  const root = scratch();
  try {
    addTeamMember(root, { name: "ada", role: "builder", model: "builder-model", tools: ["sam_memory_list"], maxCalls: 4 });
    addTeamMember(root, { name: "cy", role: "reviewer", model: "reviewer-model", tools: [], maxCalls: 4 });
    const db = new ChatStore(root);
    assert.equal(db.agents().find(a => a.name === "ada")?.model, "builder-model");
    assert.equal(db.agents().find(a => a.name === "cy")?.model, "reviewer-model");
    db.close();
    const reg = new OperativeRegistry(join(root, ".sam", "missions.db"));
    assert.ok(reg.list().some(o => o.name === "ada" && o.capabilities.includes("build")));
    reg.close();
    assert.throws(() => addTeamMember(root, { name: "bad", role: "builder", tools: ["sam_not_a_tool"] }), /Unknown tool/);
    const seen: string[] = [];
    let reviews = 0;
    const run = await runStandingTeam(root, "Build the widget", {
      complete: async (input) => {
        seen.push(input.member.role + ":" + input.model);
        if (input.member.role === "builder") return reviews === 0 ? "Built the widget, no test." : "Revised: added the test.";
        reviews++;
        return reviews === 1 ? "VERDICT: request-changes\nAdd a test." : "VERDICT: approve\nThe test covers it.";
      },
    });
    assert.equal(run.status, "done");
    assert.equal(run.verdict, "approve");
    assert.equal(run.rounds, 2);
    assert.equal(run.workerModel, "builder-model");
    assert.equal(run.reviewerModel, "reviewer-model");
    assert.deepEqual(seen, ["builder:builder-model", "reviewer:reviewer-model", "builder:builder-model", "reviewer:reviewer-model"]);
    assert.equal(run.result, "Revised: added the test.");
    const status = teamStatus(root);
    assert.equal(status.messages.filter(m => m.kind === "review").length, 2);
    assert.equal(status.messages.filter(m => m.kind === "work").length, 2);
    assert.equal(status.runs[0].status, "done");
    assert.equal(listActions(root).some(a => a.status === "done"), false);
    assert.equal(removeTeamMember(root, "ada"), true);
    assert.equal(listTeamMembers(root).some(m => m.name === "ada"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reviewer who never approves blocks the run at the round cap", async () => {
  const root = scratch();
  try {
    addTeamMember(root, { name: "ada", role: "builder", maxCalls: 4 });
    addTeamMember(root, { name: "cy", role: "reviewer", maxCalls: 4 });
    const run = await runStandingTeam(root, "Build the widget", { maxRounds: 2, complete: async (input) => input.member.role === "reviewer" ? "VERDICT: request-changes\nStill missing." : "Attempt." });
    assert.equal(run.status, "blocked");
    assert.equal(run.rounds, 2);
    assert.equal(run.verdict, "request-changes");
    assert.match(run.result ?? "", /did not approve/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI team run drives a fake provider through revise then approve", async () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  let n = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      n++;
      const content = n === 1 ? "Built the widget." : n === 2 ? "VERDICT: request-changes\nAdd a test." : n === 3 ? "Revised with a test." : "VERDICT: approve\nThe test covers it.";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const env = { PATH: "/usr/bin:/bin", SAM_MODEL_ENDPOINT: "http://127.0.0.1:" + port + "/v1/chat/completions", SAM_MODEL: "fake-model", SAM_MODEL_API_KEY: "local-test-key" };
  const runCli = (...args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--workspace", root, "--json", ...args], { env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", status => resolve({ status: status ?? 1, stdout, stderr }));
  });
  try {
    assert.equal((await runCli("team", "member", "add", "ada", "builder", "--model", "builder-model")).status, 0);
    assert.equal((await runCli("team", "member", "add", "cy", "reviewer", "--model", "reviewer-model")).status, 0);
    const ran = await runCli("team", "run", "Build the widget", "--rounds", "3");
    assert.equal(ran.status, 0, ran.stderr);
    const body = JSON.parse(ran.stdout);
    assert.equal(body.status, "done");
    assert.equal(body.verdict, "approve");
    assert.equal(body.rounds, 2);
    assert.equal(body.workerModel, "builder-model");
    assert.equal(body.reviewerModel, "reviewer-model");
    const status = JSON.parse((await runCli("team", "status")).stdout);
    assert.equal(status.messages.filter((m: { kind: string }) => m.kind === "review").length, 2);
    const review = JSON.parse((await runCli("review", "show")).stdout);
    assert.equal(review.run.verdict, "approve");
    assert.ok(!ran.stdout.includes("local-test-key"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

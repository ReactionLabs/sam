import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import { readActivity } from "./activity.js";
import {
  listSubagents, ownerSpawnPool, smallSpawnPool, spawnSubagent,
  updateSubagent, withSpawnPool, type SubagentCompleter,
} from "./subagents.js";
import { listJobs, listLanes, remainingPool } from "./orchestration.js";
import { awaitChatQueue, enqueueChatMessage, listChatQueue } from "./chat-queue.js";
import { setCodeRoot } from "./code.js";

// Issue #96 harness regression: deterministic, stubbed model
// responses through the dashboard turn path (runChatTurn is the
// exact function the dashboard POST handler drains into), proving:
// the budget visible at FIRST dispatch after a poisoned history,
// two read-only Git workers with priced-as-given lane budgets, a
// combined response, an over-budget plan refused before any worker
// starts, and (Defect 2) a five-message burst with a correction and
// a nevermind folding into one running turn.

type Msg = { role: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
const requests: Array<{ messages: Msg[] }> = [];

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function reply(res: import("node:http").ServerResponse, message: Record<string, unknown>) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }));
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const GIT_LANES = [
  { name: "branch-status", kind: "general", goal: "Report the current git branch and the working-tree status of the code root", doneLooksLike: "The result names the branch and quotes the git-status output", notDoneLooksLike: "A branch guessed from memory", landsAt: "the coordinator's consolidated result", tools: ["sam_code"], budget: { rounds: 2, maxCalls: 4 } },
  { name: "latest-commit", kind: "general", goal: "Report the latest commit and the paths it changed in the code root", doneLooksLike: "The result names the latest commit and every path it changed, from git-latest-files output", notDoneLooksLike: "A commit named without its changed paths", landsAt: "the coordinator's consolidated result", tools: ["sam_code"], budget: { rounds: 2, maxCalls: 4 } },
];

function lastUser(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return String(messages[i].content ?? "");
  return "";
}
function toolTexts(messages: Msg[]): string[] {
  return messages.filter(m => m.role === "tool").map(m => String(m.content ?? ""));
}

async function handleModel(body: { messages: Msg[] }, res: import("node:http").ServerResponse) {
  const messages = body.messages;
  requests.push({ messages });
  const user = lastUser(messages);
  const tools = toolTexts(messages);
  // Worker turns (hired lanes): the user message is the lane brief.
  if (user.includes("a worker S.A.M. hired")) {
    const already = tools.length > 0;
    if (user.includes("working-tree status")) {
      if (!already) return reply(res, { content: null, tool_calls: [toolCall("w-a1", "sam_code", { action: "run", command: "git-status" })] });
      return reply(res, { content: "Branch and working tree from git-status: " + tools[tools.length - 1].slice(0, 500) + "\nSources: git-status in the code root; see notes.md", tool_calls: undefined });
    }
    if (user.includes("paths it changed")) {
      if (!already) return reply(res, { content: null, tool_calls: [toolCall("w-b1", "sam_code", { action: "run", command: "git-latest-files" })] });
      return reply(res, { content: "Latest commit and its changed paths from git-latest-files: " + tools[tools.length - 1].slice(0, 500), tool_calls: undefined });
    }
    return reply(res, { content: "Worker could not classify its brief.", tool_calls: undefined });
  }
  // The burst scenario's long-running turn (after a steer, the last
  // user message is the steered one, so scan every user message).
  if (messages.some(m => m.role === "user" && String(m.content ?? "").includes("Start the long check"))) {
    if (!tools.length) { await sleep(800); return reply(res, { content: null, tool_calls: [toolCall("c-slow", "sam_workspace_list", {})] }); }
    const allUser = messages.filter(m => m.role === "user").map(m => String(m.content ?? "")).join("\n");
    const corrected = allUser.includes("correction: report the branch only");
    const noted = allUser.includes("zorblax-kit");
    return reply(res, { content: "Long check finished." + (corrected ? " Branch only, as corrected." : " Full status reported.") + (noted ? " Repo noted: zorblax-kit." : ""), tool_calls: undefined });
  }
  // The over-budget scenario.
  if (user.includes("Plan the huge audit")) {
    const refusal = tools.find(t => t.includes("does-not-fit"));
    if (refusal) return reply(res, { content: "That plan does not fit and no workers started. Numbers: " + refusal.slice(0, 300), tool_calls: undefined });
    if (!tools.length) return reply(res, { content: null, tool_calls: [toolCall("c-load-big", "sam_load_tools", { names: ["sam_orchestrate"] })] });
    // 20 lanes at {2, 4} ask {40, 80}: over one tranche's {30, 120}
    // on rounds, so even the continuation cannot fit it. (Terse lane
    // fields keep the call under the provider's 4000-char arg cap.)
    const lanes = Array.from({ length: 20 }, (_, i) => ({ name: "lane-" + String(i + 1).padStart(2, "0"), kind: "general", goal: "s" + (i + 1), doneLooksLike: "d", notDoneLooksLike: "n", landsAt: "r", tools: ["sam_code"], budget: { rounds: 2, maxCalls: 4 } }));
    return reply(res, { content: null, tool_calls: [toolCall("c-big", "sam_orchestrate", { goal: "Huge audit", lanes })] });
  }
  // The git-check coordinator.
  if (user.includes("Run the git check")) {
    const done = tools.find(t => t.includes("\"jobId\""));
    if (done) return reply(res, { content: "Combined git report. " + done.slice(0, 900), tool_calls: undefined });
    if (!tools.length) return reply(res, { content: null, tool_calls: [toolCall("c-load", "sam_load_tools", { names: ["sam_orchestrate"] })] });
    return reply(res, { content: null, tool_calls: [toolCall("c-git", "sam_orchestrate", { goal: "Two read-only git checks", lanes: GIT_LANES })] });
  }
  return reply(res, { content: "Stub model: unscripted turn.", tool_calls: undefined });
}

let server: Server;
let endpoint = "";
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SAM_MODEL_ENDPOINT", "SAM_MODEL_API_KEY", "SAM_MODEL", "SAM_MODEL_PROVIDER"];

test.before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { void handleModel(JSON.parse(data || "{}"), res); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  endpoint = "http://127.0.0.1:" + port + "/v1/chat/completions";
  process.env.SAM_MODEL_ENDPOINT = endpoint;
  process.env.SAM_MODEL_API_KEY = "stub-key";
  process.env.SAM_MODEL = "stub-model";
  delete process.env.SAM_MODEL_PROVIDER;
});
test.after(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  server?.close();
});

function scratchRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "sam-harness-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "sam@test.local");
  git("config", "user.name", "SAM Harness");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "kit.ts"), "export const kit = 1;\n");
  git("add", "src/kit.ts");
  git("commit", "-m", "add the kit");
  writeFileSync(join(repo, "notes.md"), "scratch notes\n");
  return { repo, head: git("rev-parse", "HEAD").trim() };
}
function scratchRoot(): string { return mkdtempSync(join(tmpdir(), "sam-harness-")); }
function newChat(root: string, title: string): string {
  const store = new ChatStore(root);
  try { return store.create(title, null).id; } finally { store.close(); }
}

test("issue 96: first dispatch at a fresh turn hires two git workers despite a poisoned lifetime history", async () => {
  const root = scratchRoot();
  const { repo, head } = scratchRepo();
  try {
    setCodeRoot(root, repo);
    // Poison the books the way the pre-fix box was poisoned: three
    // finished workers whose carves ({6 rounds, 15 calls} of lifetime
    // history) used to leave the pool at 0 rounds / 1 call forever.
    // Their records are then unstamped, exactly like pre-change rows.
    const seededIds: string[] = [];
    const completer: SubagentCompleter = async () => ({ content: "seeded", calls: [] });
    await withSpawnPool(smallSpawnPool("job:legacy"), async () => {
      for (let i = 0; i < 3; i++) {
        const w = await spawnSubagent(root, { prompt: "legacy worker " + i, rounds: 2, maxCalls: 5 }, { complete: completer });
        seededIds.push(w.id);
      }
    });
    for (const id of seededIds) updateSubagent(root, id, { poolScope: undefined, poolTurn: undefined });
    // The poison is real in the books: a context-free read of the
    // pool (the old lifetime math) shows exactly the issue's numbers.
    assert.deepEqual(remainingPool(root, "sam"), { rounds: 0, maxCalls: 1 });
    // A fresh owner turn's own pool is untouched by that history.
    await withSpawnPool(ownerSpawnPool("turn:probe"), async () => {
      assert.deepEqual(remainingPool(root, "sam"), { rounds: 30, maxCalls: 120 });
    });

    const chatId = newChat(root, "Git check");
    const before = requests.length;
    const turn = await runChatTurn(root, chatId, "Run the git check with two workers: one on branch and status, one on the latest commit and its changed paths.", { source: "dashboard" });
    assert.match(turn, /Combined git report/);
    assert.match(turn, /main/, "the branch from worker one is in the combined answer");
    assert.ok(turn.includes(head.slice(0, 12)), "the latest commit hash from worker two is in the combined answer");
    assert.match(turn, /src\/kit\.ts/, "the changed path from worker two is in the combined answer");

    const jobs = listJobs(root);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "done");
    const lanes = listLanes(root, jobs[0].id);
    assert.equal(lanes.length, 2);
    for (const lane of lanes) assert.deepEqual(lane.budget, { rounds: 2, maxCalls: 4 }, "each lane was priced exactly as given");
    const workers = listSubagents(root, "sam").filter(s => !seededIds.includes(s.id));
    assert.equal(workers.length, 2, "exactly two workers ran");
    assert.notEqual(workers[0].id, workers[1].id, "two distinct run IDs");
    assert.ok(workers.every(w => w.status === "done"), "both workers finished");
    const turnRequests = requests.slice(before);
    assert.ok(turnRequests.length >= 5, "coordinator + two workers + follow-ups all hit the stub");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("issue 96: a legitimately over-budget plan is refused before any worker starts, numbers shown", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Huge audit");
    const turn = await runChatTurn(root, chatId, "Plan the huge audit with a big team.", { source: "dashboard" });
    assert.match(turn, /does not fit/);
    // The model saw the refusal as a tool result carrying the live
    // remaining pool and the plan's requested totals (20 lanes at
    // {2, 4} ask {40, 80}; one tranche holds {30, 120}).
    const refusalSeen = requests.some(r => r.messages.some(m => m.role === "tool" && String(m.content).includes("does-not-fit") && String(m.content).includes("40 rounds, 80 calls")));
    assert.ok(refusalSeen, "the refusal tool result names requested vs remaining");
    assert.equal(listSubagents(root, "sam").length, 0, "no worker started");
    assert.equal(listJobs(root).length, 0, "no job was persisted");
    assert.ok(readActivity(root, 20, { kind: "orchestration-continued" }).length >= 1, "the turn tried its next tranche before refusing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect 2: a five-message burst folds into the running turn - correction governs, nevermind does no work", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Burst");
    enqueueChatMessage(root, { chatId, content: "Start the long check on the repo.", source: "dashboard" });
    await sleep(250); // the first turn is running (the stub holds it)
    enqueueChatMessage(root, { chatId, content: "also note the repo name: zorblax-kit", source: "dashboard" });
    enqueueChatMessage(root, { chatId, content: "correction: report the branch only, skip the status detail", source: "dashboard" });
    enqueueChatMessage(root, { chatId, content: "extra: count the files in the repo when you finish", source: "dashboard" });
    enqueueChatMessage(root, { chatId, content: "nevermind", source: "dashboard" });
    await awaitChatQueue(root, chatId, 30000);

    const byContent = new Map(listChatQueue(root, chatId).map(i => [i.content, i.status]));
    assert.equal(byContent.get("Start the long check on the repo."), "folded");
    assert.equal(byContent.get("also note the repo name: zorblax-kit"), "steered");
    assert.equal(byContent.get("correction: report the branch only, skip the status detail"), "steered");
    assert.equal(byContent.get("extra: count the files in the repo when you finish"), "dropped", "the nevermind dropped it before it did any work");
    assert.equal(byContent.get("nevermind"), "consumed");

    const store = new ChatStore(root);
    try {
      const msgs = store.messages(chatId);
      const users = msgs.filter(m => m.role === "user").map(m => m.content);
      assert.deepEqual(users, [
        "Start the long check on the repo.",
        "also note the repo name: zorblax-kit",
        "correction: report the branch only, skip the status detail",
      ], "the transcript holds exactly the messages that governed, in arrival order");
      const assistants = msgs.filter(m => m.role === "assistant");
      assert.equal(assistants.length, 1, "one turn answered the whole burst");
      assert.match(assistants[0].content, /Branch only, as corrected/, "the correction governed the outcome");
      assert.match(assistants[0].content, /zorblax-kit/, "the mid-turn note was picked up");
    } finally { store.close(); }
    assert.ok(readActivity(root, 20, { kind: "message-steer" }).length >= 1);
    assert.equal(readActivity(root, 20, { kind: "message-nevermind" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

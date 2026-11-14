// Run inspector + right-panel read models (Dip, 2026-11-14): the owner
// should never dig through Sam's prose to learn what a run did. Every
// value here comes from a record that already exists (orchestration jobs
// and lanes, the subagent registry, dispatch refusals, the code root's
// own git state, the memory and preference stores). Where no record
// exists the field is null and the UI renders "Unavailable" - nothing is
// estimated. Read-only: this module never writes.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { listJobs, listLanes, listDispatchRefusals, remainingPool } from "./orchestration.js";
import { listSubagents, profileToolNames } from "./subagents.js";
import { codeRoot } from "./code.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";

export interface RunLaneView {
  name: string; kind: string; status: string;
  budget: { rounds: number; maxCalls: number };
  workerId: string | null; attempts: number;
  verdict: string | null; verdictReasons: string | null; blocker: string | null;
}
export interface RunInspector {
  chatId: string; profile: string;
  // The latest orchestration job for this chat's profile. Jobs are
  // profile-scoped records; chatId is carried when the dispatch door
  // passed one.
  job: {
    id: string; ask: string; status: string; createdAt: string; finishedAt: string | null;
    chatId: string | null;
    poolAtDispatch: { rounds: number; maxCalls: number } | null;
    lanes: RunLaneView[];
    fallbacks: number; // lanes that needed a replacement worker (attempts > 1)
  } | null;
  refusals: Array<{
    id: string; ask: string; at: string;
    requested: { rounds: number; maxCalls: number };
    available: { rounds: number; maxCalls: number };
    reason: string;
  }>;
  // Workers spawned from this chat itself (chat-scoped records).
  workers: Array<{
    id: string; role: string; status: string;
    budget: { rounds: number; maxCalls: number };
    createdAt: string; finishedAt: string | null;
  }>;
  poolNow: { rounds: number; maxCalls: number };
  // The owner turn's own starting budget is not recorded per run anywhere
  // (the turn-behavior lane owns that accounting); null = Unavailable.
  turnStartingBudget: { rounds: number; maxCalls: number } | null;
  codeRoot: {
    root: string; branch: string | null;
    modified: number | null; untracked: number | null;
    latestCommit: { hash: string; subject: string; changedPaths: string[] | null } | null;
  } | null;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 }).trim();
}

function codeRootView(root: string): RunInspector["codeRoot"] {
  const dir = codeRoot(root);
  if (!dir) return null;
  const view: NonNullable<RunInspector["codeRoot"]> = { root: dir, branch: null, modified: null, untracked: null, latestCommit: null };
  try { view.branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || null; } catch { /* not a git repo: counts stay Unavailable */ }
  try {
    const lines = git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean);
    view.modified = lines.filter(l => !l.startsWith("??")).length;
    view.untracked = lines.filter(l => l.startsWith("??")).length;
  } catch { /* stated honestly as Unavailable */ }
  try {
    const head = git(dir, ["log", "-1", "--format=%h%x09%s"]);
    const [hash, subject] = head.split("\t");
    let changedPaths: string[] | null = null;
    try { changedPaths = git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean); } catch { changedPaths = null; }
    view.latestCommit = { hash, subject: subject ?? "", changedPaths };
  } catch { /* no commits yet */ }
  return view;
}

export function profileForChat(root: string, chatId: string): string {
  const store = new ChatStore(root);
  try {
    const chat = store.get(chatId);
    if (!chat) throw new Error("Chat not found");
    return chat.agent_name?.trim() || "sam";
  } finally { store.close(); }
}

export function runInspectorForChat(root: string, chatId: string): RunInspector {
  const profile = profileForChat(root, chatId);
  const jobs = listJobs(root, profile);
  const latest = jobs.length ? jobs[jobs.length - 1] : null;
  const lanes = latest ? listLanes(root, latest.id) : [];
  const workers = listSubagents(root, profile)
    .filter(s => s.chatId === chatId)
    .map(s => ({ id: s.id, role: s.role, status: s.status, budget: s.budget, createdAt: s.createdAt, finishedAt: s.finishedAt }));
  return {
    chatId, profile,
    job: latest ? {
      id: latest.id, ask: latest.ask, status: latest.status,
      createdAt: latest.createdAt, finishedAt: latest.finishedAt,
      chatId: latest.chatId ?? null,
      poolAtDispatch: latest.poolAtDispatch ?? null,
      lanes: lanes.map(l => ({
        name: l.name, kind: l.kind, status: l.status, budget: l.budget,
        workerId: l.workerId, attempts: l.attempts,
        verdict: l.verdict, verdictReasons: l.verdictReasons, blocker: l.blocker,
      })),
      fallbacks: lanes.filter(l => l.attempts > 1).length,
    } : null,
    refusals: listDispatchRefusals(root, profile).slice(-5).reverse().map(r => ({
      id: r.id, ask: r.ask, at: r.at, requested: r.requested, available: r.available, reason: r.reason,
    })),
    workers,
    poolNow: remainingPool(root, profile),
    turnStartingBudget: null,
    codeRoot: codeRootView(root),
  };
}

export interface PanelMemoryRecord {
  id: string; kind: string; scope: string; state: string;
  created_at: string; preview: string; content: string;
}
export function panelMemory(root: string, profile: string, query = "", id?: string): { records: PanelMemoryRecord[]; record: PanelMemoryRecord | null } {
  const scopes = profile === "sam" ? ["core", "profile:sam"] : ["profile:" + profile];
  const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
  try {
    const all = store.list(undefined, scopes).map(r => ({
      id: r.id, kind: r.kind, scope: r.scope,
      state: r.archived_at ? "archived" : "active",
      created_at: r.created_at,
      preview: r.content.split("\n")[0].slice(0, 140),
      content: r.content,
    }));
    const q = query.trim().toLowerCase();
    const records = (q ? all.filter(r => r.content.toLowerCase().includes(q)) : all).slice(0, 100);
    return { records, record: id ? all.find(r => r.id === id) ?? null : null };
  } finally { store.close(); }
}

export interface PanelFiles {
  profile: string;
  persona: { name: string; instructions: string } | null;
  law: Array<{ id: string; statement: string; status: string; kind: string }>;
  capabilities: string[];
}
export function panelFiles(root: string, profile: string): PanelFiles {
  const store = new ChatStore(root);
  let persona: PanelFiles["persona"] = null;
  try {
    const agent = store.agents().find(a => a.name === profile) ?? null;
    if (agent) persona = { name: agent.name, instructions: agent.instructions };
  } finally { store.close(); }
  const prefs = new PreferenceStore(root);
  let law: PanelFiles["law"] = [];
  try {
    law = prefs.list()
      .filter(p => p.profile === profile && p.status !== "revoked")
      .map(p => ({ id: p.id, statement: p.statement, status: p.status, kind: p.kind }));
  } finally { prefs.close(); }
  return { profile, persona, law, capabilities: profileToolNames() };
}

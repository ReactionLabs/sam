import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MissionStore } from "./storage.js";
import { ChatStore, type ChatRecord } from "./chats.js";
import { recentSkillUse, lastSkillByChat } from "./skill-use.js";
import { discoverSkills, skillAllowlists } from "./skills.js";
import { listBindings } from "./bindings.js";
import { loadApprovalPolicy } from "./approval-policy.js";
import { codeSummary } from "./code.js";
import { codingSummary } from "./coding.js";
import { engineStatus } from "./engine.js";
import { engineConnectStatus } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { briefStatus } from "./brief.js";
import { unificationReport } from "./unification.js";
import { readSetupRecord } from "./config-wizard.js";
import { authStatus } from "./auth-status.js";
import { observabilityReport } from "./observability.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs, heartbeatLog } from "./heartbeat.js";
import { minis } from "./minis.js";
import { doorEnabled, listDoors } from "./mini-door.js";
import { listDrafts } from "./drafts.js";
import { listContacts } from "./contacts.js";
import type { DoorGuardStats } from "./door-guard.js";
import { connectors } from "./connectors.js";
import { channels } from "./channels.js";
import { installedSkills } from "./skill-registry.js";
import { listSubagents } from "./subagents.js";
import { teamStatus } from "./team-runtime.js";
import { listActions } from "./actions.js";
import { readActivity } from "./activity.js";
import { listBackgroundTasks } from "./background.js";
import { modelRoutingTable } from "./model-routing.js";
import { usageSummary, usageToday } from "./usage.js";
import { listCompactions } from "./compaction.js";
import { pairingStatus } from "./pairing.js";
import { authoredSkills, curatorFindings } from "./skill-author.js";
import { deliverySummary } from "./delivery-outbox.js";
import { listSchedules, readDashboardConfig } from "./dashboard.js";
import { standingSummary } from "./standing-files.js";
import { verificationStatus } from "./verification.js";
import { goldfishStatus } from "./goldfish.js";
import { sessionCaps, sessionUsageToday } from "./session-caps.js";
import { dueLoops, openLoopCount } from "./loops.js";
import { readDeliveryLedger } from "./worthiness.js";
import { stackWatchStatus } from "./stack-watch.js";
import { readSelfAudit } from "./self-audit.js";
import { readPromptAudit } from "./prompt-audit.js";
import { readContextAudit } from "./context-audit.js";
import { readLoopAudit } from "./loop-audit.js";
import { readEvalBattery } from "./eval-battery.js";
import { vaultStatus } from "./vault.js";
import { readSelfWork, selfWorkFixViews } from "./self-work.js";

// One status payload (fix-list item 3). The dashboard route /api/status
// and the CLI overview used to build two objects: the route carried
// `actions` (every card) and the CLI carried `pendingActions` (pending
// only), and the rest of the keys had drifted the same way. Both
// surfaces call this function. `pendingActions` is the pending slice of
// the same `actions` array, so the two keys cannot diverge.

const EMPTY_DOOR_GUARD: DoorGuardStats = { probes: 0, blockedMessages: 0, rateLimited: 0, probeLockedUntil: null };

export interface StatusBuildOptions {
  activity?: { actor?: string; kind?: string };
  activityLimit?: number;
  /** The live dashboard process passes its abuse-guard counters.
   *  A process with no guard (the CLI) reports the zero counters. */
  doorGuard?: DoorGuardStats;
}

function agents(root: string) {
  const db = new ChatStore(root);
  try { return db.agents(); }
  finally { db.close(); }
}

export function buildStatusPayload(root: string, opts: StatusBuildOptions = {}) {
  const store = new MissionStore(join(root, ".sam", "missions.db"));
  let missions: Array<{ code: string; status: string; objective: string }>;
  try { missions = store.list().slice(0, 100).map(m => ({ code: m.code, status: m.status, objective: m.objective })); }
  finally { store.close(); }
  const chatStore = new ChatStore(root);
  let chats: Array<ChatRecord & { lastMessageAt: string | null; messageCount: number; lastSkill: unknown }>;
  let archivedChats: Array<ChatRecord & { lastMessageAt: string | null; messageCount: number; lastSkill: unknown }>;
  try {
    const act = new Map(chatStore.lastActivity().map(a => [a.chat_id, a] as const));
    const skillByChat = lastSkillByChat(root);
    const enrich = (c: ChatRecord) => ({ ...c, lastMessageAt: act.get(c.id)?.last_message_at ?? null, messageCount: act.get(c.id)?.messages ?? 0, lastSkill: skillByChat.get(c.id) ?? null });
    chats = chatStore.list().map(enrich);
    archivedChats = chatStore.list({ includeArchived: true }).filter(c => c.archived === 1).map(enrich);
  } finally { chatStore.close(); }
  const audit = join(root, ".sam", "execution-audit.jsonl");
  let logs: string[] = [];
  if (existsSync(audit)) {
    const raw = readFileSync(audit, "utf8");
    logs = raw.slice(-16000).split("\n").filter(Boolean).slice(-20).map(line => line.slice(0, 800));
  }
  const prefStore = new PreferenceStore(root);
  let preferences: unknown;
  try { preferences = prefStore.list(); }
  finally { prefStore.close(); }
  const observability = observabilityReport(root);
  const actions = listActions(root);
  const jobs = heartbeatJobs(root);
  const people = minis(root);
  const activityLimit = opts.activityLimit ?? 30;
  return {
    ok: true,
    at: new Date().toISOString(),
    missions,
    skills: discoverSkills(root),
    skillInstalled: installedSkills(root),
    schedules: listSchedules(root),
    chats,
    archivedChats,
    skillUse: recentSkillUse(root, 10),
    agents: agents(root),
    config: readDashboardConfig(root),
    connectors: connectors(root).map(c => ({ ...c, credentialPresent: !!process.env[c.tokenEnv] })),
    channels: channels(root).map(c => ({ ...c, credentialPresent: !!process.env[c.tokenEnv] })),
    preferences,
    heartbeatJobs: jobs,
    heartbeatLog: heartbeatLog(root, 8),
    minis: people.map(m => {
      const pStore = new PreferenceStore(root);
      let lawCount = 0;
      try { lawCount = pStore.lawsFor(m.name).length; }
      finally { pStore.close(); }
      return {
        ...m,
        door: doorEnabled(root, m.name),
        laws: lawCount,
        chats: chats.filter(c => c.agent_name === m.name).length,
        heartbeats: jobs.filter(j => j.profile === m.name).length,
      };
    }),
    actions,
    pendingActions: actions.filter(a => a.status === "pending"),
    subagents: listSubagents(root),
    team: teamStatus(root),
    background: listBackgroundTasks(root).slice(-20),
    doors: listDoors(root),
    doorGuard: opts.doorGuard ?? EMPTY_DOOR_GUARD,
    models: modelRoutingTable(),
    usage: usageSummary(root),
    usageToday: usageToday(root),
    drafts: listDrafts(root).slice(-20),
    contacts: listContacts(root),
    compactions: listCompactions(root),
    pairing: pairingStatus(root),
    skillAuthored: authoredSkills(root),
    skillCurator: curatorFindings(root),
    deliveryOutbox: deliverySummary(root),
    bindings: listBindings(root),
    skillAllowlists: skillAllowlists(root),
    approvals: loadApprovalPolicy(root),
    code: codeSummary(root),
    coding: codingSummary(root),
    engine: (() => { const s = engineStatus(root); const c = engineConnectStatus(root); return { ...s, connection: { route: c.route, connected: c.connected, stale: c.stale, record: c.connection } }; })(),
    senses: sensesStatus(),
    brief: briefStatus(root),
    selfAudit: readSelfAudit(root),
    promptAudit: readPromptAudit(root),
    contextAudit: readContextAudit(root),
    loopAudit: readLoopAudit(root),
    evalBattery: readEvalBattery(root),
    vault: vaultStatus(root),
    selfWork: readSelfWork(root),
    selfWorkFixes: selfWorkFixViews(root),
    setup: readSetupRecord(root),
    auth: authStatus(root),
    stackWatch: stackWatchStatus(root),
    unification: unificationReport(root),
    activity: readActivity(root, activityLimit, opts.activity ?? {}),
    logs,
    observability,
    providerHealth: observability.providerHealth,
    spend: observability.spend,
    failures: observability.failures,
    people: people.map(m => m.name),
    standingFiles: standingSummary(root),
    verification: verificationStatus(root),
    goldfish: (() => { const g = goldfishStatus(root); return { state: g.state, verdict: g.latest?.verdict ?? null, uncoveredChanges: g.uncoveredChanges }; })(),
    sessionCaps: (() => { const caps = sessionCaps(); return { maxTurns: caps.maxTurns, maxTokens: caps.maxTokens, cappedToday: sessionUsageToday(root).filter(s => s.capped).map(s => s.chatId) }; })(),
    loops: { open: openLoopCount(root), due: dueLoops(root).length },
    deliveries: (() => { const recent = readDeliveryLedger(root, 500); return { delivered: recent.filter(e => e.deliver).length, suppressed: recent.filter(e => !e.deliver).length }; })(),
  };
}

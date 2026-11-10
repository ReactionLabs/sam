import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { addHeartbeatJob, addScheduledJob } from "./heartbeat.js";
import { compileSchedule, ownerTimezone, scriptArgv, validateTimezone } from "./schedule.js";
import { channels } from "./channels.js";
import { channelForChat } from "./telegram.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { installSkill, scanSkillRef, SkillScanHold } from "./skill-registry.js";
import { validateSkillAuthorDetail, writeAuthoredSkill } from "./skill-author.js";
import { createDraft } from "./drafts.js";
import { approvalAutoVia, classifyProposal, loadApprovalPolicy, scanNeverList, type ProposalRisk } from "./approval-policy.js";
import { pushBranch, validateGitPushDetail } from "./git-work.js";
import { queueEngineTask, validateEngineDetail } from "./engine.js";
import { spawnMini, validateSpawnDetail } from "./minis.js";
import { createLink } from "./links.js";

// Hands, with a gate. SAM (any profile) can PROPOSE an action; nothing executes
// until the owner approves it in the dashboard or by CLI. The executor allowlist
// is deliberately internal-only: save a memory note, set a standing law, create
// a heartbeat job, post a message into one of SAM's own chats, write a
// skill SAM authored itself (Phase B item 3), or (P12, on the
// owner's own program order) save an outbound DRAFT the owner then sends
// themselves - drafting writes only to SAM's own store, there is no send path.
// One further kind rides on the owner's own coder-program order (C4,
// Phase D item 5): "git-push" pushes ONE sam/<task> branch from the
// designated code root to that repository's own origin - the landing
// act for coding-loop work, validated at proposal time so a card that
// cannot execute is never shown, consequential so smart mode can
// never auto-approve it, and with no force flag and no PR creation.
// One more kind rides on the coder program's end state (C6, Phase D
// item 6): "engine" queues a managed Claude Code run inside the C4
// branch sandbox; SAM records, verifies, reviews, and commits the
// engine's work itself, and the run executes nothing until the owner
// approves - approval queues it, the drain runs it.
// No external sends, no service control, no money, no trading - widening this
// list is an owner decision, never a model decision. Every step lands in the
// activity ledger, so a proposal's whole life is auditable.
export type ActionKind = "note" | "law" | "heartbeat" | "say" | "skill" | "draft" | "skill-author" | "git-push" | "engine" | "spawn";
export type ActionStatus = "pending" | "done" | "rejected" | "failed";
export interface ActionProposal {
  id: string; actor: string; kind: ActionKind; title: string; detail: string;
  status: ActionStatus; createdAt: string; decidedAt: string | null; result: string | null;
  chatId: string | null;
  // Note PATCH (Phase B item 2): a kind "note" proposal may name the
  // memory record it supersedes. On approval the new note saves AND
  // that record is archived, so recall stops surfacing the stale text.
  supersedes: string | null;
  // Approvals engine (Phase D item 1): the deterministic risk class
  // stamped at proposal time, and who decided - "owner", or the
  // auto via ("auto:smart" / "auto:off") when the install's approval
  // mode executed it without a card decision. Legacy records read
  // as null for both.
  risk: ProposalRisk | null;
  decidedBy: string | null;
}
const KINDS: ActionKind[] = ["note", "law", "heartbeat", "say", "skill", "draft", "skill-author", "git-push", "engine", "spawn"];
export const ACTION_KINDS: readonly string[] = KINDS;
function actionsFile(root: string): string { return join(resolve(root), ".sam", "actions.json"); }
export function listActions(root: string): ActionProposal[] {
  const file = actionsFile(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? (data as ActionProposal[]).map(a => ({ ...a, chatId: a.chatId ?? null, supersedes: a.supersedes ?? null, risk: a.risk ?? null, decidedBy: a.decidedBy ?? null })) : []; }
  catch { return []; }
}
function saveActions(root: string, items: ActionProposal[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(actionsFile(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
// Profile-reference validation (found live 2026-11-09 on Dip's PC): a
// heartbeat proposal named profile "Second Shift" - the connector's DISPLAY
// name, not a profile - was shown as an approval card, and only on approval
// did execution die with "Invalid profile", leaving a dead card and no job.
// A proposal must never be shown in a form that cannot execute, so the
// profile a heartbeat detail names is checked against the registry at
// PROPOSAL time. "sam" is the implicit core profile (same rule as links.ts
// validMember and the dashboard's default-agent check); every other name
// must be a registered agent profile.
export function knownProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; }
  finally { db.close(); }
}
function normalizeProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// The one unambiguous correction for a bad profile name: exactly one known
// profile matches it once case and separators are folded ("Second Shift"
// -> "second-shift"). Anything else is a guess and is never applied.
export function correctedProfileName(root: string, bad: string): string | null {
  const target = normalizeProfileName(bad ?? "");
  if (!target) return null;
  const matches = knownProfileNames(root).filter(n => normalizeProfileName(n) === target);
  return matches.length === 1 ? matches[0] : null;
}
function validateHeartbeatDetail(root: string, detail: string): void {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid heartbeat detail: expected JSON {name, minutes, profile, prompt}");
  const s = spec as { name?: unknown; minutes?: unknown; profile?: unknown; prompt?: unknown; schedule?: unknown; timezone?: unknown; script?: unknown; channelId?: unknown };
  const profile = typeof s.profile === "string" ? s.profile : "";
  const names = knownProfileNames(root);
  if (!names.includes(profile)) {
    const fix = correctedProfileName(root, profile);
    throw new Error("Unknown profile \"" + profile + "\" in heartbeat detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : ""));
  }
  if (typeof s.name !== "string" || !/^[a-zA-Z0-9 _-]{1,80}$/.test(s.name)) throw new Error("Invalid heartbeat name in detail");
  // A named delivery channel must be a real channel on this
  // install: a job created for a channel that does not exist
  // would deliver nowhere and read as done. Refused here, at
  // proposal time, naming the registry - the same dead-card rule
  // as the profile check above.
  if (s.channelId !== undefined && s.channelId !== null && s.channelId !== "") {
    if (typeof s.channelId !== "string") throw new Error("Invalid channelId in heartbeat detail");
    const known = channels(root);
    if (!known.some(c => c.id === s.channelId)) throw new Error("Unknown channel \"" + s.channelId + "\" in heartbeat detail. Valid channels: " + (known.length ? known.map(c => c.name + " (" + c.id + ")").join(", ") : "none registered"));
  }
  // Real cron (Phase C item 1): a detail may carry a schedule
  // phrase (interval, wall-clock, 5-field cron, natural language,
  // or a one-shot "once at ...") instead of raw minutes - it is
  // compiled at proposal time so an unreadable schedule never
  // reaches a card. Compilation rides the job's own timezone (the
  // detail's, or the owner's default), because a one-shot's date
  // only means anything in that zone. A script detail names one
  // allowlisted no-agent command and needs no prompt; anything
  // else keeps the original minutes + prompt contract exactly.
  const tz = s.timezone !== undefined ? validateTimezone(String(s.timezone)) : ownerTimezone();
  if (typeof s.script === "string" && s.script) {
    scriptArgv(root, s.script); // throws naming the allowlist
    if (typeof s.schedule !== "string" || !s.schedule) throw new Error("A script heartbeat detail needs a schedule");
    compileSchedule(s.schedule, tz);
    return;
  }
  if (typeof s.schedule === "string" && s.schedule) {
    compileSchedule(s.schedule, tz);
  } else if (!Number.isSafeInteger(Number(s.minutes)) || Number(s.minutes) < 5 || Number(s.minutes) > 10080) throw new Error("Invalid heartbeat minutes in detail (5 to 10080)");
  if (typeof s.prompt !== "string" || !s.prompt.trim() || s.prompt.length > 2000) throw new Error("Invalid heartbeat prompt in detail");
}
export function proposeAction(root: string, input: { actor: string; kind: string; title: string; detail: string; chatId?: string | null; supersedes?: string | null }): ActionProposal {
  if (!KINDS.includes(input.kind as ActionKind)) throw new Error("Invalid action kind");
  const title = (input.title ?? "").trim();
  let detail = (input.detail ?? "").trim();
  if (!title || title.length > 200) throw new Error("Invalid action title");
  if (!detail || detail.length > 4000) throw new Error("Invalid action detail");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  if (input.kind === "heartbeat") validateHeartbeatDetail(root, detail);
  // Channel inheritance (Telegram reminder gaps, 2026-11-10): a
  // heartbeat proposed from inside a channel-bound chat (the
  // owner asked on Telegram) inherits that channel as the job's
  // delivery target, so the reminder pings the owner back on the
  // surface they asked from instead of landing silently in a
  // dashboard heartbeat chat. An explicit channelId in the detail
  // always wins; a chat that lives on no channel inherits
  // nothing. The inherited id is written into the stored detail,
  // so the card the owner approves already shows where the job
  // will deliver.
  if (input.kind === "heartbeat" && input.chatId) {
    try {
      const spec = JSON.parse(detail) as { channelId?: unknown };
      if (spec.channelId === undefined || spec.channelId === null || spec.channelId === "") {
        const inherited = channelForChat(root, input.chatId);
        if (inherited) detail = JSON.stringify({ ...spec, channelId: inherited });
      }
    } catch { /* validateHeartbeatDetail already proved the detail parses */ }
  }
  // Skill authoring (Phase B item 3): the draft is validated at
  // proposal time - shape, secret scan, and the ownership rule (a
  // patch may only target a sam-authored skill) - so the owner is
  // never shown a card that cannot execute.
  if (input.kind === "skill-author") validateSkillAuthorDetail(root, detail);
  // Git discipline (Phase D item 5, C4): a push proposal is validated
  // at proposal time - the detail must name a sam/<task> branch that
  // exists in the designated code root's repository, with an origin
  // remote - so the owner is never shown a card that cannot execute,
  // and no other branch (main included) can ever be proposed.
  if (input.kind === "git-push") validateGitPushDetail(root, detail);
  // Managed engine runtime (Phase D item 6, C6): an engine run is
  // validated at proposal time - task shape, a designated GIT code
  // root (the branch sandbox), and the engine binary actually
  // installed - and it needs a chat to report back into (the
  // proposal's own chat, or one named in the detail).
  // Team spawn (Dip, 2026-11-10): creating a new agent is validated at
  // proposal time - fresh name, real person and instructions, a real
  // connector pin - so the card the owner sees can always execute.
  if (input.kind === "spawn") validateSpawnDetail(root, detail);
  if (input.kind === "engine") {
    const parsed = validateEngineDetail(root, detail);
    if (!input.chatId && !parsed.chatId) throw new Error("An engine proposal needs a chat to report back into - propose it from inside a chat, or name chatId in the detail");
  }
  // The hardline never-list (Phase D item 1) binds at PROPOSAL time,
  // in every approval mode: a command-form payload (rm -rf /, a fork
  // bomb, mkfs, dd onto a device, a URL piped to a root shell) is
  // refused outright and never becomes an approval card an owner
  // could rubber-stamp. The refusal is ledgered once; the payload
  // itself is not stored.
  const neverHit = scanNeverList(title + "\n" + detail);
  if (neverHit) {
    recordActivity(root, input.actor, "never-list", "Refused a " + input.kind + " proposal (" + neverHit.id + "): " + title.slice(0, 120));
    throw new Error("Refused by the never-list: this proposal contains " + neverHit.label + ". That can never be proposed or executed in any approval mode; reword it as prose if you only meant to discuss it.");
  }
  const item: ActionProposal = {
    id: randomUUID(), actor: input.actor, kind: input.kind as ActionKind, title, detail,
    status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null,
    chatId: input.chatId ?? null,
    supersedes: input.kind === "note" ? (input.supersedes ?? null) : null,
    risk: classifyProposal(input.kind, input.kind === "note" ? (input.supersedes ?? null) : null).risk,
    decidedBy: null,
  };
  const items = listActions(root); items.push(item); saveActions(root, items);
  recordActivity(root, input.actor, "proposal", "Proposed " + item.kind + ": " + title);
  return item;
}
async function execute(root: string, a: ActionProposal): Promise<string> {
  if (a.kind === "note") {
    const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
    try {
      const scope = a.actor === "sam" ? "core" : "profile:" + a.actor;
      // PATCH execution: the superseded record must still be a live
      // record at the new note's scope, or the patch lands failed
      // rather than silently saving beside a record it cannot retire.
      let old: ReturnType<MemoryStore["get"]> = null;
      if (a.supersedes) {
        old = store.get(a.supersedes);
        if (!old) throw new Error("Cannot patch: record " + a.supersedes + " no longer exists");
        if (old.archived_at) throw new Error("Cannot patch: record " + a.supersedes + " is already archived");
        if (old.scope !== scope) throw new Error("Cannot patch: record " + a.supersedes + " is not in this profile's scope");
      }
      const rec = store.add({ kind: "observation", content: a.detail, source: "owner-approved action " + a.id, scope });
      if (a.supersedes && old) {
        if (!store.archive(old.id)) throw new Error("Cannot patch: record " + old.id + " could not be archived");
        return "Memory note saved (" + rec.id + "), superseding record archived (" + old.id + ")";
      }
      return "Memory note saved (" + rec.id + ")";
    } finally { store.close(); }
  }
  if (a.kind === "law") {
    const store = new PreferenceStore(root);
    try { store.note(a.actor, a.detail, "rule", "owner-approved action " + a.id); return "Standing law set for " + a.actor; }
    finally { store.close(); }
  }
  if (a.kind === "heartbeat") {
    const spec = JSON.parse(a.detail) as { name: string; minutes: number; profile: string; prompt: string; channelId?: string | null; schedule?: string; timezone?: string; script?: string };
    if (spec.schedule) {
      const job = addScheduledJob(root, { name: spec.name, profile: spec.profile, schedule: spec.schedule, timezone: spec.timezone, prompt: spec.prompt, script: spec.script ?? null, channelId: spec.channelId ?? null });
      return "Heartbeat job created (" + job.id + ")";
    }
    const job = addHeartbeatJob(root, spec.name, Number(spec.minutes), spec.profile, spec.prompt, spec.channelId ?? null);
    return "Heartbeat job created (" + job.id + ")";
  }
  if (a.kind === "say") {
    const spec = JSON.parse(a.detail) as { chatId: string; text: string };
    const db = new ChatStore(root);
    try { db.add(spec.chatId, "assistant", spec.text); return "Message posted to chat " + spec.chatId; }
    finally { db.close(); }
  }
  if (a.kind === "draft") {
    // P12 outbound drafting: the approved execution writes a draft record
    // into SAM's own store and stops there. There is no send path; the
    // owner copies the draft and sends it themselves. A contact marked
    // no-drafts refuses here, so the proposal lands as failed, not sent.
    const spec = JSON.parse(a.detail) as { to: string; channel?: string; subject?: string | null; body: string };
    const draft = createDraft(root, { actor: a.actor, to: spec.to, channel: spec.channel, subject: spec.subject ?? null, body: spec.body, via: "proposal" });
    return "Draft saved for " + draft.to + " (" + draft.id + ") - the owner sends it";
  }
  if (a.kind === "skill-author") {
    // Self-authored skills (Phase B item 3): the approved execution
    // writes SAM's own SKILL.md into the discovery root and stamps
    // sam-authored provenance. Internal only - the skill is read as
    // untrusted reference afterwards, never executed by being written.
    const { draft, patch } = validateSkillAuthorDetail(root, a.detail);
    const record = writeAuthoredSkill(root, draft, { actor: a.actor });
    return (patch ? "Patched" : "Authored") + " skill " + record.name + " (v" + record.version + ") - it is now in the installed catalog";
  }
  // Registry skill install. On the AUTO path (the approvals engine
  // executing under the owner's standing policy, never the owner's
  // own tap) the skill's text is content-scanned first: a flagged
  // skill does not execute - SkillScanHold reverts the decision to a
  // pending card in applyDecision, so automation stays cautious and
  // the owner stays sovereign.
  if ((a.decidedBy ?? "").startsWith("auto:")) {
    const flagged = await scanSkillRef(a.detail);
    if (flagged.length) throw new SkillScanHold(flagged);
  }
  if (a.kind === "git-push") {
    // C4 landing: push the one named sam/<task> branch to the code
    // root repository's origin. Validation runs again inside
    // pushBranch, so a record written around the proposal-time
    // checks still cannot push anything else. No force, no PR -
    // the PR stays the owner's click.
    const { branch } = validateGitPushDetail(root, a.detail);
    const pushed = await pushBranch(root, branch);
    return "Pushed branch " + pushed.branch + " to origin (" + pushed.sha.slice(0, 12) + ") - no pull request was opened; that stays the owner's act";
  }
  if (a.kind === "spawn") {
    // Team spawn execution: the agent is created (profile + welcome
    // chat + optional starter digest) and LINKED to its creator in the
    // same act, because a teammate the creator cannot talk to is just
    // another isolated profile. Validation runs again here, so a name
    // taken since the proposal fails the card instead of colliding.
    // A link failure after a successful spawn is reported in the
    // result, not hidden: the agent exists either way.
    const spec = validateSpawnDetail(root, a.detail);
    const mini = spawnMini(root, spec);
    let linkNote = "";
    try {
      const group = createLink(root, a.actor + " + " + spec.name, [a.actor, spec.name]);
      linkNote = "; linked to " + a.actor + " ('" + group.name + "') so they can work together through the link";
    } catch (e) { linkNote = "; the agent exists but linking it to " + a.actor + " failed: " + (e instanceof Error ? e.message : "unknown error"); }
    return "Agent " + mini.name + " created for " + mini.person + " (profile + welcome chat 'Meet " + mini.person + "'" + (spec.starterHeartbeat ? " + a starter daily digest" : "") + ")" + linkNote;
  }
  if (a.kind === "engine") {
    // C6 managed engine runtime: approval QUEUES the run - it does
    // not execute inline. The heartbeat tick (or `engine drain`)
    // runs the engine inside the task's branch sandbox, and SAM
    // records, verifies, reviews, and commits its work before
    // anything counts as done. Validation runs again inside
    // queueEngineTask, so a record written around the proposal-time
    // checks still cannot queue an unrunnable task.
    const { task, chatId } = validateEngineDetail(root, a.detail);
    const queued = queueEngineTask(root, { actor: a.actor, chatId: a.chatId ?? chatId ?? "", spec: task });
    return "Engine run queued (" + queued.id + ") - the managed engine (Claude Code) will run it inside a sam/<task> branch sandbox on the next drain; SAM verifies, reviews, and commits its work, and the summary posts into the chat";
  }
  const summary = await installSkill(root, a.detail, { actor: a.actor });
  if (!summary.installed.length) throw new Error("Nothing installed: " + (summary.skipped.join("; ") || "no skills found"));
  return "Installed skill(s): " + summary.installed.map(i => i.name).join(", ") + (summary.skipped.length ? " (skipped: " + summary.skipped.join("; ") + ")" : "");
}
// One decision path for every decider: the owner (dashboard / CLI)
// and the approvals engine's auto modes. `by` is "owner" or the auto
// via stamp ("auto:smart" / "auto:off"); it lands on the record as
// decidedBy and shapes the ledger lines, so an auto-execution is
// never mistaken for an owner's tap after the fact.
async function applyDecision(root: string, items: ActionProposal[], a: ActionProposal, approve: boolean, by: string): Promise<ActionProposal> {
  const decider = by === "owner" ? "owner" : a.actor;
  a.decidedAt = new Date().toISOString();
  a.decidedBy = by;
  if (!approve) {
    a.status = "rejected"; a.result = by === "owner" ? "Rejected by owner" : "Rejected by " + by;
    saveActions(root, items);
    recordActivity(root, decider, "rejected", a.kind + ": " + a.title);
    return a;
  }
  // The never-list binds again at DECISION time: a record written
  // before the list existed (or written around the gate) can never
  // execute a hardline payload, whoever or whatever approves it.
  const neverHit = scanNeverList(a.title + "\n" + a.detail);
  if (neverHit) {
    a.status = "failed";
    a.result = "Refused by the never-list at decision time (" + neverHit.id + "): " + neverHit.label + " can never execute in any approval mode";
    saveActions(root, items);
    recordActivity(root, decider, "never-list", "Blocked execution of " + a.kind + " " + a.id + " (" + neverHit.id + "): " + a.title.slice(0, 120));
    return a;
  }
  try { a.result = await execute(root, a); a.status = "done"; }
  catch (e) {
    if (e instanceof SkillScanHold && by !== "owner") {
      // An auto-approved skill install the content scan flagged is
      // HELD, not failed: the decision reverts to a pending card and
      // the owner decides with the scan findings on the record. The
      // owner's own approval of the same proposal executes as-is.
      a.status = "pending"; a.decidedAt = null; a.decidedBy = null;
      a.result = "Auto-install held by the skill content scan (" + e.message + ") - waiting for the owner, who can approve it as-is or install it from the CLI";
      saveActions(root, items);
      recordActivity(root, a.actor, "skill-scan-hold", a.kind + ": " + a.title + " - " + e.message);
      return a;
    }
    a.status = "failed"; a.result = e instanceof Error ? e.message : "Execution failed";
    // A failed card must not be a dead end. A heartbeat that died on an
    // unknown profile (a legacy proposal written before proposal-time
    // validation, or a profile removed after proposing) gets a corrected
    // re-proposal when the correction is unambiguous; otherwise the result
    // names the valid profiles so the owner can re-propose with full
    // information instead of guessing from "Invalid profile".
    let reproposal: { detail: string; fix: string } | null = null;
    if (a.kind === "heartbeat") {
      try {
        const spec = JSON.parse(a.detail) as { profile?: unknown };
        const bad = typeof spec?.profile === "string" ? spec.profile : "";
        const names = knownProfileNames(root);
        if (bad && !names.includes(bad)) {
          const fix = correctedProfileName(root, bad);
          if (fix) reproposal = { detail: JSON.stringify({ ...(spec as object), profile: fix }), fix };
          else a.result += ". Valid profiles: " + names.join(", ");
        }
      } catch { /* detail was not JSON; the failure result stands as-is */ }
    }
    saveActions(root, items);
    recordActivity(root, decider, "failed", a.kind + ": " + a.title + " - " + (a.result ?? ""));
    if (reproposal) {
      try {
        const existing = listActions(root).find(x => x.status === "pending" && x.kind === "heartbeat" && x.actor === a.actor && x.detail === reproposal!.detail);
        const np = existing ?? proposeAction(root, { actor: a.actor, kind: a.kind, title: a.title, detail: reproposal.detail, chatId: a.chatId });
        const fresh = listActions(root); const self = fresh.find(x => x.id === a.id);
        if (self) {
          self.result = (self.result ?? "") + " Corrected re-proposal pending approval: " + np.id + " (profile " + reproposal.fix + ")";
          saveActions(root, fresh); a.result = self.result;
        }
        if (!existing) recordActivity(root, decider, "reproposal", "Corrected re-proposal for failed " + a.kind + ": " + a.title + " -> profile " + reproposal.fix);
      } catch { /* a re-proposal that itself refuses (e.g. the never-list) leaves the failure result standing */ }
    }
    return a;
  }
  saveActions(root, items);
  recordActivity(root, decider, by === "owner" ? "approved" : "auto-approved", a.kind + ": " + a.title + " - " + (a.result ?? "") + (by === "owner" ? "" : " [" + by + "]"));
  return a;
}

export async function decideAction(root: string, id: string, approve: boolean): Promise<ActionProposal> {
  const items = listActions(root);
  const a = items.find(x => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "pending") throw new Error("Action already decided");
  return applyDecision(root, items, a, approve, "owner");
}

// Approvals engine settle (Phase D item 1): execute every pending
// proposal the install's approval mode auto-approves, through the
// same decision path the owner uses. In the default manual mode
// this is a no-op by construction. Settle points are the surfaces
// that create proposals inside a live interaction (the chat tool
// layer, the CLI propose verb) plus the operator's `actions settle`
// verb; a proposal the mode does not cover stays pending for the
// owner, exactly as before.
export async function settleAutoApprovals(root: string, onlyId?: string): Promise<ActionProposal[]> {
  const policy = loadApprovalPolicy(root);
  if (policy.mode === "manual") return [];
  const settled: ActionProposal[] = [];
  const candidates = listActions(root).filter(x => x.status === "pending" && (!onlyId || x.id === onlyId));
  for (const candidate of candidates) {
    const auto = approvalAutoVia(policy, candidate.kind, candidate.supersedes);
    if (!auto) continue;
    const items = listActions(root);
    const fresh = items.find(x => x.id === candidate.id);
    if (!fresh || fresh.status !== "pending") continue;
    settled.push(await applyDecision(root, items, fresh, true, auto.via));
  }
  return settled;
}

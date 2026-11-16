import { ChatStore } from "./chats.js";
import {
  addHeartbeatJob, heartbeatJobs, jobNextRun, removeHeartbeatJob, updateHeartbeatJob,
  type HeartbeatJob,
} from "./heartbeat.js";
import { skillsForProfile } from "./skills.js";
import { readStandingFile, writeStandingFile, STANDING_FILE_MAX_CHARS } from "./standing-files.js";
import type { Member } from "./members.js";

// Your Sam (Mission Control, Dip's order 2026-11-16): the member's
// own scoped SAM made visible and tunable - its skills, its two
// standing files, and its heartbeat jobs. Everything here rides the
// machinery a scoped profile already runs on; nothing is a prop.
//
// THE FILE MAPPING, named plainly: a member profile has no literal
// AGENTS.md or SOUL.md of its own today. What it has is the
// standing-file set at .sam/standing/<profile>/, assembled into
// every turn that profile takes (standing-files.ts):
//   - SOUL.md  is the "persona" standing file: who this SAM is for
//     its person, the stable tier, riding right after the base
//     instructions. (The workspace-root SOUL.md in identity.ts is
//     the HOUSE identity, shared by the core profile; it is never
//     a member's file and is never served here.)
//   - AGENTS.md is the "ops" standing file: how the work runs,
//     standing operating notes, the context tier.
// A member who has never saved one gets starter content, not a
// fake file: SOUL starts from the profile's own instructions
// paragraph - the exact words memberInstructions() seeded at spawn,
// which is what a fresh member SAM actually runs on - and AGENTS
// starts from the plain starter operating notes below. The starter
// is served with seeded: true and written nowhere; the member's
// first save is what creates their file, through writeStandingFile
// (which ledgers the save by size, never by content).
//
// HEARTBEATS are the real store (heartbeat.ts): jobs carry the
// owning profile, so a member sees and touches only their own.
// Execution is not a settings museum: the member home is ticked by
// the same `sam heartbeat` CLI the house home runs on (systemd
// sam-member-heartbeat), and a job's turn rides memberConnection -
// the member's own key. A member with no key gets the honest
// cannot-think outcome recorded as the job's failure, never a
// dressed-up success.

export type MemberFileKind = "agents" | "soul";

const FILE_MAP: Record<MemberFileKind, { standing: string; fileName: string; title: string; blurb: string }> = {
  soul: {
    standing: "persona", fileName: "SOUL.md", title: "Who your SAM is",
    blurb: "SAM's personality and voice: how it talks to you, what it cares about, how it carries itself.",
  },
  agents: {
    standing: "ops", fileName: "AGENTS.md", title: "How your SAM works",
    blurb: "Your standing operating rules: how work gets done, what to check first, what always needs your okay.",
  },
};

export function memberFileKind(raw: string): MemberFileKind | null {
  return raw === "agents" || raw === "soul" ? raw : null;
}

const AGENTS_STARTER = [
  "# How your SAM works",
  "",
  "- Work in plain words. No jargon, no machinery talk.",
  "- Before anything big, or hard to undo, ask first and wait for a yes.",
  "- When you finish something, say what you did in a sentence or two.",
  "- If you are not sure about a fact, say so and check. Never guess.",
  "",
  "These are starter rules. Cross them out and write your own, in your",
  "own words: SAM reads this file on every job it runs for you.",
].join("\n");

export interface MemberFileView {
  kind: MemberFileKind; fileName: string; title: string; blurb: string;
  content: string; seeded: boolean; present: boolean; maxChars: number;
}

function profileInstructions(root: string, profile: string): string {
  const db = new ChatStore(root);
  try {
    const agent = db.agents().find(a => a.name === profile);
    return agent ? agent.instructions : "";
  } finally { db.close(); }
}

export function memberFileView(root: string, member: Member, kind: MemberFileKind): MemberFileView {
  const map = FILE_MAP[kind];
  const existing = readStandingFile(root, member.profile, map.standing);
  if (existing !== null) {
    return { kind, fileName: map.fileName, title: map.title, blurb: map.blurb, content: existing, seeded: false, present: true, maxChars: STANDING_FILE_MAX_CHARS };
  }
  const starter = kind === "soul"
    ? (profileInstructions(root, member.profile) || "You are SAM (Secret Agent Man), a personal AI assistant. Speak in plain words, remember what matters, and ask before anything big.")
    : AGENTS_STARTER;
  return { kind, fileName: map.fileName, title: map.title, blurb: map.blurb, content: starter, seeded: true, present: false, maxChars: STANDING_FILE_MAX_CHARS };
}

export function saveMemberFile(root: string, member: Member, kind: MemberFileKind, content: string): MemberFileView {
  const map = FILE_MAP[kind];
  // writeStandingFile validates (non-empty, capped), writes the
  // member's own standing file, and ledgers the save by size only.
  writeStandingFile(root, member.profile, map.standing, content);
  return memberFileView(root, member, kind);
}

export interface MemberSkillView { name: string; description: string }

export function memberSkills(root: string, member: Member): MemberSkillView[] {
  return skillsForProfile(root, member.profile)
    .map(s => ({ name: s.name, description: s.description }));
}

export interface MemberHeartbeatView {
  id: string; name: string; minutes: number; prompt: string;
  enabled: boolean; lastRun: string | null; nextRun: string | null;
}

function heartbeatView(job: HeartbeatJob): MemberHeartbeatView {
  return {
    id: job.id, name: job.name, minutes: job.minutes, prompt: job.prompt,
    enabled: job.enabled, lastRun: job.lastRun,
    nextRun: job.enabled ? (jobNextRun(job)?.toISOString() ?? null) : null,
  };
}

export function memberHeartbeats(root: string, member: Member): MemberHeartbeatView[] {
  return heartbeatJobs(root).filter(j => j.profile === member.profile).map(heartbeatView);
}

export function createMemberHeartbeat(root: string, member: Member, input: { name: string; minutes: number; prompt: string }): MemberHeartbeatView {
  // addHeartbeatJob owns the validation (name shape, interval
  // floor of 5 minutes, prompt present and capped, store cap).
  const job = addHeartbeatJob(root, input.name, input.minutes, member.profile, input.prompt);
  return heartbeatView(job);
}

const NAME_RE = /^[a-zA-Z0-9 _-]{1,80}$/;

export function updateMemberHeartbeat(
  root: string, member: Member, id: string,
  patch: { name?: unknown; minutes?: unknown; prompt?: unknown; enabled?: unknown },
): MemberHeartbeatView | null {
  const job = heartbeatJobs(root).find(j => j.id === id);
  if (!job || job.profile !== member.profile) return null;
  const next: Partial<HeartbeatJob> = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !NAME_RE.test(patch.name.trim())) throw new Error("Give the heartbeat a plain name (letters, numbers, spaces, dashes).");
    const name = patch.name.trim();
    if (heartbeatJobs(root).some(j => j.id !== id && j.name === name)) throw new Error("Another heartbeat already uses that name.");
    next.name = name;
  }
  if (patch.minutes !== undefined) {
    if (typeof patch.minutes !== "number" || !Number.isSafeInteger(patch.minutes) || patch.minutes < 5 || patch.minutes > 10080) {
      throw new Error("How often must be a whole number of minutes, from 5 up to a week (10080).");
    }
    next.minutes = patch.minutes;
  }
  if (patch.prompt !== undefined) {
    if (typeof patch.prompt !== "string" || !patch.prompt.trim() || patch.prompt.length > 2000) throw new Error("Say what SAM should do each time, in a sentence or two.");
    next.prompt = patch.prompt.trim();
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("Enabled must be on or off.");
    next.enabled = patch.enabled;
  }
  const updated = updateHeartbeatJob(root, id, next);
  return updated ? heartbeatView(updated) : null;
}

export function deleteMemberHeartbeat(root: string, member: Member, id: string): boolean {
  const job = heartbeatJobs(root).find(j => j.id === id);
  if (!job || job.profile !== member.profile) return false;
  return removeHeartbeatJob(root, id);
}

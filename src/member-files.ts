import { ChatStore } from "./chats.js";
import {
  artifactContentBytes, getArtifact, getArtifactVersion, listArtifacts, listArtifactVersions,
} from "./artifacts.js";
import { listStandingFiles } from "./standing-files.js";
import { memberFileView, type MemberFileKind } from "./member-sam.js";
import type { Member } from "./members.js";

// Member files (Mission Control maturity pass, Dip's order
// 2026-11-16): one organized home for everything a member's SAM
// makes and keeps for them. The capability was already real in the
// engine - a member's SAM holds the sam_artifact tool and sam_reach
// in its fenced hand (own-tools.ts MEMBER_TOOL_ALLOWLIST), and
// artifacts are stored per profile in the shared artifacts store.
// What was missing was the member's own window onto it: the door
// listed artifact titles inside /panels but offered no way to list,
// open, or read one. This module is that window, plus the unified
// files listing the app's Files view rides:
//
//   - artifacts: the member's deliverables (list, read, versions),
//     each carrying its size and the chat that made it;
//   - standing files: the member's SOUL.md / AGENTS.md, the same
//     files Your Sam edits, listed here as part of the one home.
//
// Isolation is the artifacts store's own rule, ridden not
// re-implemented: every read passes the member's profile, and
// another profile's artifact answers null exactly like a missing
// one, so the door's 404 never confirms another member's world.

export interface MemberArtifactSummaryView {
  id: string;
  title: string;
  kind: string;
  version: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  chatId: string | null;
  chatTitle: string | null;
}

export interface MemberArtifactVersionView {
  version: number;
  title: string;
  createdAt: string;
  sizeBytes: number;
  chatId: string | null;
}

export interface MemberArtifactView extends MemberArtifactSummaryView {
  content: string;
  versions: MemberArtifactVersionView[];
}

export interface MemberFileEntry {
  key: string;
  group: "artifact" | "standing";
  title: string;
  kind: string;
  sizeBytes: number;
  updatedAt: string | null;
  version: number | null;
  chatId: string | null;
  chatTitle: string | null;
  present: boolean;
  seeded: boolean;
  href: string;
}

function chatTitles(root: string, profile: string): Map<string, string> {
  const titles = new Map<string, string>();
  const store = new ChatStore(root);
  try {
    for (const chat of store.list()) {
      if (chat.agent_name === profile) titles.set(chat.id, chat.title);
    }
  } finally { store.close(); }
  return titles;
}

export function memberArtifacts(root: string, member: Member): MemberArtifactSummaryView[] {
  const titles = chatTitles(root, member.profile);
  return listArtifacts(root, member.profile).map(a => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    version: a.version,
    sizeBytes: a.contentBytes,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    chatId: a.createdBy.chatId,
    chatTitle: a.createdBy.chatId ? (titles.get(a.createdBy.chatId) ?? null) : null,
  }));
}

export function memberArtifact(root: string, member: Member, id: string): MemberArtifactView | null {
  const head = getArtifact(root, id, member.profile);
  if (!head) return null;
  const titles = chatTitles(root, member.profile);
  const versions = listArtifactVersions(root, id, member.profile).map(v => ({
    version: v.version,
    title: v.title,
    createdAt: v.createdAt,
    sizeBytes: v.contentBytes,
    chatId: v.createdBy.chatId,
  }));
  return {
    id: head.id,
    title: head.title,
    kind: head.kind,
    version: head.version,
    sizeBytes: artifactContentBytes(head.content),
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
    chatId: head.createdBy.chatId,
    chatTitle: head.createdBy.chatId ? (titles.get(head.createdBy.chatId) ?? null) : null,
    content: head.content,
    versions,
  };
}

export function memberArtifactVersion(root: string, member: Member, id: string, version: number): MemberArtifactView | null {
  const found = getArtifactVersion(root, id, version, member.profile);
  if (!found) return null;
  const head = getArtifact(root, id, member.profile);
  if (!head) return null;
  const titles = chatTitles(root, member.profile);
  return {
    id: found.id,
    title: found.title,
    kind: found.kind,
    version: found.version,
    sizeBytes: artifactContentBytes(found.content),
    createdAt: head.createdAt,
    updatedAt: found.updatedAt,
    chatId: found.createdBy.chatId,
    chatTitle: found.createdBy.chatId ? (titles.get(found.createdBy.chatId) ?? null) : null,
    content: found.content,
    versions: listArtifactVersions(root, id, member.profile).map(v => ({
      version: v.version,
      title: v.title,
      createdAt: v.createdAt,
      sizeBytes: v.contentBytes,
      chatId: v.createdBy.chatId,
    })),
  };
}

const STANDING_KINDS: MemberFileKind[] = ["soul", "agents"];

export function memberFiles(root: string, member: Member): MemberFileEntry[] {
  const entries: MemberFileEntry[] = [];
  for (const a of memberArtifacts(root, member)) {
    entries.push({
      key: "artifact:" + a.id,
      group: "artifact",
      title: a.title,
      kind: a.kind,
      sizeBytes: a.sizeBytes,
      updatedAt: a.updatedAt,
      version: a.version,
      chatId: a.chatId,
      chatTitle: a.chatTitle,
      present: true,
      seeded: false,
      href: "/app/artifacts/" + a.id,
    });
  }
  // Standing-file timestamps ride the store's own list seam; a
  // failure there never sinks the whole listing, the entry just
  // carries no time.
  let standingTimes = new Map<string, string | null>();
  try {
    standingTimes = new Map(listStandingFiles(root, member.profile).map(e => [e.name, e.updatedAt]));
  } catch { /* times are garnish; presence and size come from the view */ }
  const standingName: Record<MemberFileKind, string> = { soul: "persona", agents: "ops" };
  for (const kind of STANDING_KINDS) {
    const view = memberFileView(root, member, kind);
    entries.push({
      key: "standing:" + kind,
      group: "standing",
      title: view.fileName,
      kind,
      sizeBytes: Buffer.byteLength(view.content, "utf8"),
      updatedAt: standingTimes.get(standingName[kind]) ?? null,
      version: null,
      chatId: null,
      chatTitle: null,
      present: view.present,
      seeded: view.seeded,
      href: "/app/your-sam",
    });
  }
  // Newest first; an entry with no time (a never-saved starter
  // file) sorts last, never above real work.
  entries.sort((x, y) => {
    if (x.updatedAt && y.updatedAt) return y.updatedAt.localeCompare(x.updatedAt);
    if (x.updatedAt) return -1;
    if (y.updatedAt) return 1;
    return x.title.localeCompare(y.title);
  });
  return entries;
}

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";

// Standing files per profile (Plan Phase A, item 1 - the Hermes/OpenClaw
// runtime spine). A profile used to be ONE instructions paragraph; now it
// carries up to three owner-written Markdown files, assembled into the
// system prompt in tiers the way both harnesses layer their standing
// files:
//
//   persona - who this SAM is for its person. Tier: stable (rides right
//             after the base instructions and the plain-style default,
//             before the per-turn material).
//   owner   - the brief about the person it serves: facts and context
//             the owner confirmed. Tier: context.
//   ops     - how the work runs: standing operating notes. Tier: context.
//
// The third tier, volatile (visitor note, standing law, correction
// notes), is assembled per turn in agent-turn and always lands AFTER the
// standing files, so law stays the override layer over everything a
// file says. Files live at .sam/standing/<profile>/<name>.md - real
// files the owner can also edit by hand - and the nightly backup carries
// the whole standing directory. A profile's files are visible only to
// that profile: assembly reads exactly one profile's directory, and the
// core profile "sam" has its own.
export type StandingTier = "stable" | "context";
export interface StandingFileDef { name: string; tier: StandingTier; title: string }
export const STANDING_FILES: StandingFileDef[] = [
  { name: "persona", tier: "stable", title: "Persona" },
  { name: "owner", tier: "context", title: "Owner brief" },
  { name: "ops", tier: "context", title: "Ops notes" },
];
export const STANDING_FILE_MAX_CHARS = 12000;

export function standingFileDef(name: string): StandingFileDef | null {
  return STANDING_FILES.find(f => f.name === name) ?? null;
}

// The profiles a standing file may belong to: the core "sam" plus every
// registered agent - the same rule links.ts uses for membership.
export function knownProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name)]; }
  finally { db.close(); }
}
function assertKnownProfile(root: string, profile: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(profile) && profile !== "sam") throw new Error("Invalid profile name: " + profile);
  if (!knownProfileNames(root).includes(profile)) {
    throw new Error("Unknown profile \"" + profile + "\". Known profiles: " + knownProfileNames(root).join(", "));
  }
}
function standingDir(root: string, profile: string): string {
  return join(resolve(root), ".sam", "standing", profile);
}
function standingPath(root: string, profile: string, name: string): string {
  const def = standingFileDef(name);
  if (!def) throw new Error("Unknown standing file \"" + name + "\". Standing files: " + STANDING_FILES.map(f => f.name).join(", "));
  const dir = standingDir(root, profile);
  const path = join(dir, def.name + ".md");
  if (!resolve(path).startsWith(resolve(dir))) throw new Error("Invalid standing file path");
  return path;
}

export interface StandingFileEntry extends StandingFileDef {
  present: boolean; chars: number; updatedAt: string | null;
}
export function listStandingFiles(root: string, profile: string): StandingFileEntry[] {
  assertKnownProfile(root, profile);
  return STANDING_FILES.map(def => {
    const path = standingPath(root, profile, def.name);
    if (!existsSync(path)) return { ...def, present: false, chars: 0, updatedAt: null };
    const st = statSync(path);
    return { ...def, present: true, chars: readFileSync(path, "utf8").length, updatedAt: st.mtime.toISOString() };
  });
}

export function readStandingFile(root: string, profile: string, name: string): string | null {
  assertKnownProfile(root, profile);
  const path = standingPath(root, profile, name);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  if (content.length > STANDING_FILE_MAX_CHARS * 2) throw new Error("Standing file " + name + " for " + profile + " is oversized (" + content.length + " chars); trim it with: sam agents files set");
  return content;
}

export function writeStandingFile(root: string, profile: string, name: string, content: string): StandingFileEntry {
  assertKnownProfile(root, profile);
  const def = standingFileDef(name);
  if (!def) throw new Error("Unknown standing file \"" + name + "\". Standing files: " + STANDING_FILES.map(f => f.name).join(", "));
  const text = (content ?? "").trim();
  if (!text) throw new Error("Standing file content is empty; use clear to remove a standing file");
  if (text.length > STANDING_FILE_MAX_CHARS) throw new Error("Standing file is " + text.length + " chars; the cap is " + STANDING_FILE_MAX_CHARS);
  const dir = standingDir(root, profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(standingPath(root, profile, name), text + "\n", { mode: 0o600 });
  recordActivity(root, profile, "standing-file", "Standing file " + def.name + " (" + def.tier + ") set, " + text.length + " chars");
  return listStandingFiles(root, profile).find(e => e.name === def.name)!;
}

export function clearStandingFile(root: string, profile: string, name: string): boolean {
  assertKnownProfile(root, profile);
  const path = standingPath(root, profile, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  recordActivity(root, profile, "standing-file", "Standing file " + name + " cleared");
  return true;
}

// One line per profile that carries at least one standing file - the
// read model behind the dashboard status and the CLI overview.
export function standingSummary(root: string): Array<{ profile: string; files: string[]; chars: number }> {
  const out: Array<{ profile: string; files: string[]; chars: number }> = [];
  for (const profile of knownProfileNames(root)) {
    const entries = listStandingFiles(root, profile).filter(e => e.present);
    if (entries.length) out.push({ profile, files: entries.map(e => e.name), chars: entries.reduce((n, e) => n + e.chars, 0) });
  }
  return out;
}

// The standing-file parts of one profile's prompt, split by tier. Empty
// strings when the profile carries no files, so a profile without files
// gets byte-for-byte the prompt it had before standing files existed.
export function standingPromptParts(root: string, profile: string): { stable: string; context: string } {
  const section = (def: StandingFileDef, content: string) =>
    "Standing file \"" + def.title + "\" for this profile (owner-written, part of the " + def.tier + " tier):\n" + content.trim();
  let stable = "", context = "";
  try {
    for (const def of STANDING_FILES) {
      const content = readStandingFile(root, profile, def.name);
      if (!content || !content.trim()) continue;
      if (def.tier === "stable") stable = stable ? stable + "\n\n" + section(def, content) : section(def, content);
      else context = context ? context + "\n\n" + section(def, content) : section(def, content);
    }
  } catch { /* a broken standing file never breaks a turn; the CLI surfaces it */ }
  return { stable, context };
}

// Prompt tier assembly (Phase A): stable first (base, style, persona),
// then context (the role line with the profile's instructions paragraph,
// then the owner brief and ops notes), then volatile (visitor note and
// standing law) LAST so law overrides anything the earlier tiers say.
// Parts join deterministically; empty parts leave no trace.
export function composeSystemPrompt(parts: {
  base: string; style: string; stable: string; role: string; context: string; volatile: string; law: string;
}): string {
  const head = [parts.base, parts.style].filter(s => s && s.trim()).join(" ");
  const tiers = [parts.stable, parts.role, parts.context].filter(s => s && s.trim());
  const tail = [parts.volatile.trim(), parts.law.trim()].filter(Boolean).join(" ");
  return [head, ...tiers, tail].filter(s => s && s.trim()).join("\n\n");
}

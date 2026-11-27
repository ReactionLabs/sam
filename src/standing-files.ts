import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

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

function normalizeStandingFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source carrying the standing-file NAME refusal text:
 *  standingPath and writeStandingFile each improvised the same
 *  "Unknown standing file" text inline - it echoed the value and
 *  named the registry but offered NO fold correction, so a
 *  folded name ("Persona", "PERSONA", "owner ") dead-ended at
 *  the door that picks which standing file a profile's prompt
 *  assembles. standingFileBlocker carries the refusal (value
 *  echoed, the three standing files named as the registry, fold
 *  correction when exactly one file name matches folded for
 *  case and separators); both seams throw it before any path
 *  is built or any file is read or written. The folded
 *  registry has no collisions, so a correction is never
 *  ambiguous. standingFileDef stays a permissive lookup for
 *  internal callers that already hold a canonical name. */
export function standingFileBlocker(name: unknown): string | null {
  if (typeof name === "string" && standingFileDef(name)) return null;
  const target = typeof name === "string" ? normalizeStandingFileName(name) : "";
  const matches = target ? STANDING_FILES.filter(f => normalizeStandingFileName(f.name) === target) : [];
  const fix = matches.length === 1 ? matches[0]!.name : null;
  return "Unknown standing file \"" + String(name) + "\". Standing files: " + STANDING_FILES.map(f => f.name).join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

// The profiles a standing file may belong to: the core "sam" plus every
// registered agent - the same rule links.ts uses for membership.
export function knownProfileNames(root: string): string[] {
  const db = new ChatStore(root);
  try { return ["sam", ...db.agents().map(a => a.name)]; }
  finally { db.close(); }
}
function normalizeStandingProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source carrying the standing-files door's profile
 *  refusal text (per-field audit, 2026-11-25): assertKnownProfile
 *  checked the profile against the registry inline and refused
 *  with its own wording ("Known profiles", not the common
 *  "Valid profiles") and NO fold correction, while every
 *  sibling profile door names both - and a folded name
 *  ("Second Shift" for "second-shift") never even reached
 *  that refusal, dying on the format check in front of it.
 *  standingFileProfileBlocker carries the refusal text (valid
 *  profiles listed, fold correction when exactly one
 *  matches); assertKnownProfile throws it for an unknown
 *  well-formed name and for a malformed name that folds to
 *  exactly one registered profile, and keeps the existing
 *  "Invalid profile name" refusal for a malformed name that
 *  folds to nothing, so the gate's shape is unchanged - the
 *  gate already lived at this store (list/read/write/clear
 *  all assert here, and the CLI agents files doors ride
 *  them), so every caller refuses in the same words before
 *  anything is read or written. */
export function standingFileProfileBlocker(root: string, profile: string): string | null {
  const names = knownProfileNames(root);
  if (names.includes(profile)) return null;
  const target = normalizeStandingProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizeStandingProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in standing file detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
function assertKnownProfile(root: string, profile: string): void {
  const blocker = standingFileProfileBlocker(root, profile);
  if (!blocker) return;
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(profile) && profile !== "sam" && !blocker.includes("Did you mean")) {
    throw new Error("Invalid profile name: " + profile);
  }
  throw new Error(blocker);
}
function standingDir(root: string, profile: string): string {
  return join(resolve(root), ".sam", "standing", profile);
}
function standingPath(root: string, profile: string, name: string): string {
  const def = standingFileDef(name);
  if (!def) throw new Error(standingFileBlocker(name)!);
  const dir = standingDir(root, profile);
  const path = join(dir, def.name + ".md");
  if (!resolve(path).startsWith(resolve(dir))) throw new Error("Invalid standing file path");
  return path;
}

export interface StandingFileEntry extends StandingFileDef {
  present: boolean; chars: number; updatedAt: string | null;
}

// One ledger line per failed standing-file READ (gap found
// 2026-11-14): standingPromptParts used to swallow every read
// failure in one whole-loop catch - a broken persona silently
// vanished from every system prompt (and took the healthy
// files after it with it), indistinguishable from the owner
// clearing the files, and listStandingFiles / readStandingFile
// threw raw out of status and the CLI with no line anywhere.
// The line names the profile and the file and carries the
// verbatim reason collapsed + capped; the file's CONTENT
// never enters it (owner-written briefs are private context).
export function standingFileFailureSummary(profile: string, name: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Standing file read failed for profile " + profile + " (" + name + "): " + clean).slice(0, 200);
}

/**
 * The reason a standing-file-failed line carries (census sprint
 * 2026-11-17): recordStandingFileFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function standingFileFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordStandingFileFailure(root: string, profile: string, name: string, error: unknown): void {
  const reason = standingFileFailureReason(error);
  recordActivity(root, profile, "standing-file-failed", standingFileFailureSummary(profile, name, reason));
}

// The standing file failed history scorecard (2026-11-24, the
// measured-proof series): every failed standing-file read
// ledgers a "standing-file-failed" line through the ONE writer
// above (standingFileFailureSummary, fixed shape "Standing file
// read failed for profile <profile> (<name>): <reason>", actor
// the profile itself) - and while self-work's classifyDefect
// labels single lines and the config-acts scorecard folds the
// SUCCESS kind ("standing-file" set / cleared lines), no
// surface folds this kind, so a broken standing file - a dead
// read means a persona silently drops out of every prompt that
// profile assembles, the exact failure the seam was built to
// surface - can fail on every turn with nothing counting the
// class in aggregate. Every failure line is by construction a
// read that did not complete, so the verdict is attention when
// any failure was ever recorded or any line is unparseable,
// else clear. This parser is strict: only the fixed shape
// parses (the profile is the writer's own alphabet - a
// lowercase-led name of at most 64 chars - the file name is
// one of the three fixed standing files, persona / owner /
// ops), and a non-empty reason is required and consumed, never
// printed - a reason can carry a filesystem path and never
// surfaces here, and no profile or file name ever enters the
// fold (distinct values surface as numbers only). A line from
// any other kind never parses. A pure read: it creates
// nothing, reads no standing file, and assembles nothing -
// the read seams themselves are untouched.
export function parseStandingFileFailedSummary(summary: string): { profile: string; name: string } | null {
  const m = /^Standing file read failed for profile ([a-z][a-z0-9._-]{0,63}) \((persona|owner|ops)\): ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[3] ?? "").trim()) return null;
  return { profile: m[1] ?? "", name: m[2] ?? "" };
}

export function standingFileFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "standing-file-failed" });
  let failed = 0;
  let unparseable = 0;
  const profiles = new Set<string>();
  const names = new Set<string>();
  for (const line of lines) {
    const parsed = parseStandingFileFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      profiles.add(parsed.profile);
      names.add(parsed.name);
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Standing file failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(profiles.size) + " distinct profiles");
  parts.push(String(names.size) + " distinct files");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function tagStandingFileReadLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { standingFileReadLedgered?: boolean }).standingFileReadLedgered = true;
  }
}

export function isStandingFileReadLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { standingFileReadLedgered?: boolean }).standingFileReadLedgered === true;
}

export function listStandingFiles(root: string, profile: string): StandingFileEntry[] {
  assertKnownProfile(root, profile);
  return STANDING_FILES.map(def => {
    const path = standingPath(root, profile, def.name);
    // The list seam fails closed (the house read precedent):
    // standingSummary folds this list as truth into the status
    // payload, so a dead file's touch ledgers ONE
    // standing-file-failed line and rethrows exactly instead
    // of dying raw or folding the file as absent.
    try {
      if (!existsSync(path)) return { ...def, present: false, chars: 0, updatedAt: null };
      const st = statSync(path);
      return { ...def, present: true, chars: readFileSync(path, "utf8").length, updatedAt: st.mtime.toISOString() };
    } catch (error) {
      recordStandingFileFailure(root, profile, def.name, error);
      throw error;
    }
  });
}

export function readStandingFile(root: string, profile: string, name: string): string | null {
  assertKnownProfile(root, profile);
  const path = standingPath(root, profile, name);
  // The read seam owns its failure (gap found 2026-11-14): a
  // failed filesystem touch - and the oversize refusal, which
  // is this file's own broken state - ledgers ONE
  // standing-file-failed line, tags the error (the
  // session-caps precedent, so standingPromptParts records
  // nothing more for the same touch), and rethrows exactly.
  // An absent file still reads null and ledgers nothing.
  let content: string;
  try {
    if (!existsSync(path)) return null;
    content = readFileSync(path, "utf8");
  } catch (error) {
    recordStandingFileFailure(root, profile, name, error);
    tagStandingFileReadLedgered(error);
    throw error;
  }
  if (content.length > STANDING_FILE_MAX_CHARS * 2) {
    const error = new Error("Standing file " + name + " for " + profile + " is oversized (" + content.length + " chars); trim it with: sam agents files set");
    recordStandingFileFailure(root, profile, name, error);
    tagStandingFileReadLedgered(error);
    throw error;
  }
  return content;
}

// The ONE writers for the standing-file activity lines, so
// the config-acts scorecard's parser can never drift from
// the seams it counts. Their shapes are byte-identical to
// what writeStandingFile / clearStandingFile wrote inline
// before these writers existed.
export function standingFileSetLedgerSummary(name: string, tier: string, chars: number): string {
  return "Standing file " + name + " (" + tier + ") set, " + chars + " chars";
}
export function standingFileClearedLedgerSummary(name: string): string {
  return "Standing file " + name + " cleared";
}

export function writeStandingFile(root: string, profile: string, name: string, content: string): StandingFileEntry {
  assertKnownProfile(root, profile);
  const def = standingFileDef(name);
  if (!def) throw new Error(standingFileBlocker(name)!);
  const text = (content ?? "").trim();
  if (!text) throw new Error("Standing file content is empty; use clear to remove a standing file");
  if (text.length > STANDING_FILE_MAX_CHARS) throw new Error("Standing file is " + text.length + " chars; the cap is " + STANDING_FILE_MAX_CHARS);
  const dir = standingDir(root, profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(standingPath(root, profile, name), text + "\n", { mode: 0o600 });
  recordActivity(root, profile, "standing-file", standingFileSetLedgerSummary(def.name, def.tier, text.length));
  return listStandingFiles(root, profile).find(e => e.name === def.name)!;
}

export function clearStandingFile(root: string, profile: string, name: string): boolean {
  assertKnownProfile(root, profile);
  const path = standingPath(root, profile, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  recordActivity(root, profile, "standing-file", standingFileClearedLedgerSummary(name));
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
  // Per-file guard (gap found 2026-11-14): a broken standing
  // file still never breaks a turn, but it no longer vanishes
  // silently or takes its siblings with it - the failed read
  // ledgers exactly ONE standing-file-failed line (inside
  // readStandingFile for its own touches, here for any other
  // per-file failure), that file is skipped, and the remaining
  // files still assemble.
  for (const def of STANDING_FILES) {
    let content: string | null;
    try {
      content = readStandingFile(root, profile, def.name);
    } catch (error) {
      if (!isStandingFileReadLedgered(error)) recordStandingFileFailure(root, profile, def.name, error);
      continue;
    }
    if (!content || !content.trim()) continue;
    if (def.tier === "stable") stable = stable ? stable + "\n\n" + section(def, content) : section(def, content);
    else context = context ? context + "\n\n" + section(def, content) : section(def, content);
  }
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

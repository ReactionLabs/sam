import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { discoverSkills, parseSkillMetadata, type SkillEntry } from "./skills.js";
import { installedSkills } from "./skill-registry.js";
import { proposeAction, type ActionProposal } from "./actions.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";

// Skill authoring + curator (Plan Phase B item 3, Hermes borrow: the
// agent writes its own skills and a background curator keeps the
// library clean). SAM can already find, install, list, and read
// skills; this is the author path beside install.
//
// AUTHORING: after a workflow works, SAM drafts a SKILL.md from it.
// A draft is a change to what SAM knows, so it rides the ONE proposal
// gate (kind "skill-author") exactly like a registry install does in
// chat: nothing is written until the owner approves. The executor
// (actions.ts) writes through writeAuthoredSkill here, which
// validates again, stages the file, and proves the written skill
// parses and discovers before it counts. Provenance lives in
// .sam/skill-authors.db (source "sam-authored"), beside the
// registry's skill-installs.db. A draft may PATCH a skill only
// when that skill is sam-authored; registry installs and hand-placed
// skills refuse at proposal time - SAM never overwrites someone
// else's playbook. Visitors author nothing (P12: a visitor is not
// the owner).
//
// Validation fences, all deterministic: the name shape the skill
// parser requires, a description long enough for auto-selection to
// match against (the catalog matches tasks to descriptions; a stub
// description makes the skill invisible in practice), an instruction
// body that fits both the proposal detail budget and the chat
// reader's cap, and a secret scan - a skill that carries a credential
// is refused, never written. Skills are read as untrusted reference
// and never executed; authoring does not change that.
//
// CURATOR: heartbeat consolidation runs curateSkills every tick.
// The pass is deterministic - no model call, so the cheap tier the
// plan assigns it costs zero. It flags what it can prove from the
// files themselves: duplicate instruction bodies under different
// names, near-duplicate descriptions (auto-selection cannot tell
// the skills apart), a skill shadowed by an earlier root's same-name
// copy (discovery takes the first, so the shadowed copy never
// loads), an orphaned provenance record whose skill is gone, and an
// unmatchable description. Each finding carries a suggested patch in
// words; findings persist in .sam/skill-curator.db and a changed
// finding set writes ONE curator ledger line, so a standing problem
// is reported once, not every 15 minutes. Usage-based staleness (a
// skill nobody loads) is NOT claimed: SAM has no skill-use tracking,
// so the curator stays silent about it rather than faking a signal.
export interface SkillDraft { name: string; description: string; instructions: string }
export interface AuthoredSkill { name: string; source: "sam-authored"; actor: string; version: number; createdAt: string; updatedAt: string }

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
export const MIN_DESCRIPTION_CHARS = 12;
export const MAX_DESCRIPTION_CHARS = 300;
export const MIN_INSTRUCTION_CHARS = 40;
export const MAX_INSTRUCTION_CHARS = 3200;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "it contains a private key block"],
  [/\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i, "it appears to contain a credential value"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "it appears to contain an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "it appears to contain a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "it appears to contain an AWS access key"],
];

export function validateSkillDraft(input: { name?: unknown; description?: unknown; instructions?: unknown }): SkillDraft {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!SKILL_NAME_RE.test(name)) throw new Error("Invalid skill name (lowercase letters, digits, hyphens and underscores, starting with a letter or digit)");
  const description = typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : "";
  if (description.length < MIN_DESCRIPTION_CHARS || description.length > MAX_DESCRIPTION_CHARS) throw new Error("Invalid skill description (" + MIN_DESCRIPTION_CHARS + " to " + MAX_DESCRIPTION_CHARS + " characters - it must say what the skill is for, because task matching reads it)");
  if (/["\n]/.test(description)) throw new Error("Invalid skill description (one line, no double quotes)");
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  if (instructions.length < MIN_INSTRUCTION_CHARS || instructions.length > MAX_INSTRUCTION_CHARS) throw new Error("Invalid skill instructions (" + MIN_INSTRUCTION_CHARS + " to " + MAX_INSTRUCTION_CHARS + " characters)");
  if (instructions.includes("\0")) throw new Error("Invalid skill instructions (binary content refused)");
  for (const [pattern, reason] of SECRET_PATTERNS) {
    if (pattern.test(description) || pattern.test(instructions)) throw new Error("Skill draft refused: " + reason + ". Skills never carry credentials; name the env var or vault entry the operator supplies instead.");
  }
  return { name, description, instructions };
}

export function renderSkillMarkdown(draft: SkillDraft): string {
  return "---\nname: " + draft.name + "\ndescription: " + draft.description + "\n---\n\n" + draft.instructions.trim() + "\n";
}

function authorsFile(root: string): string { return join(resolve(root), ".sam", "skill-authors.json"); }
function authorsDbFile(root: string): string { return join(resolve(root), ".sam", "skill-authors.db"); }
// State convergence (UNIFICATION item 4, twenty-first store): the
// authored-skill provenance registry is SQLite (.sam/skill-authors.db,
// the skill-installs pattern), one row per authored skill keyed by its
// name holding the record's full JSON, rowid order = the old file
// order. The old skill-authors.json was rewritten whole on every
// authoring and every patch's version bump, with writers in the CLI
// and in every process that executes an approved skill-author proposal
// through the ONE gate, so two writers holding the same snapshot
// silently lost the second one's change: an authored skill's
// provenance could vanish (its SKILL.md orphaned on disk, and the
// ownership check then refusing to let SAM patch its own skill), or a
// version bump could revert. Here each mutation is a single-row INSERT
// or UPDATE, and connections carry a busy_timeout so a writer waits
// out a peer's transaction instead of dying on "database is locked".
// First open imports a legacy skill-authors.json in file order and
// renames it skill-authors.json.migrated - imported, never deleted; a
// malformed file or a non-array payload imports nothing and is left in
// place (the migrated shape reads it as no records, exactly the old
// forgiving contract). A pure read on an install with neither file
// creates nothing. The P9 backup snapshots every .sam/*.db
// generically, so the migrated store is carried with no backup change.
function openAuthorsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(authorsDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS skill_authors (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyAuthors(db, root);
  return db;
}
function migrateLegacyAuthors(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_authors").get() as { n: number };
  if (n > 0) return;
  const file = authorsFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO skill_authors (name, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Partial<AuthoredSkill>;
      if (typeof rec.name !== "string" || !rec.name) continue;
      insert.run(rec.name, JSON.stringify(rec));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToAuthored(data: string): AuthoredSkill | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as AuthoredSkill : null; }
  catch { return null; }
}
function authorsStoreExists(root: string): boolean {
  return existsSync(authorsDbFile(root)) || existsSync(authorsFile(root));
}
export function authoredSkills(root: string): AuthoredSkill[] {
  if (!authorsStoreExists(root)) return [];
  const db = openAuthorsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM skill_authors ORDER BY rowid").all() as Array<{ data: string }>;
    const items: AuthoredSkill[] = [];
    for (const row of rows) { const rec = rowToAuthored(row.data); if (rec) items.push(rec); }
    return items;
  } finally { db.close(); }
}
function findAuthoredRow(root: string, name: string): AuthoredSkill | null {
  if (!authorsStoreExists(root)) return null;
  const db = openAuthorsStore(root);
  try {
    const row = db.prepare("SELECT data FROM skill_authors WHERE name = ?").get(name) as { data: string } | undefined;
    return row ? rowToAuthored(row.data) : null;
  } finally { db.close(); }
}
function upsertAuthoredRow(root: string, rec: AuthoredSkill): void {
  const db = openAuthorsStore(root);
  try {
    db.prepare("INSERT INTO skill_authors (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data").run(rec.name, JSON.stringify(rec));
  } finally { db.close(); }
}
// The store's update door (the skill-installs precedent): patch one
// authored skill record by name through the store's own shape. The
// name is immutable. Returns the updated record, or null when no such
// record exists - and a miss on an install with no store at all
// creates nothing.
export function updateAuthoredSkill(root: string, name: string, patch: Partial<AuthoredSkill>): AuthoredSkill | null {
  if (!name || !authorsStoreExists(root)) return null;
  const current = findAuthoredRow(root, name);
  if (!current) return null;
  const next: AuthoredSkill = { ...current, ...patch, name: current.name };
  const db = openAuthorsStore(root);
  try { db.prepare("UPDATE skill_authors SET data = ? WHERE name = ?").run(JSON.stringify(next), current.name); }
  finally { db.close(); }
  return next;
}

// The proposal-time ownership check (the dead-card lesson: a draft
// that cannot execute is never shown). Returns true when the draft
// patches an existing sam-authored skill, false for a fresh name,
// and throws when the name belongs to a skill SAM did not author.
export function skillDraftIsPatch(root: string, name: string): boolean {
  const existing = discoverSkills(root).find(s => s.name === name);
  if (!existing) return false;
  if (!authoredSkills(root).some(a => a.name === name)) {
    throw new Error("Skill \"" + name + "\" already exists (from " + existing.source + ") and was not authored by SAM, so SAM cannot overwrite it. Choose a new name, or the owner can remove that skill first.");
  }
  return true;
}

export function validateSkillAuthorDetail(root: string, detail: string): { draft: SkillDraft; patch: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { throw new Error("Invalid skill draft detail: expected JSON {name, description, instructions}"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid skill draft detail: expected JSON {name, description, instructions}");
  const draft = validateSkillDraft(parsed as { name?: unknown; description?: unknown; instructions?: unknown });
  return { draft, patch: skillDraftIsPatch(root, draft.name) };
}

export type ProposeSkillResult = { status: "pending_owner_approval"; patch: boolean; proposal: ActionProposal };

export function proposeAuthoredSkill(root: string, input: { actor: string; name: string; description: string; instructions: string; chatId?: string | null }): ProposeSkillResult {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  if (input.chatId) {
    const chats = new ChatStore(root);
    try { if (chats.isVisitor(input.chatId)) throw new Error("Visitors cannot author skills: a visitor is not the owner"); }
    finally { chats.close(); }
  }
  const { draft, patch } = validateSkillAuthorDetail(root, JSON.stringify({ name: input.name, description: input.description, instructions: input.instructions }));
  const proposal = proposeAction(root, {
    actor: input.actor, kind: "skill-author",
    title: (patch ? "Patch skill: " : "New skill: ") + draft.name,
    detail: JSON.stringify(draft), chatId: input.chatId ?? null,
  });
  recordActivity(root, input.actor, "skill-gated", (patch ? "Skill patch" : "Skill draft") + " routed to owner approval: " + draft.name + " - " + draft.description.slice(0, 120));
  return { status: "pending_owner_approval", patch, proposal };
}

// The write itself, reached only from the approved executor or the
// operator's own CLI act. Re-validates everything (the detail could
// have been written before a rule tightened), stages beside the
// final directory, and verifies the result through the same
// discovery + parse path every reader uses before recording
// provenance. A failed verification removes the staged write.
export function writeAuthoredSkill(root: string, draftInput: SkillDraft, opts: { actor: string }): AuthoredSkill {
  const draft = validateSkillDraft(draftInput);
  const patch = skillDraftIsPatch(root, draft.name);
  const markdown = renderSkillMarkdown(draft);
  if (parseSkillMetadata(markdown)?.name !== draft.name) throw new Error("Authored skill failed its own metadata parse");
  const skillsRoot = join(resolve(root), ".agents", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const staging = join(skillsRoot, ".staging-author-" + draft.name);
  const finalDir = join(skillsRoot, draft.name);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, "SKILL.md"), markdown);
    if (patch) rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const written = discoverSkills(root).find(s => s.name === draft.name);
  if (!written) {
    rmSync(finalDir, { recursive: true, force: true });
    throw new Error("Authored skill " + draft.name + " failed validation after write and was removed");
  }
  const now = new Date().toISOString();
  const prior = findAuthoredRow(root, draft.name);
  const record: AuthoredSkill = prior
    ? { ...prior, actor: opts.actor, version: prior.version + 1, updatedAt: now }
    : { name: draft.name, source: "sam-authored", actor: opts.actor, version: 1, createdAt: now, updatedAt: now };
  upsertAuthoredRow(root, record);
  recordActivity(root, opts.actor, patch ? "skill-patched" : "skill-authored", (patch ? "Patched" : "Authored") + " skill " + draft.name + " (v" + record.version + "): " + draft.description.slice(0, 120));
  return record;
}

// --- Curator ---

export type CuratorFindingKind = "duplicate-content" | "duplicate-description" | "shadowed" | "orphaned-provenance" | "unmatchable-description";
export interface CuratorFinding { id: string; kind: CuratorFindingKind; skills: string[]; detail: string; suggestedPatch: string }

function bodyOf(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim().replace(/\s+/g, " ");
}
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(t => t.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
function findingId(kind: string, skills: string[]): string {
  return createHash("sha256").update(kind + ":" + [...skills].sort().join("+")).digest("hex").slice(0, 12);
}
function readSkillBody(root: string, entry: SkillEntry): string {
  try {
    const path = join(resolve(root), entry.path);
    if (!lstatSync(path).isFile()) return "";
    return bodyOf(readFileSync(path, "utf8"));
  } catch { return ""; }
}

// Raw per-root scan for shadowing: discovery keeps the FIRST skill of
// a name across the roots (.agents/skills before skills), so a later
// same-name copy is provably dead weight - it can never load.
function shadowedSkills(root: string): CuratorFinding[] {
  const findings: CuratorFinding[] = [];
  const seen = new Map<string, string>();
  for (const folder of [".agents/skills", "skills"]) {
    const dir = join(resolve(root), folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        const meta = parseSkillMetadata(readFileSync(file, "utf8"));
        if (!meta) continue;
        const kept = seen.get(meta.name);
        if (kept !== undefined && kept !== folder) {
          findings.push({
            id: findingId("shadowed", [meta.name]), kind: "shadowed", skills: [meta.name],
            detail: "Skill \"" + meta.name + "\" exists in both " + kept + " and " + folder + "; discovery loads the " + kept + " copy, so the " + folder + " copy never loads.",
            suggestedPatch: "Remove the " + folder + " copy of " + meta.name + ", or rename it if it was meant to be a different skill.",
          });
        } else if (kept === undefined) seen.set(meta.name, folder);
      } catch { /* an unreadable skill is discovery's problem, already invisible */ }
    }
  }
  return findings;
}

export function curateSkills(root: string): CuratorFinding[] {
  const skills = discoverSkills(root);
  const findings: CuratorFinding[] = [...shadowedSkills(root)];
  // Duplicate bodies: the same playbook under two names.
  const byBody = new Map<string, string[]>();
  for (const skill of skills) {
    const body = readSkillBody(root, skill);
    if (body.length < MIN_INSTRUCTION_CHARS) continue;
    const hash = createHash("sha256").update(body).digest("hex");
    byBody.set(hash, [...(byBody.get(hash) ?? []), skill.name]);
  }
  for (const names of byBody.values()) {
    if (names.length < 2) continue;
    const sorted = [...names].sort();
    findings.push({
      id: findingId("duplicate-content", sorted), kind: "duplicate-content", skills: sorted,
      detail: "Skills " + sorted.join(" and ") + " carry identical instructions under different names.",
      suggestedPatch: "Keep one name (the one the owner would say), remove the other, and note the surviving name in the kept skill's description if both names were in use.",
    });
  }
  // Near-duplicate descriptions: auto-selection matches on the
  // description, so two skills it cannot tell apart will misfire.
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];
      const ta = tokens(a.description), tb = tokens(b.description);
      if (ta.size < 4 || tb.size < 4) continue;
      const score = jaccard(ta, tb);
      if (score < 0.75) continue;
      if (byBodyHasBoth(byBody, a.name, b.name)) continue; // already the duplicate-content finding
      const pair = [a.name, b.name].sort();
      findings.push({
        id: findingId("duplicate-description", pair), kind: "duplicate-description", skills: pair,
        detail: "Skills " + pair.join(" and ") + " have near-identical descriptions (similarity " + score.toFixed(2) + "), so task matching cannot tell them apart.",
        suggestedPatch: "Rewrite one description to name what makes that skill different - its subject, not the shared verb.",
      });
    }
  }
  // Unmatchable descriptions: too thin for the catalog to match a
  // task against, whatever the instructions say.
  for (const skill of skills) {
    if (skill.description.trim().length >= MIN_DESCRIPTION_CHARS && skill.description.trim() !== ">") continue;
    findings.push({
      id: findingId("unmatchable-description", [skill.name]), kind: "unmatchable-description", skills: [skill.name],
      detail: "Skill \"" + skill.name + "\" has a description too short to match a task against (\"" + skill.description.slice(0, 40) + "\"), so auto-selection will never pick it.",
      suggestedPatch: skillDraftIsPatchSafe(root, skill.name)
        ? "Patch the skill through sam_author_skill with a description that says what task it is for."
        : "The owner can replace its description with one that says what task it is for, or remove the skill.",
    });
  }
  // Orphaned provenance: an install/author record whose skill is
  // gone. The record claims a capability SAM no longer holds.
  const live = new Set(skills.map(s => s.name));
  for (const rec of installedSkills(root)) {
    if (live.has(rec.name)) continue;
    findings.push({
      id: findingId("orphaned-provenance", [rec.name]), kind: "orphaned-provenance", skills: [rec.name],
      detail: "Registry provenance records skill \"" + rec.name + "\" (from " + rec.source + ") but no such skill is installed anymore.",
      suggestedPatch: "Remove the stale record with `skills remove " + rec.name + "` semantics reviewed by the owner, or reinstall the skill.",
    });
  }
  for (const rec of authoredSkills(root)) {
    if (live.has(rec.name)) continue;
    findings.push({
      id: findingId("orphaned-provenance", [rec.name]), kind: "orphaned-provenance", skills: [rec.name],
      detail: "Authored-skill provenance records \"" + rec.name + "\" (v" + rec.version + ") but no such skill is installed anymore.",
      suggestedPatch: "Re-author the skill if it is still wanted, or let the owner clear the stale provenance record.",
    });
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
function byBodyHasBoth(byBody: Map<string, string[]>, a: string, b: string): boolean {
  for (const names of byBody.values()) if (names.includes(a) && names.includes(b)) return true;
  return false;
}
function skillDraftIsPatchSafe(root: string, name: string): boolean {
  try { return skillDraftIsPatch(root, name); } catch { return false; }
}

export interface CuratorState { lastRun: string; hash: string; findings: CuratorFinding[] }
function curatorFile(root: string): string { return join(resolve(root), ".sam", "skill-curator.json"); }
function curatorDbFile(root: string): string { return join(resolve(root), ".sam", "skill-curator.db"); }
// State convergence (UNIFICATION item 4, twenty-second store): the
// curator's findings state is SQLite (.sam/skill-curator.db, the
// skill-installs pattern), ONE row holding the state's full JSON so
// the singleton keeps its exact shape. The old skill-curator.json
// was rewritten whole by runSkillCurator on every consolidation
// tick (every 15 minutes - the lastRun stamp alone forced the
// rewrite) and on every CLI curator run, with writers in two
// processes, so two writers holding the same snapshot silently
// lost the second one's state: the changed-set hash that
// suppresses a duplicate curator ledger line could revert, and a
// torn write read back as no findings. Here each run is a
// single-row UPSERT and connections carry a busy_timeout. First
// open imports a legacy skill-curator.json and renames it
// skill-curator.json.migrated - imported, never deleted; a
// malformed file or a non-object payload imports nothing and is
// left in place (the migrated shape reads it as no findings,
// exactly the old forgiving contract). A pure read on an install
// with neither file creates nothing. The P9 backup snapshots
// every .sam/*.db generically, so the migrated store is carried
// with no backup change.
function openCuratorStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(curatorDbFile(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS skill_curator (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyCurator(db, root);
  return db;
}
function migrateLegacyCurator(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM skill_curator WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = curatorFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  db.prepare("INSERT OR IGNORE INTO skill_curator (id, data) VALUES (1, ?)").run(JSON.stringify(data));
  renameSync(file, file + ".migrated");
}
function rowToCuratorState(data: string): CuratorState | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as Partial<CuratorState>;
    return {
      lastRun: typeof state.lastRun === "string" ? state.lastRun : "",
      hash: typeof state.hash === "string" ? state.hash : "",
      findings: Array.isArray(state.findings) ? state.findings : [],
    };
  } catch { return null; }
}
function curatorStoreExists(root: string): boolean {
  return existsSync(curatorDbFile(root)) || existsSync(curatorFile(root));
}
// The store's read door (the pairing precedent): the full curator
// state (lastRun + hash + findings) through the store's own shape,
// or null when no pass has ever persisted one - and a read on an
// install with no store at all creates nothing.
export function readCuratorState(root: string): CuratorState | null {
  if (!curatorStoreExists(root)) return null;
  const db = openCuratorStore(root);
  try {
    const row = db.prepare("SELECT data FROM skill_curator WHERE id = 1").get() as { data: string } | undefined;
    return row ? rowToCuratorState(row.data) : null;
  } finally { db.close(); }
}
export function curatorFindings(root: string): CuratorFinding[] {
  return readCuratorState(root)?.findings ?? [];
}

// One consolidation pass: recompute, persist, and ledger ONLY when
// the finding set changed - a standing duplicate is one report, not
// a heartbeat of nagging. Returns what the tick should log.
export function runSkillCurator(root: string): { findings: CuratorFinding[]; changed: boolean } {
  const findings = curateSkills(root);
  const hash = createHash("sha256").update(findings.map(f => f.id).join(",")).digest("hex");
  const priorHash = readCuratorState(root)?.hash ?? "";
  const changed = hash !== priorHash;
  const state: CuratorState = { lastRun: new Date().toISOString(), hash, findings };
  const db = openCuratorStore(root);
  try {
    db.prepare("INSERT INTO skill_curator (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(state));
  } finally { db.close(); }
  if (changed && findings.length) {
    recordActivity(root, "sam", "skill-curator", "Skill curator flagged " + findings.length + " issue(s): " + findings.map(f => f.kind + " (" + f.skills.join(", ") + ")").join("; ").slice(0, 300));
  }
  return { findings, changed };
}

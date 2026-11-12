import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  source: string;
}

const ROOTS = [".agents/skills", "skills"] as const;
const MAX_SKILLS = 200;
const MAX_FILE_BYTES = 64 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

export function parseSkillMetadata(markdown: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || match[1].length > 8192) return;
  const values: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entry = /^(name|description):\s*(.*?)\s*$/.exec(lines[i]);
    if (!entry) continue;
    const key = entry[1];
    const raw = entry[2];
    const block = /^([>|])[+-]?[0-9]?\s*(?:#.*)?$/.exec(raw);
    if (!block) { values[key] = raw.replace(/^(['"])(.*)\1$/, "$2"); continue; }
    // YAML block scalar (description: > or |): the value lives on the
    // following indented lines. Popular skills (agent-reach among them)
    // write descriptions this way; a single-line parser reads the
    // literal ">" and the skill becomes unmatchable. Folded joins the
    // lines of a paragraph with spaces, literal keeps the newlines;
    // chomping is a trim either way, which suits a metadata value.
    const blockLines: string[] = [];
    let indent = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") { blockLines.push(""); continue; }
      const lineIndent = /^[ \t]*/.exec(line)![0].length;
      if (lineIndent === 0) break;
      if (indent === -1) indent = lineIndent;
      if (lineIndent < indent) break;
      blockLines.push(line.slice(indent));
    }
    i = j - 1;
    while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
    if (block[1] === "|") {
      values[key] = blockLines.join("\n").trim();
    } else {
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const blockLine of blockLines) {
        if (blockLine === "") { if (current.length > 0) { paragraphs.push(current.join(" ")); current = []; } }
        else current.push(blockLine);
      }
      if (current.length > 0) paragraphs.push(current.join(" "));
      values[key] = paragraphs.join("\n").trim();
    }
  }
  if (!values.name || !values.description || values.name.length > 100 || values.description.length > 1000 ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(values.name)) return;
  return { name: values.name, description: values.description };
}

/** Read-only project-local Agent Skills discovery. No scripts or skill instructions are executed. */
export function discoverSkills(workspace: string): SkillEntry[] {
  const base = resolve(workspace);
  if (!existsSync(base) || !lstatSync(base).isDirectory()) throw new Error("Workspace must be a directory");
  const actualBase = realpathSync(base);
  const found: SkillEntry[] = [];
  const names = new Set<string>();
  for (const folder of ROOTS) {
    const root = join(base, folder);
    if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) continue;
    if (!inside(actualBase, realpathSync(root))) continue;
    const dirs = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (found.length >= MAX_SKILLS) return found;
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const directory = join(root, dir.name);
      if (!inside(actualBase, realpathSync(directory))) continue;
      const file = join(directory, "SKILL.md");
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
      if (!inside(actualBase, realpathSync(file))) continue;
      const parsed = parseSkillMetadata(readFileSync(file, "utf8"));
      if (!parsed || names.has(parsed.name)) continue;
      names.add(parsed.name);
      found.push({ ...parsed, path: relative(base, file), source: folder });
    }
  }
  return found;
}

export function findSkill(workspace: string, name: string): SkillEntry {
  const skill = discoverSkills(workspace).find(item => item.name === name);
  if (!skill) throw new Error("Skill not found: " + name);
  return skill;
}

/** Search installed skill metadata without loading or executing skill instructions. */
export function searchSkills(workspace: string, query: string): SkillEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || terms.length > 12 || query.length > 200) throw new Error("Skill search requires 1 to 12 terms (max 200 characters)");
  return discoverSkills(workspace).filter(skill => {
    const haystack = (skill.name + " " + skill.description).toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

// Per-profile skill allowlists (Plan Phase C item 3): the installed library
// is global, but what a profile may USE is scoped. .sam/skill-allowlists.json
// maps a profile to the skill names it may hold; a profile with NO entry is
// unrestricted (the pre-allowlist behavior, so existing installs change
// nothing until the owner sets one), and an entry - even an empty one -
// means the profile sees, catalogues, and reads only the named skills.
// Enforcement lives at the reader (skillsForProfile / readSkillForProfile),
// which every chat surface rides, so no surface can leak around the list.
// The operator/CLI surfaces (skills list/read) stay global on purpose: the
// owner manages the whole library; profiles live inside their list.
function allowlistPath(workspace: string): string { return join(resolve(workspace), ".sam", "skill-allowlists.json"); }
function allowlistsDbFile(workspace: string): string { return join(resolve(workspace), ".sam", "skill-allowlists.db"); }
const profilePattern = /^[a-z][a-z0-9._-]{0,63}$/;
// State convergence (UNIFICATION item 4, eighteenth store): the skill
// allowlist registry is SQLite (.sam/skill-allowlists.db, the
// contacts/bindings pattern), one row per profile keyed by profile
// holding that profile's names JSON, rowid order = the old object
// order. The old skill-allowlists.json was rewritten whole on every
// set and clear, and its writers (the CLI) ran beside skillAllowlist
// readers on every turn's skill catalog and the dashboard status
// build, so two writers holding the same snapshot silently lost the
// second one's change - fence-shaped here: a profile just fenced to
// a smaller playbook set could revert to unrestricted under a
// concurrent save. Here each mutation is a single-row INSERT/UPDATE
// or DELETE, and connections carry a busy_timeout so a writer waits
// out a peer's transaction instead of dying on "database is locked".
// First open imports a legacy skill-allowlists.json entry by entry
// and renames it skill-allowlists.json.migrated - imported, never
// deleted; a malformed file or a non-object payload imports nothing
// and is left in place (the migrated shape reads it as no
// allowlists - every profile unrestricted, the pre-allowlist
// behavior - instead of throwing "Invalid skill allowlists store",
// the channels/minis precedent). A pure read on an install with
// neither file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with no
// backup change.
function openAllowlistsStore(workspace: string): Database.Database {
  const dir = join(resolve(workspace), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(allowlistsDbFile(workspace));
  db.exec("CREATE TABLE IF NOT EXISTS skill_allowlists (profile TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyAllowlists(db, workspace);
  return db;
}
function migrateLegacyAllowlists(db: Database.Database, workspace: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_allowlists").get() as { n: number };
  if (n > 0) return;
  const file = allowlistPath(workspace);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO skill_allowlists (profile, data) VALUES (?, ?)");
  const importAll = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [profile, names] of entries) {
      if (!profilePattern.test(profile)) continue;
      if (!Array.isArray(names) || !names.every(n => typeof n === "string")) continue;
      insert.run(profile, JSON.stringify(names));
    }
  });
  importAll(Object.entries(data as Record<string, unknown>));
  renameSync(file, file + ".migrated");
}
function rowToNames(data: string): string[] | null {
  try {
    const value: unknown = JSON.parse(data);
    return Array.isArray(value) && value.every(n => typeof n === "string") ? value as string[] : null;
  } catch { return null; }
}
function allowlistStoreExists(workspace: string): boolean {
  return existsSync(allowlistsDbFile(workspace)) || existsSync(allowlistPath(workspace));
}
export function skillAllowlists(workspace: string): Record<string, string[]> {
  if (!allowlistStoreExists(workspace)) return {};
  const db = openAllowlistsStore(workspace);
  try {
    const rows = db.prepare("SELECT profile, data FROM skill_allowlists ORDER BY rowid").all() as Array<{ profile: string; data: string }>;
    const out: Record<string, string[]> = {};
    for (const row of rows) { const names = rowToNames(row.data); if (names) out[row.profile] = names; }
    return out;
  } finally { db.close(); }
}
export function skillAllowlist(workspace: string, profile: string): string[] | null {
  if (!allowlistStoreExists(workspace)) return null;
  const db = openAllowlistsStore(workspace);
  try {
    const row = db.prepare("SELECT data FROM skill_allowlists WHERE profile = ?").get(profile) as { data: string } | undefined;
    return row ? rowToNames(row.data) : null;
  } finally { db.close(); }
}
function cleanAllowlistNames(workspace: string, names: string[]): string[] {
  const known = discoverSkills(workspace).map(s => s.name);
  const clean = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const unknown = clean.filter(n => !known.includes(n));
  if (unknown.length) throw new Error("Unknown skill(s): " + unknown.join(", ") + ". Installed skills: " + (known.length ? known.join(", ") : "(none)"));
  return clean;
}
export function setSkillAllowlist(workspace: string, profile: string, names: string[] | null): string[] | null {
  if (!profilePattern.test(profile)) throw new Error("Invalid profile: " + profile);
  if (names === null) {
    if (allowlistStoreExists(workspace)) {
      const db = openAllowlistsStore(workspace);
      try { db.prepare("DELETE FROM skill_allowlists WHERE profile = ?").run(profile); } finally { db.close(); }
    }
    recordActivity(workspace, profile, "skill-allowlist", "Skill allowlist cleared for profile " + profile + " (unrestricted)");
    return null;
  }
  const clean = cleanAllowlistNames(workspace, names);
  const db = openAllowlistsStore(workspace);
  try { db.prepare("INSERT INTO skill_allowlists (profile, data) VALUES (?, ?) ON CONFLICT(profile) DO UPDATE SET data = excluded.data").run(profile, JSON.stringify(clean)); }
  finally { db.close(); }
  recordActivity(workspace, profile, "skill-allowlist", "Skill allowlist set for profile " + profile + ": " + (clean.length ? clean.join(", ") : "(none - no skills)"));
  return [...clean];
}
// The store's update door (the contacts precedent): patch one
// profile's allowlist by profile through the store's own shape,
// validated exactly as setSkillAllowlist validates installed names.
// Returns the updated list, or null when no such entry exists - and
// a miss on an install with no store at all creates nothing.
export function updateSkillAllowlist(workspace: string, profile: string, names: string[]): string[] | null {
  if (!profilePattern.test(profile)) throw new Error("Invalid profile: " + profile);
  if (!allowlistStoreExists(workspace)) return null;
  if (skillAllowlist(workspace, profile) === null) return null;
  const clean = cleanAllowlistNames(workspace, names);
  const db = openAllowlistsStore(workspace);
  try {
    const result = db.prepare("UPDATE skill_allowlists SET data = ? WHERE profile = ?").run(JSON.stringify(clean), profile);
    if (result.changes === 0) return null;
  } finally { db.close(); }
  return [...clean];
}
/** The skills one profile may hold: the whole library, or its allowlist. */
export function skillsForProfile(workspace: string, profile: string): SkillEntry[] {
  const allow = skillAllowlist(workspace, profile);
  const all = discoverSkills(workspace);
  return allow === null ? all : all.filter(s => allow.includes(s.name));
}
/** readSkill fenced by the profile's allowlist: a skill outside the list
 * refuses with its real reason, exactly like a skill that is not installed,
 * so the model can report the fence instead of guessing around it. */
export function readSkillForProfile(workspace: string, profile: string, name: string): { name: string; description: string; untrusted: true; instructions: string } {
  const allow = skillAllowlist(workspace, profile);
  if (allow !== null && !allow.includes(name)) throw new Error("Skill not on profile " + profile + "'s allowlist: " + name);
  return readSkill(workspace, name);
}

/** Load a validated installed skill as untrusted reference material, never execute it. */
export function readSkill(workspace: string, name: string): { name: string; description: string; untrusted: true; instructions: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)) throw new Error("Invalid skill name");
  const skill = findSkill(workspace, name);
  const base = realpathSync(resolve(workspace));
  const path = resolve(base, skill.path);
  if (!inside(base, path)) throw new Error("Skill outside workspace");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Unsafe skill file");
  if (!inside(base, realpathSync(path))) throw new Error("Skill outside workspace");
  const instructions = readFileSync(path, "utf8");
  if (instructions.includes("\\0")) throw new Error("Binary skill denied");
  if (instructions.length > 16000) throw new Error("Skill instructions exceed 16000 characters");
  return { name: skill.name, description: skill.description, untrusted: true, instructions };
}

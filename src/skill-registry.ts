import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { discoverSkills, parseSkillMetadata } from "./skills.js";
import { recordActivity } from "./activity.js";

// skills.sh, the open agent skills directory, wired into SAM natively.
// Find: the directory's public search API (no key). Install: the skill's
// directory fetched from its GitHub repo, validated file by file, and placed
// where SAM's discovery already looks (.agents/skills). SAM reads skills as
// untrusted reference and never executes their content; installing one is a
// change to what SAM knows, so in chat it rides the approval gate, and on the
// CLI it is the operator's own act. Every install is provenance-recorded.
export interface RegistrySkill { id: string; source: string; skillId: string; name: string; installs: number; installRef: string | null }
export interface InstalledSkill { name: string; source: string; ref: string; files: number; installedAt: string; actor: string }
const apiBase = () => process.env.SKILLS_API_URL ?? "https://skills.sh";
const ghApi = () => process.env.SKILLS_GITHUB_API_URL ?? "https://api.github.com";
const ghRaw = () => process.env.SKILLS_GITHUB_RAW_URL ?? "https://raw.githubusercontent.com";
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "SAM skill registry", Accept: "text/plain, application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("Fetch failed (HTTP " + res.status + ") for " + url.split("?")[0]);
  return await res.text();
}
async function getJson(url: string): Promise<Record<string, unknown>> {
  const text = await getText(url);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("Registry returned invalid JSON"); }
}

export async function searchSkillRegistry(query: string, limit = 10): Promise<RegistrySkill[]> {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) throw new Error("Search query must be 2 to 100 characters");
  const n = Math.min(25, Math.max(1, Math.floor(limit) || 10));
  const data = await getJson(apiBase() + "/api/search?q=" + encodeURIComponent(q) + "&limit=" + n);
  const rows = Array.isArray(data.skills) ? data.skills as Array<Record<string, unknown>> : [];
  return rows.map(r => {
    const source = String(r.source ?? ""); const skillId = String(r.skillId ?? "");
    // The install route is GitHub-only, so a result gets a ready-made
    // installRef only when its source is a GitHub owner/repo (GitHub
    // owners never contain a dot; a dotted source like
    // skills.volces.com is hosted elsewhere). Composing a ref from
    // the row id instead produced owner "skills.volces.com" and a
    // GitHub 404 - the model now copies installRef verbatim, or
    // picks a different result when it is null.
    const installRef = skillId && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(source) ? source + "@" + skillId : null;
    return {
      id: String(r.id ?? ""), source, skillId,
      name: String(r.name ?? ""), installs: typeof r.installs === "number" ? r.installs : 0, installRef,
    };
  }).filter(r => r.source && r.name);
}

export function parseSkillRef(ref: string): { owner: string; repo: string; skill?: string } {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[@/]([A-Za-z0-9_.-]+))?$/.exec(ref.trim());
  if (!m) throw new Error("Skill reference must look like owner/repo or owner/repo@skill-name");
  if (m[1].includes(".")) throw new Error("Skill reference owner \"" + m[1] + "\" is not a GitHub owner (GitHub names never contain a dot) - this skill is hosted outside GitHub and cannot be installed through the registry route; pick a search result with an installRef");
  return { owner: m[1], repo: m[2], skill: m[3] };
}

function installsFile(root: string): string { return join(resolve(root), ".sam", "skill-installs.json"); }
function installsDbFile(root: string): string { return join(resolve(root), ".sam", "skill-installs.db"); }
// State convergence (UNIFICATION item 4, twentieth store): the skill
// provenance registry is SQLite (.sam/skill-installs.db, the drafts
// pattern), one row per installed skill keyed by its name holding the
// record's full JSON, rowid order = the old file order. The old
// skill-installs.json was rewritten whole on every install and every
// remove, with writers in the CLI and in every process that executes
// an approved or smart-auto skill proposal through the ONE gate, so
// two writers holding the same snapshot silently lost the second
// one's change: an installed skill's provenance could vanish (its
// files orphaned from the registry the curator checks), or a removed
// skill's record could resurrect, claiming provenance for a directory
// that is gone. Here each mutation is a single-row INSERT or DELETE,
// and connections carry a busy_timeout so a writer waits out a peer's
// transaction instead of dying on "database is locked". First open
// imports a legacy skill-installs.json in file order and renames it
// skill-installs.json.migrated - imported, never deleted; a malformed
// file or a non-array payload imports nothing and is left in place
// (the migrated shape reads it as no installs, exactly the old
// forgiving contract). A pure read on an install with neither file
// creates nothing. The P9 backup snapshots every .sam/*.db
// generically, so the migrated store is carried with no backup change.
function openInstallsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(installsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS skill_installs (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyInstalls(db, root);
  return db;
}
function migrateLegacyInstalls(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_installs").get() as { n: number };
  if (n > 0) return;
  const file = installsFile(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO skill_installs (name, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Partial<InstalledSkill>;
      if (typeof rec.name !== "string" || !rec.name) continue;
      insert.run(rec.name, JSON.stringify(rec));
    }
  });
  importAll(data);
  renameSync(file, file + ".migrated");
}
function rowToInstalled(data: string): InstalledSkill | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? value as InstalledSkill : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(installsDbFile(root)) || existsSync(installsFile(root));
}
export function installedSkills(root: string): InstalledSkill[] {
  if (!storeExists(root)) return [];
  const db = openInstallsStore(root);
  try {
    const rows = db.prepare("SELECT data FROM skill_installs ORDER BY rowid").all() as Array<{ data: string }>;
    const items: InstalledSkill[] = [];
    for (const row of rows) { const rec = rowToInstalled(row.data); if (rec) items.push(rec); }
    return items;
  } finally { db.close(); }
}
function findInstalledRow(root: string, name: string): InstalledSkill | null {
  if (!storeExists(root)) return null;
  const db = openInstallsStore(root);
  try {
    const row = db.prepare("SELECT data FROM skill_installs WHERE name = ?").get(name) as { data: string } | undefined;
    return row ? rowToInstalled(row.data) : null;
  } finally { db.close(); }
}
function insertInstalledRow(root: string, rec: InstalledSkill): void {
  const db = openInstallsStore(root);
  try { db.prepare("INSERT INTO skill_installs (name, data) VALUES (?, ?)").run(rec.name, JSON.stringify(rec)); }
  finally { db.close(); }
}
// The store's update door (the drafts precedent): patch one installed
// skill record by name through the store's own shape. The name is
// immutable. Returns the updated record, or null when no such record
// exists - and a miss on an install with no store at all creates
// nothing.
export function updateInstalledSkill(root: string, name: string, patch: Partial<InstalledSkill>): InstalledSkill | null {
  if (!name || !storeExists(root)) return null;
  const current = findInstalledRow(root, name);
  if (!current) return null;
  const next: InstalledSkill = { ...current, ...patch, name: current.name };
  const db = openInstallsStore(root);
  try { db.prepare("UPDATE skill_installs SET data = ? WHERE name = ?").run(JSON.stringify(next), current.name); }
  finally { db.close(); }
  return next;
}

interface TreeEntry { path: string; type: string; mode?: string; size?: number }
interface Candidate { dir: string; skillMdPath: string; name: string; markdown: string }

interface FetchedSkills { source: string; owner: string; repo: string; entries: TreeEntry[]; selected: Candidate[] }

// Fetch and select the install candidates for a ref WITHOUT writing
// anything: the one download both installSkill (which writes) and
// scanSkillRef (which only reads, for the auto-install content scan)
// ride, so the two can never disagree about what a ref contains.
async function fetchSkillCandidates(ref: string): Promise<FetchedSkills> {
  const { owner, repo, skill } = parseSkillRef(ref);
  const source = owner + "/" + repo;
  const treeData = await getJson(ghApi() + "/repos/" + owner + "/" + repo + "/git/trees/HEAD?recursive=1");
  if (treeData.truncated) throw new Error("Repository tree too large to install safely");
  const entries = (Array.isArray(treeData.tree) ? treeData.tree : []) as TreeEntry[];
  const skillMdPaths = entries.filter(e => e.type === "blob" && (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))).map(e => e.path);
  if (!skillMdPaths.length) throw new Error("No SKILL.md found in " + source);
  const candidates: Candidate[] = [];
  for (const path of skillMdPaths) {
    const markdown = await getText(ghRaw() + "/" + owner + "/" + repo + "/HEAD/" + path);
    const meta = parseSkillMetadata(markdown);
    if (!meta) continue;
    candidates.push({ dir: path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length), skillMdPath: path, name: meta.name, markdown });
  }
  if (!candidates.length) throw new Error("No valid SKILL.md found in " + source);
  const selected = skill ? candidates.filter(c => c.name === skill || (c.dir && c.dir.split("/").pop() === skill)) : candidates;
  if (skill && !selected.length) throw new Error("Skill not found in " + source + ": " + skill);
  return { source, owner, repo, entries, selected };
}

// --- Skill content scan -------------------------------------------
// Deterministic wording tripwires over a skill's SKILL.md text: the
// shapes a poisoned skill uses to bend the agent reading it
// (instruction override, approval bypass, credential exfiltration,
// pipe-to-shell). The scan gates ONLY the auto-install path (see
// actions.ts): a flagged skill waits for the owner instead of
// installing itself. An owner's own approval or CLI install is
// sovereign and is never blocked by the scan. Scope: the SKILL.md
// markdown, the instruction surface a skill presents first;
// reference files ride the same untrusted-reference framing.
export interface SkillScanHit { id: string; label: string }
const SKILL_SCAN_PATTERNS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "ignore-instructions", label: "tells the agent to ignore its previous instructions", pattern: /\bignore\b[^.\n]{0,48}\b(previous|prior|above|earlier|system)\b[^.\n]{0,32}\b(instructions?|prompts?|rules?)\b/i },
  { id: "disregard-rules", label: "tells the agent to disregard its instructions or rules", pattern: /\bdisregard\b[^.\n]{0,48}\b(instructions?|rules?|law|prompts?|guidelines?)\b/i },
  { id: "override-gate", label: "tells the agent to override or bypass its rules, approvals or gates", pattern: /\b(override|bypass|circumvent|skip)\b[^.\n]{0,48}\b(instructions?|rules?|law|approvals?|gates?|guardrails?|restrictions?)\b/i },
  { id: "exfiltrate-credentials", label: "asks for credentials to be sent, shared or revealed", pattern: /\b(send|post|upload|share|leak|exfiltrate|reveal|disclose|print|show|give)\b[^.\n]{0,64}\b(api[-_ ]?keys?|access tokens?|auth tokens?|passwords?|secrets?|credentials?|private keys?)\b/i },
  { id: "pipe-to-shell", label: "pipes a downloaded URL into a shell", pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|da|z)?sh\b/i },
];
export function scanSkillContent(text: string): SkillScanHit[] {
  const hits: SkillScanHit[] = [];
  for (const p of SKILL_SCAN_PATTERNS) if (p.pattern.test(text ?? "")) hits.push({ id: p.id, label: p.label });
  return hits;
}
export class SkillScanHold extends Error {
  readonly flagged: Array<{ name: string; hits: SkillScanHit[] }>;
  constructor(flagged: Array<{ name: string; hits: SkillScanHit[] }>) {
    super("flagged skill content: " + flagged.map(f => f.name + " [" + f.hits.map(h => h.id).join(", ") + "]").join("; "));
    this.name = "SkillScanHold";
    this.flagged = flagged;
  }
}
export async function scanSkillRef(ref: string): Promise<Array<{ name: string; hits: SkillScanHit[] }>> {
  const { selected } = await fetchSkillCandidates(ref);
  return selected.map(c => ({ name: c.name, hits: scanSkillContent(c.markdown) })).filter(s => s.hits.length > 0);
}

export async function installSkill(root: string, ref: string, opts: { actor: string }): Promise<{ installed: InstalledSkill[]; skipped: string[] }> {
  const { source, owner, repo, entries, selected } = await fetchSkillCandidates(ref);
  const existing = new Set(discoverSkills(root).map(s => s.name));
  const installed: InstalledSkill[] = [];
  const skipped: string[] = [];
  const skillsRoot = join(resolve(root), ".agents", "skills");
  for (const cand of selected) {
    if (existing.has(cand.name)) { skipped.push(cand.name + " (already installed)"); continue; }
    const prefix = cand.dir ? cand.dir + "/" : "";
    const files = entries.filter(e => e.type === "blob" && e.path.startsWith(prefix) && e.path !== cand.skillMdPath);
    const staging = join(skillsRoot, ".staging-" + cand.name);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    let total = 0; let written = 0; const notes: string[] = [];
    try {
      writeFileSync(join(staging, "SKILL.md"), cand.markdown);
      total += cand.markdown.length; written++;
      for (const f of files.slice(0, MAX_FILES)) {
        const rel = f.path.slice(prefix.length);
        if (!rel || rel.includes("..")) continue;
        if (f.mode === "120000") { notes.push(rel + " (symlink refused)"); continue; }
        if (typeof f.size === "number" && f.size > MAX_FILE_BYTES) { notes.push(rel + " (too large)"); continue; }
        const content = await getText(ghRaw() + "/" + owner + "/" + repo + "/HEAD/" + f.path);
        if (content.includes("\0")) { notes.push(rel + " (binary skipped)"); continue; }
        total += content.length;
        if (total > MAX_TOTAL_BYTES) throw new Error("Skill exceeds total size cap");
        const target = join(staging, rel);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content);
        written++;
      }
      const finalDir = join(skillsRoot, cand.name);
      if (existsSync(finalDir)) { skipped.push(cand.name + " (directory already present)"); rmSync(staging, { recursive: true, force: true }); continue; }
      renameSync(staging, finalDir);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    if (!discoverSkills(root).some(s => s.name === cand.name)) {
      rmSync(join(skillsRoot, cand.name), { recursive: true, force: true });
      skipped.push(cand.name + " (failed validation after install)");
      continue;
    }
    const record: InstalledSkill = { name: cand.name, source, ref, files: written, installedAt: new Date().toISOString(), actor: opts.actor };
    insertInstalledRow(root, record); installed.push(record); existing.add(cand.name);
    skipped.push(...notes.map(n => cand.name + ": " + n));
    recordActivity(root, opts.actor, "skill", "Installed skill " + cand.name + " from " + source + " (" + written + " files)");
  }
  return { installed, skipped };
}

export function removeInstalledSkill(root: string, name: string): boolean {
  const rec = findInstalledRow(root, name);
  if (!rec) return false;
  rmSync(join(resolve(root), ".agents", "skills", name), { recursive: true, force: true });
  const db = openInstallsStore(root);
  let removed = false;
  try {
    const result = db.prepare("DELETE FROM skill_installs WHERE name = ?").run(name);
    removed = result.changes > 0;
  } finally { db.close(); }
  if (!removed) return false;
  recordActivity(root, "operator", "skill", "Removed skill " + name + " (was from " + rec.source + ")");
  return true;
}

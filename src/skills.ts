import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

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

function metadata(markdown: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || match[1].length > 8192) return;
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (entry) values[entry[1]] = entry[2].replace(/^(['"])(.*)\1$/, "$2");
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
      const parsed = metadata(readFileSync(file, "utf8"));
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

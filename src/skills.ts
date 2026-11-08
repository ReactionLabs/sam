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

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fleet Pattern Catalog: LOCAL incident patterns from our own
 * record plus IMPORTED watch-patterns (seeded 2026-11-09 from the
 * Netflix performance-agent writeup). Fresh-context reviewers check
 * diffs against every entry and name hits by catalog ID.
 *
 * The source of truth is the fleet runbook
 * (~/workspace/runbooks/PATTERN-CATALOG.md); the copy shipped at the
 * SAM repo root (pattern-catalog.md) is the mirror every install
 * carries. When SAM's work surfaces a new defect class, the lane
 * adds the entry to BOTH in the same change - that is how the
 * catalog stays alive instead of becoming shelf-ware.
 *
 * Resolution order for a running install: SAM_PATTERN_CATALOG env,
 * then <workspace>/pattern-catalog.md, then the app root copy.
 */

export interface PatternCatalog { text: string; ids: string[]; source: string }

const MAX_CATALOG_BYTES = 64 * 1024;

export function catalogIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/^## ((?:LOCAL|IMPORTED)-[0-9]+):/gm)) ids.push(match[1]);
  return ids;
}

function readCatalogFile(path: string, source: string): PatternCatalog | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CATALOG_BYTES) return null;
    const text = readFileSync(path, "utf8");
    const ids = catalogIds(text);
    if (ids.length === 0) return null;
    return { text, ids, source };
  } catch { return null; }
}

export function loadPatternCatalog(root: string, opts?: { appRoot?: string; envPath?: string }): PatternCatalog | null {
  const envPath = opts?.envPath ?? process.env.SAM_PATTERN_CATALOG;
  if (envPath) {
    const fromEnv = readCatalogFile(envPath, "env");
    if (fromEnv) return fromEnv;
  }
  const fromWorkspace = readCatalogFile(join(resolve(root), "pattern-catalog.md"), "workspace");
  if (fromWorkspace) return fromWorkspace;
  const appRoot = opts?.appRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return readCatalogFile(join(appRoot, "pattern-catalog.md"), "app");
}

export function patternCatalogPresent(root: string): boolean {
  return loadPatternCatalog(root) !== null || existsSync(join(resolve(root), "pattern-catalog.md"));
}

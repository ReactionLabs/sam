import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type InspectedEntry = { name: string; type: "file" | "directory" | "blocked" };
const SENSITIVE = /^(\.env(?:\..*)?|\.git|\.sam|node_modules|\.npmrc|\.pypirc|\.netrc|\.aws|\.ssh|\.kube|kubeconfig|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|service[-_]?account(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const MAX_ENTRIES = 100;

/**
 * Explicit, non-recursive local directory inventory.
 * This is a CLI-only diagnostic, NOT a sandbox or an agent tool grant.
 * Never use this helper to authorize arbitrary model-requested paths.
 */
export function inspectDirectory(root: string, requested = "."): { directory: string; entries: InspectedEntry[]; truncated: boolean } {
  if (!root || !requested || requested.includes("\0")) throw new Error("Invalid directory");
  if (resolve(requested) === resolve(root) && requested !== ".") throw new Error("Use a relative directory within the authorized root");
  if (requested.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(requested) || requested.startsWith("\\\\")) throw new Error("Absolute paths are not allowed");
  const rootPath = realpathSync(resolve(root));
  const target = resolve(rootPath, requested);
  const rel = relative(rootPath, target);
  if (rel === ".." || rel.startsWith(".." + sep)) throw new Error("Path escapes authorized root");
  let current = rootPath;
  for (const segment of rel.split(sep).filter(Boolean)) {
    if (SENSITIVE.test(segment) || segment.startsWith(".")) throw new Error("Protected directory");
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink directory denied");
  }
  if (!lstatSync(target).isDirectory()) throw new Error("Not a directory");
  const names = readdirSync(target).sort((a,b)=>a.localeCompare(b));
  const entries: InspectedEntry[] = names.slice(0, MAX_ENTRIES).map(name => {
    if (SENSITIVE.test(name) || name.startsWith(".")) return {name, type:"blocked"};
    const stat = lstatSync(resolve(target,name));
    return {name, type:stat.isSymbolicLink() ? "blocked" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "blocked"};
  });
  return {directory: rel || ".", entries, truncated:names.length>MAX_ENTRIES};
}

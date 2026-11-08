import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const MAX_OUTPUT = 16_000;

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).slice(0, MAX_OUTPUT);
}

/** Read-only Git inspection. Never accepts model-supplied Git arguments. */
export function inspectGitWorkspace(workspace: string, action: "status" | "diff"): string {
  if (action !== "status" && action !== "diff") throw new Error("Unsupported Git inspection action");
  const root = realpathSync(resolve(workspace));
  let repository: string;
  try {
    repository = realpathSync(resolve(git(root, ["rev-parse", "--show-toplevel"]).trim()));
  } catch {
    throw new Error("Workspace is not a Git repository");
  }
  if (process.platform === "win32"
    ? repository.toLowerCase() !== root.toLowerCase()
    : repository !== root)
    throw new Error("Git repository root must match the authorized workspace");
  const result = action === "status"
    ? git(root, ["status", "--short", "--branch", "--untracked-files=normal"])
    : git(root, ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--no-textconv", "--", "."]);
  return JSON.stringify({ untrusted: true, action, output: result, truncated: result.length >= MAX_OUTPUT });
}

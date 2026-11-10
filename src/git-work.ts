import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { recordActivity } from "./activity.js";
import { codeRoot } from "./code.js";

/**
 * Git discipline (Phase D item 5, Dip's coder program C4, ordered
 * after C3's coding loop and C5's self-review).
 *
 * Until this item the coding loop's verified, reviewed work landed
 * as uncommitted working-tree changes on whatever branch the code
 * root happened to be sitting on - indistinguishable from the
 * owner's own half-done edits, with no branch naming the task and
 * no door to land it except the owner's own hands. C4 is the
 * discipline, and it is deliberately narrow:
 *
 * - A coding task that runs in a git code root works on ONE branch
 *   named for it alone: sam/<task>. The loop creates (or resumes)
 *   that branch before the first iteration and never works on any
 *   other branch. Never main, never any owner branch.
 * - A working tree that is dirty BEFORE the task starts refuses:
 *   SAM never sweeps the owner's uncommitted work into its branch
 *   or its commits. The task closes blocked naming the refusal.
 * - After each iteration the loop commits exactly that iteration's
 *   C1 writes - those paths, staged by name, nothing else - as a
 *   local commit on the task branch. Commits land as the loop
 *   works, so a dead runner still leaves a readable record. A task
 *   whose writes are not all committed cannot close done.
 * - A code root that is not a git repository records mode "none":
 *   there is no branch discipline to apply and the loop behaves
 *   exactly as it did before C4. Branching is never faked.
 * - Push is the one landing act and it stays OWNER-APPROVED: this
 *   module only exposes pushBranch, which the ONE gate's git-push
 *   executor calls after an owner decision. The argv is fixed
 *   (push -u origin <branch>), the branch must be a sam/* task
 *   branch, and there is no force flag and no PR creation anywhere
 *   in this module - a pushed branch is the landing; the PR itself
 *   stays the owner's click.
 *
 * Every git invocation here is a fixed argv built in this module -
 * the git-inspection posture. No caller (model, task, or proposal)
 * can supply a command, a flag, or a ref beyond a branch name that
 * must pass taskBranchName's shape or the sam/* check.
 */

export interface GitCommitRecord { sha: string; iteration: number; paths: string[]; at: string }
export interface CodingGitState {
  /** "branch": the task works on its sam/<task> branch.
   *  "none": the code root is not a git repository.
   *  "refused": a git root the loop would not touch (dirty tree,
   *  no commits yet) - the task closes blocked with `error`. */
  mode: "branch" | "none" | "refused";
  branch: string | null;
  baseSha: string | null;
  commits: GitCommitRecord[];
  /** C1 write paths not yet covered by a local commit. */
  pending: string[];
  error: string | null;
}

const BRANCH_SHAPE = /^sam\/[a-z0-9][a-z0-9-]{0,60}$/;

/** The one branch name a coding task may work on: sam/<slug>-<id8>,
 *  the slug folded from the task's title so the branch reads as the
 *  work it holds, the id prefix so two tasks with the same title
 *  never share a branch. */
export function taskBranchName(task: { id: string; title: string }): string {
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "task";
  return "sam/" + slug + "-" + task.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

export function isTaskBranch(name: string): boolean {
  return typeof name === "string" && BRANCH_SHAPE.test(name);
}

function gitSync(base: string, args: string[], timeoutMs = 15_000): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", base, ...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 256_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const text = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { ok: false, out: (text || err.message || "git failed").trim() };
  }
}

/** The git repository rooted exactly at the code root, or null when
 *  the code root is not one. A repo rooted at a PARENT directory
 *  does not count: branch discipline applies to the designated
 *  tree, never to some larger tree that happens to contain it. */
/** Canonical form for path EQUALITY checks: both sides realpath'd (so
 *  symlinks, junctions, 8.3 names, and casing all collapse), the \\?\
 *  long-path prefix stripped, and case folded on Windows where the
 *  filesystem is case-insensitive. Linux keeps its exact compare. */
export function canonicalPath(p: string): string {
  let out = p;
  try { out = realpathSync(p); } catch { out = resolve(p); }
  out = out.replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export function gitRepoRoot(root: string): string | null {
  const base = codeRoot(root);
  if (!base) return null;
  const probe = gitSync(base, ["rev-parse", "--show-toplevel"]);
  if (!probe.ok) return null;
  try {
    return canonicalPath(probe.out.trim()) === canonicalPath(base) ? base : null;
  } catch { return null; }
}

export function currentBranch(base: string): string | null {
  const r = gitSync(base, ["branch", "--show-current"]);
  return r.ok ? (r.out.trim() || null) : null;
}

export function branchExists(base: string, branch: string): boolean {
  return gitSync(base, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]).ok;
}

export function listTaskBranches(root: string): { repo: string | null; current: string | null; branches: string[] } {
  const repo = gitRepoRoot(root);
  if (!repo) return { repo: null, current: null, branches: [] };
  const listed = gitSync(repo, ["branch", "--list", "sam/*", "--format=%(refname:short)"]);
  return { repo, current: currentBranch(repo), branches: listed.ok ? listed.out.split("\n").map(s => s.trim()).filter(Boolean) : [] };
}

/** Prepare the task's branch before its first iteration. Creating
 *  or resuming sam/<task> is the only mutation; a dirty tree or an
 *  unborn HEAD refuses (mode "refused", the reason in `error`), and
 *  a non-git root is mode "none", never an error. */
export function prepareTaskBranch(root: string, task: { id: string; title: string }): CodingGitState {
  const repo = gitRepoRoot(root);
  if (!repo) return { mode: "none", branch: null, baseSha: null, commits: [], pending: [], error: null };
  const branch = taskBranchName(task);
  const head = gitSync(repo, ["rev-parse", "HEAD"]);
  if (!head.ok) return { mode: "refused", branch, baseSha: null, commits: [], pending: [], error: "The code root is a git repository with no commits yet - make the first commit outside SAM, then re-queue the task." };
  const status = gitSync(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!status.ok) return { mode: "refused", branch, baseSha: null, commits: [], pending: [], error: "Could not read the code root's git status: " + status.out.slice(0, 200) };
  if (status.out.trim()) return { mode: "refused", branch, baseSha: null, commits: [], pending: [], error: "The code root's working tree has uncommitted changes that are not this task's - SAM never sweeps the owner's work into its branch. Commit or stash them outside SAM, then re-queue the task." };
  if (currentBranch(repo) !== branch) {
    const step = branchExists(repo, branch)
      ? gitSync(repo, ["checkout", branch])
      : gitSync(repo, ["checkout", "-b", branch]);
    if (!step.ok) return { mode: "refused", branch, baseSha: null, commits: [], pending: [], error: "Could not check out the task branch " + branch + ": " + step.out.slice(0, 200) };
  }
  recordActivity(root, "sam", "coding-branch", "Coding branch " + branch + " ready at " + head.out.trim().slice(0, 12));
  return { mode: "branch", branch, baseSha: head.out.trim(), commits: [], pending: [], error: null };
}

/** Commit exactly `paths` (this iteration's C1 writes) on the task
 *  branch. Paths are staged by name - there is no add-all anywhere
 *  in this module - so a file the owner or another process dropped
 *  into the tree mid-task is never swept into SAM's commit. A path
 *  whose content already matches HEAD stages nothing and counts as
 *  covered. Returns the commit record, or null when there was
 *  nothing to commit; throws with git's own words on failure. */
export function commitTaskPaths(root: string, state: CodingGitState, paths: string[], iteration: number, title: string): GitCommitRecord | null {
  if (state.mode !== "branch" || !state.branch) return null;
  const repo = gitRepoRoot(root);
  if (!repo) throw new Error("The code root stopped being a git repository mid-task");
  if (currentBranch(repo) !== state.branch) throw new Error("The code root is no longer on the task branch " + state.branch + " - refusing to commit onto another branch");
  const wanted = [...new Set(paths)].filter(p => typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes(".."));
  if (!wanted.length) return null;
  const add = gitSync(repo, ["add", "--", ...wanted]);
  if (!add.ok) throw new Error("git add failed: " + add.out.slice(0, 240));
  const staged = gitSync(repo, ["diff", "--cached", "--name-only", "--", ...wanted]);
  const stagedPaths = staged.ok ? staged.out.split("\n").map(s => s.trim()).filter(Boolean) : [];
  const covered = wanted.filter(p => !stagedPaths.includes(p));
  let record: GitCommitRecord | null = null;
  if (stagedPaths.length) {
    const message = ("sam: " + title.trim().slice(0, 72) + " (iteration " + iteration + ")").trim();
    const commit = gitSync(repo, ["-c", "user.name=SAM", "-c", "user.email=sam@localhost", "commit", "-m", message, "--", ...stagedPaths]);
    if (!commit.ok) throw new Error("git commit failed: " + commit.out.slice(0, 240));
    const sha = gitSync(repo, ["rev-parse", "HEAD"]);
    record = { sha: sha.out.trim(), iteration, paths: stagedPaths, at: new Date().toISOString() };
    state.commits.push(record);
    recordActivity(root, "sam", "coding-commit", "Committed " + stagedPaths.join(", ") + " on " + state.branch + " (" + record.sha.slice(0, 12) + ", iteration " + iteration + ")");
  }
  const done = new Set([...covered, ...stagedPaths]);
  state.pending = state.pending.filter(p => !done.has(p));
  return record;
}

/** Proposal-time validation for the git-push gate kind: the detail
 *  must name a sam/* branch that exists in the designated code
 *  root's repository, with an origin remote to push to - a card
 *  that cannot execute is never shown (the P1 dead-card rule). */
export function validateGitPushDetail(root: string, detail: string): { branch: string } {
  let spec: unknown;
  try { spec = JSON.parse(detail); } catch { throw new Error("Invalid git-push detail: expected JSON {branch}"); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Invalid git-push detail: expected JSON {branch}");
  const branch = (spec as { branch?: unknown }).branch;
  if (typeof branch !== "string" || !isTaskBranch(branch)) throw new Error("Invalid git-push branch: only a sam/<task> branch can be proposed for push (got " + JSON.stringify(branch ?? null) + "). Main and every other branch are never pushed by SAM.");
  const repo = gitRepoRoot(root);
  if (!repo) throw new Error("No git repository at the designated code root - there is nothing to push. The operator designates a code root with: sam code set-root <path>.");
  if (!branchExists(repo, branch)) {
    const known = listTaskBranches(root).branches;
    throw new Error("Branch " + branch + " does not exist in the code root's repository." + (known.length ? " Task branches: " + known.join(", ") + "." : " There are no task branches yet."));
  }
  if (!gitSync(repo, ["remote", "get-url", "origin"]).ok) throw new Error("The code root's repository has no origin remote - a push has nowhere to go. Add the remote outside SAM, then re-propose.");
  return { branch };
}

/** Every path the working tree disagrees with HEAD about (staged,
 *  unstaged, and untracked), with deletions flagged. Built for the
 *  managed engine runtime (C6): the engine writes files directly,
 *  so this porcelain read is how SAM learns exactly what it did.
 *  Rename entries report the new path (the old path is gone from
 *  the tree either way). Throws when the code root is not the git
 *  repository root - callers gate on gitRepoRoot first. */
export function worktreeChanges(root: string): Array<{ path: string; deleted: boolean }> {
  const repo = gitRepoRoot(root);
  if (!repo) throw new Error("The code root is not a git repository rooted at itself");
  const probe = gitSync(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!probe.ok) throw new Error("Could not read the code root's git status: " + probe.out.slice(0, 200));
  const fields = probe.out.split("\0");
  const out: Array<{ path: string; deleted: boolean }> = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    // A rename/copy entry is followed by its source path field.
    if (xy.includes("R") || xy.includes("C")) i++;
    out.push({ path, deleted: xy.includes("D") });
  }
  return out;
}

/** A file's content at HEAD, or null when HEAD has no such file
 *  (a creation) or it cannot be read as text. The "before" half of
 *  an engine change record. */
export function headFileContent(root: string, rel: string): string | null {
  const repo = gitRepoRoot(root);
  if (!repo) return null;
  const probe = gitSync(repo, ["show", "HEAD:" + rel]);
  return probe.ok ? probe.out : null;
}

export type GitPushRunner = (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string }>;

/** The gated landing act itself: push ONE sam/* branch to origin.
 *  Fixed argv, no force, no extra refs, no PR. Called only by the
 *  git-push executor after an owner decision; validation runs
 *  again here so a record written around proposal-time checks
 *  still cannot push anything but a task branch. */
export async function pushBranch(root: string, branch: string, runner?: GitPushRunner): Promise<{ branch: string; sha: string }> {
  if (!isTaskBranch(branch)) throw new Error("Refused: only a sam/<task> branch can be pushed (got " + JSON.stringify(branch) + ")");
  const repo = gitRepoRoot(root);
  if (!repo) throw new Error("No git repository at the designated code root - nothing to push");
  if (!branchExists(repo, branch)) throw new Error("Branch " + branch + " does not exist in the code root's repository");
  if (!gitSync(repo, ["remote", "get-url", "origin"]).ok) throw new Error("The code root's repository has no origin remote");
  const sha = gitSync(repo, ["rev-parse", "refs/heads/" + branch]).out.trim();
  const run: GitPushRunner = runner ?? ((file, args, cwd, timeoutMs) => new Promise(done => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 256_000, windowsHide: true }, (error, stdout, stderr) => {
      done({ exitCode: error ? (typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0, output: (stdout ?? "") + (stderr ?? "") });
    });
  }));
  const result = await run("git", ["-C", repo, "push", "-u", "origin", branch], repo, 120_000);
  if (result.exitCode !== 0) throw new Error("git push failed (exit " + String(result.exitCode) + "): " + result.output.trim().slice(0, 240));
  recordActivity(root, "owner", "git-push", "Pushed " + branch + " to origin (" + sha.slice(0, 12) + ")");
  return { branch, sha };
}

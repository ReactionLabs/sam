import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { recordActivity } from "./activity.js";
import { channels } from "./channels.js";
import { connectors } from "./connectors.js";
import { lineDiff, unifiedDiff } from "./line-diff.js";
import { readFileProviders } from "./providers.js";
import { recordChange, recordVerification } from "./verification.js";

/**
 * Coder hands (Phase D item 2, Dip's coder program 2026-11-09: C1 write
 * hands + C2 verify hands, ordered after the Phase D item 1 approvals
 * engine that is their safety floor).
 *
 * C1: write/edit tools scoped to ONE designated code root. The root is
 * set only by the operator via the CLI (`code set-root`) and stored in
 * .sam/code.json; the model can use the hands but can never move the
 * root. The root is never the SAM home, never inside it, and never an
 * ancestor of it, so a code write cannot reach SAM's own state (.sam),
 * its keys, or its install. Inside the root the read tools' refusals
 * hold: env files, secrets, keys, binaries, dot-paths, the .git and
 * node_modules trees, and symlinks are all refused. Every write is
 * ledgered (.sam/code-writes.jsonl, with a capped unified diff readable
 * back through `code writes`), writes one activity line, and enters
 * the verify-on-stop ledger as an unverified change - a code write is
 * not "done" until a fresh build/test verdict lands (C2 below). Each
 * write also records a goldfish change artifact (.sam/changes/), so
 * the C5 fresh-context reviewer can review coding-loop diffs exactly
 * as it reviews edit-applies (Phase D item 4).
 *
 * C2: verify hands are a fixed in-code allowlist of commands in the
 * code root - the project's own package.json build/test/lint scripts,
 * read-only git (status/diff/log), and agent-reach (channels/doctor)
 * as the first allowlisted external command, per the plan. There is
 * no way to name an arbitrary command, flag, or shell: the model picks
 * a NAME from the allowlist and the argv is built here. Runs carry a
 * timeout and an output cap, every run is ledgered, and build/test
 * verdicts record into the same verification ledger the writes feed.
 * agent-reach may not be installed on a machine (it is not on the box
 * today): its entries report not-installed cleanly instead of failing
 * obscurely.
 *
 * Hands v2 (SAM HANDS v2: fetch, Python, sandbox): git-clone is one
 * more allowlisted name. It clones a URL into a directory inside the
 * designated code root, records the URL and destination on the
 * activity ledger, and never shells out or pushes. A Python run names
 * a script file that already exists in the code root or in a sandbox;
 * the argv is the interpreter plus that file, the run is ledgered
 * with the script's content hash, and the process environment is
 * scrubbed of connector tokens and model keys unless an explicit
 * pass-through list names variables to keep. Sandboxes live under a
 * SAM-managed directory, one venv each. Creating, listing, and
 * destroying them, and pip installs ledgered by package and version,
 * are dependency and filesystem isolation. SAM deletes only a sandbox
 * it created.
 */

const MAX_FILE_BYTES = 32_000;
const MAX_OUTPUT_CHARS = 8_000;
const PROTECTED = /^(?:\.env(?:\..*)?|\.git|\.sam|node_modules|keys|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|db|sqlite))$/i;
const SECRETISH = /secret/i;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ---- the designated code root ---------------------------------------

interface CodeConfig { version: 1; root: string | null }

function configPath(root: string): string {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "code.json");
}

function readConfig(root: string): CodeConfig {
  const path = configPath(root);
  if (!existsSync(path)) return { version: 1, root: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CodeConfig;
    if (parsed && typeof parsed === "object" && (typeof parsed.root === "string" || parsed.root === null)) return { version: 1, root: parsed.root };
  } catch { /* corrupt state reads as unset, never fatal */ }
  return { version: 1, root: null };
}

function writeConfig(root: string, cfg: CodeConfig): void {
  const path = configPath(root);
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** The designated code root (absolute, realpath'd), or null when the
 *  operator has not designated one. A root that vanished from disk
 *  reads as unset: hands refuse with the set-root instruction. */
export function codeRoot(root: string): string | null {
  const configured = readConfig(root).root;
  if (!configured) return null;
  try {
    const real = realpathSync(resolve(configured));
    return lstatSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

export function setCodeRoot(root: string, candidate: string): string {
  if (!candidate || typeof candidate !== "string") throw new Error("A code root path is required");
  let real: string;
  try { real = realpathSync(resolve(candidate)); } catch { throw new Error("Code root does not exist: " + candidate); }
  if (!lstatSync(real).isDirectory()) throw new Error("Code root is not a directory: " + candidate);
  const sam = realpathSync(resolve(root));
  if (real === sam) throw new Error("The code root cannot be the SAM home itself - SAM never writes in its own home; designate a project tree elsewhere");
  if (real.startsWith(sam + sep)) throw new Error("The code root cannot be inside the SAM home");
  if (sam.startsWith(real + sep)) throw new Error("The code root cannot contain the SAM home");
  writeConfig(root, { version: 1, root: real });
  recordActivity(root, "operator", "code-root", "Designated code root: " + real);
  return real;
}

export function clearCodeRoot(root: string): void {
  writeConfig(root, { version: 1, root: null });
  recordActivity(root, "operator", "code-root", "Cleared the designated code root");
}

function requireCodeRoot(root: string): string {
  const found = codeRoot(root);
  if (!found) throw new Error("No code root is designated on this install. The operator sets one with: sam code set-root <path> (a project tree outside the SAM home). Until then SAM has no write or verify hands.");
  return found;
}

// ---- confined paths inside the code root -----------------------------

function checkedParts(rel: string): string[] {
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\"))
    throw new Error("Invalid relative code path");
  const parts = rel.split(/[\\/]+/).filter(p => p !== "" && p !== ".");
  if (!parts.length || parts.some(p => p === "..")) throw new Error("Invalid relative code path");
  for (const part of parts) {
    if (part.startsWith(".") || PROTECTED.test(part) || SECRETISH.test(part))
      throw new Error("Protected code path: " + part);
  }
  return parts;
}

/** Walk the existing prefix of a target, refusing symlinks at every
 *  step (the workspace-tools posture: a symlinked directory must never
 *  become a door out of the root). Missing tail parts are allowed for
 *  writes that create them; every part name is already checked. */
function targetPath(base: string, rel: string, forWrite: boolean): string {
  const parts = checkedParts(rel);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch {
      if (!forWrite) throw new Error("Path not found in the code root: " + rel);
      continue; // a tail that does not exist yet; names already checked
    }
    if (stat.isSymbolicLink()) throw new Error("Symlink access denied: " + rel);
  }
  const target = resolve(base, ...parts);
  const back = relative(base, target);
  if (back === ".." || back.startsWith(".." + sep) || isAbsolute(back)) throw new Error("Path outside the code root");
  return target;
}

// ---- C1: read + write hands ------------------------------------------

export function listCodeFiles(root: string, rel = "."): { path: string; entries: Array<{ name: string; type: "dir" | "file" }> } {
  const base = requireCodeRoot(root);
  const target = rel === "." ? base : targetPath(base, rel, false);
  if (!lstatSync(target).isDirectory()) throw new Error("Not a directory: " + rel);
  const entries = readdirSync(target, { withFileTypes: true })
    .filter(e => !e.name.startsWith(".") && !PROTECTED.test(e.name) && !SECRETISH.test(e.name))
    .slice(0, 100)
    .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" as const : "file" as const }));
  return { path: rel, entries };
}

export function readCodeFile(root: string, rel: string): { path: string; content: string; truncated: boolean } {
  const base = requireCodeRoot(root);
  const target = targetPath(base, rel, false);
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("File is not readable or exceeds " + MAX_FILE_BYTES + " bytes: " + rel);
  const bytes = readFileSync(target);
  if (bytes.includes(0)) throw new Error("Binary file denied: " + rel);
  const content = bytes.toString("utf8");
  return { path: rel, content: content.slice(0, 24_000), truncated: content.length > 24_000 };
}

export interface CodeWriteRecord {
  at: string; actor: string; path: string; created: boolean;
  beforeHash: string | null; afterHash: string;
  addedLines: number; removedLines: number; diff: string;
}

function writesPath(root: string): string { return join(resolve(root), ".sam", "code-writes.jsonl"); }

export function codeWrites(root: string, limit = 20): CodeWriteRecord[] {
  const file = writesPath(root);
  if (!existsSync(file)) return [];
  const records: CodeWriteRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const parsed = JSON.parse(line) as CodeWriteRecord; if (parsed && typeof parsed.path === "string") records.push(parsed); } catch { /* torn line ignored */ }
  }
  return records.slice(-limit);
}

export function codeSummary(root: string): { root: string | null; writes: number; commands: string[] } {
  return { root: codeRoot(root), writes: codeWrites(root, 10_000).length, commands: codeCommandNames() };
}

function diffOf(rel: string, before: string, after: string, created = false): { diff: string; added: number; removed: number } {
  if (created) {
    // A creation has no before-text: every line is an addition (the
    // generic differ would count the empty before-state as a removal).
    const lines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
    const body = lines.map(l => "+" + l).join("\n");
    const diff = ("--- a/" + rel + "\n+++ b/" + rel + "\n@@ -0,0 +1," + lines.length + " @@\n" + body).slice(0, 4_000);
    return { diff, added: lines.length, removed: 0 };
  }
  try {
    const result = unifiedDiff(rel, lineDiff(before, after), 3, 4_000);
    return { diff: result.truncated ? result.diff + "\n(diff truncated)" : result.diff, added: result.addedLines, removed: result.removedLines };
  } catch {
    // Oversize line counts: counts still recorded, the text diff is not.
    const a = before ? before.split("\n").length : 0, b = after ? after.split("\n").length : 0;
    return { diff: "(file too large for a line diff; " + a + " lines before, " + b + " lines after)", added: Math.max(0, b - a), removed: Math.max(0, a - b) };
  }
}

function writeCodeFileInternal(root: string, actor: string, rel: string, content: string): CodeWriteRecord & { verification: string } {
  const base = requireCodeRoot(root);
  if (typeof content !== "string" || content.includes("\0")) throw new Error("Code content must be text (no binary)");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Code content exceeds " + MAX_FILE_BYTES + " bytes");
  const target = targetPath(base, rel, true);
  let before = "";
  let created = true;
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Existing file is not a safe text file: " + rel);
    const bytes = readFileSync(target);
    if (bytes.includes(0)) throw new Error("Binary file denied: " + rel);
    before = bytes.toString("utf8");
    created = false;
    if (before === content) throw new Error("No change: the file already holds exactly this content");
  }
  const { diff, added, removed } = diffOf(rel, before, content, created);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), ".sam-code-" + randomUUID() + ".tmp");
  writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try { renameSync(temp, target); } catch (e) { try { unlinkSync(temp); } catch { /* already gone */ } throw e; }
  const record: CodeWriteRecord = {
    at: new Date().toISOString(), actor, path: rel, created,
    beforeHash: created ? null : sha(before), afterHash: sha(content),
    addedLines: added, removedLines: removed, diff,
  };
  persistCodeWrite(root, record, before, content);
  return { ...record, verification: "pending" };
}

/** Ledger one code write that has ALREADY landed on disk: the writes
 *  ledger line, the goldfish change artifact, the activity line, and
 *  the verify-on-stop change entry - the exact four records
 *  writeCodeFileInternal writes for its own writes. */
function persistCodeWrite(root: string, record: CodeWriteRecord, before: string, after: string): void {
  const rel = record.path;
  mkdirSync(join(resolve(root), ".sam"), { recursive: true, mode: 0o700 });
  appendFileSync(writesPath(root), JSON.stringify(record) + "\n");
  // Change artifact for the goldfish verifier (Phase D item 4, C5):
  // the before/after pair keyed by the after-hash, the file-edits
  // shape, so a fresh-context reviewer can reconstruct exactly what
  // this write did in the code root without any conversation. The
  // first writer of a given after-hash owns the artifact (identical
  // content hashes identically); the verifier refuses a path
  // mismatch rather than reviewing the wrong file.
  const changesDir = join(resolve(root), ".sam", "changes");
  mkdirSync(changesDir, { recursive: true, mode: 0o700 });
  const artifact = join(changesDir, record.afterHash + ".json");
  if (!existsSync(artifact)) {
    const fd = openSync(artifact, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ path: rel, before, after, at: record.at }), "utf8"); }
    finally { closeSync(fd); }
  }
  recordActivity(root, record.actor, "code-write", (record.created ? "Wrote " : "Edited ") + rel + " in the code root (+" + record.addedLines + "/-" + record.removedLines + " lines)");
  // Verify-on-stop: the write enters the ledger as an unverified change;
  // only a fresh C2 build/test verdict can settle it.
  recordChange(root, { path: rel, replacementHash: record.afterHash, source: "code-write" });
}

/** Record a change an EXTERNAL writer already made in the code root
 *  (Phase D item 6, C6: the managed coding engine writes files
 *  directly; SAM records them afterwards). The change enters the
 *  exact same ledgers as a C1 write - writes ledger, goldfish
 *  artifact, activity, verify-on-stop - so C2 verification and the
 *  C5 review bind to engine work identically. The C1 fences are
 *  enforced HERE, at record time: a path the write hands would
 *  refuse (protected, secret-named, dot-path), binary content, or
 *  an over-cap file throws, and the caller must treat that change
 *  as unreviewable rather than letting it slip past the ledgers. */
export function recordExternalChange(root: string, actor: string, rel: string, before: string, after: string, created: boolean): CodeWriteRecord & { verification: string } {
  requireCodeRoot(root);
  checkedParts(rel);
  if (typeof after !== "string" || after.includes("\0")) throw new Error("Binary change cannot be recorded: " + rel);
  if (Buffer.byteLength(after, "utf8") > MAX_FILE_BYTES) throw new Error("Change exceeds " + MAX_FILE_BYTES + " bytes and cannot be recorded: " + rel);
  if (typeof before !== "string" || before.includes("\0") || Buffer.byteLength(before, "utf8") > MAX_FILE_BYTES) throw new Error("Prior content of " + rel + " cannot be recorded (binary or oversize)");
  if (before === after) throw new Error("No change: " + rel + " already holds exactly this content");
  const { diff, added, removed } = diffOf(rel, before, after, created);
  const record: CodeWriteRecord = {
    at: new Date().toISOString(), actor, path: rel, created,
    beforeHash: created ? null : sha(before), afterHash: sha(after),
    addedLines: added, removedLines: removed, diff,
  };
  persistCodeWrite(root, record, before, after);
  return { ...record, verification: "pending" };
}

export function writeCodeFile(root: string, actor: string, rel: string, content: string): CodeWriteRecord & { verification: string } {
  return writeCodeFileInternal(root, actor, rel, content);
}

export function editCodeFile(root: string, actor: string, rel: string, oldText: string, newText: string): CodeWriteRecord & { verification: string } {
  if (!oldText) throw new Error("edit needs the exact existing text to replace");
  const current = readCodeFile(root, rel);
  if (current.truncated) throw new Error("File is too large to edit safely: " + rel);
  const first = current.content.indexOf(oldText);
  if (first === -1) throw new Error("The text to replace was not found in " + rel);
  if (current.content.indexOf(oldText, first + 1) !== -1) throw new Error("The text to replace appears more than once in " + rel + " - include more surrounding context so the edit is unambiguous");
  const next = current.content.slice(0, first) + newText + current.content.slice(first + oldText.length);
  return writeCodeFileInternal(root, actor, rel, next);
}

// ---- C2: the verify-hands allowlist -----------------------------------

export interface CodeCommandSpec { file: string; args: string[]; cwd: string; description: string }

function packageScripts(base: string): Record<string, string> {
  const file = join(base, "package.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.scripts ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}

const NPM_SCRIPT_COMMANDS = ["build", "test", "lint"] as const;
const GIT_COMMANDS: Record<string, { args: string[]; description: string }> = {
  "git-status": { args: ["status", "--short", "--branch", "--untracked-files=normal"], description: "Read-only git status of the code root" },
  "git-diff": { args: ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--no-textconv", "--", "."], description: "Read-only git diff of the code root" },
  "git-log": { args: ["log", "--oneline", "-20"], description: "The last 20 commits of the code root (read-only)" },
};
const AGENT_REACH_COMMANDS: Record<string, { args: string[]; description: string }> = {
  "agent-reach-channels": { args: ["channels"], description: "agent-reach: list its channels and actions (read-only; the first allowlisted external command)" },
  "agent-reach-doctor": { args: ["doctor", "--text"], description: "agent-reach: its own status report (read-only)" },
};

export function codeCommandNames(): string[] {
  return [...NPM_SCRIPT_COMMANDS, ...Object.keys(GIT_COMMANDS), "git-clone", ...Object.keys(AGENT_REACH_COMMANDS)];
}

/** Build the fixed argv for one allowlisted command NAME. The caller
 *  (model or CLI) supplies only the name; a missing package script or a
 *  non-git root refuses here, naming what IS available. */
export function codeCommandSpec(root: string, name: string, params?: { url?: string; destination?: string }): CodeCommandSpec {
  if (name === "git-clone") {
    if (!params?.url || !params.destination) throw new Error("git-clone needs a url and a destination inside the code root. The argv is built from those two fields (no shell, no push).");
    return gitCloneSpec(root, params.url, params.destination);
  }
  const base = requireCodeRoot(root);
  if ((NPM_SCRIPT_COMMANDS as readonly string[]).includes(name)) {
    const scripts = packageScripts(base);
    if (!scripts[name]) {
      const present = Object.keys(scripts);
      throw new Error("The code root's package.json has no \"" + name + "\" script" + (present.length ? " (it has: " + present.join(", ") + ")" : " (it has no scripts)"));
    }
    return { file: "npm", args: ["run", name], cwd: base, description: "The code root's own npm " + name + " script: " + scripts[name] };
  }
  const git = GIT_COMMANDS[name];
  if (git) return { file: "git", args: git.args, cwd: base, description: git.description };
  const reach = AGENT_REACH_COMMANDS[name];
  if (reach) return { file: "agent-reach", args: reach.args, cwd: base, description: reach.description };
  throw new Error("Unknown code command '" + name + "'. Allowlisted commands: " + codeCommandNames().join(", ") + ". There is no way to run anything else - no arbitrary commands, flags, or shell.");
}

export type CodeRunner = (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

function execFileCapped(file: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; output: string; timedOut?: boolean }> {
  return new Promise(done => {
    let settled = false;
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 256_000, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      if (settled) return; settled = true;
      const combined = (stdout ?? "") + (stderr ?? "");
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") { done({ exitCode: null, output: combined }); return; }
      const timedOut = !!error && (error as unknown as { killed?: boolean }).killed === true && (error as unknown as { signal?: string }).signal === "SIGTERM";
      done({ exitCode: error ? (typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0, output: combined, timedOut });
    });
    child.on("error", err => {
      if (settled) return; settled = true;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") done({ exitCode: null, output: "" });
      else done({ exitCode: null, output: String(err) });
    });
  });
}

export const defaultCodeRunner: CodeRunner = (file, args, cwd, timeoutMs) => execFileCapped(file, args, cwd, timeoutMs);

export interface CodeRunResult {
  command: string; description: string; ok: boolean; exitCode: number | null;
  timedOut: boolean; output: string; truncated: boolean; durationMs: number; error?: string;
  url?: string; destination?: string;
}

export async function runCodeCommand(root: string, actor: string, name: string, opts: { timeoutMs?: number; runner?: CodeRunner; url?: string; destination?: string } = {}): Promise<CodeRunResult> {
  if (name === "git-clone") return cloneIntoCodeRoot(root, actor, opts.url ?? "", opts.destination ?? "", opts);
  const spec = codeCommandSpec(root, name);
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? 60_000));
  const runner = opts.runner ?? defaultCodeRunner;
  const start = Date.now();
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try {
    raw = await runner(spec.file, spec.args, spec.cwd, timeoutMs);
  } catch (e) {
    raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) };
  }
  const durationMs = Date.now() - start;
  // ENOENT surfaces as exitCode null with empty output from the default
  // runner: name the real cause instead of an obscure failure. For
  // agent-reach this is the expected state on a machine without it.
  const notInstalled = raw.exitCode === null && !raw.output && !raw.timedOut;
  const output = (raw.output ?? "").slice(0, MAX_OUTPUT_CHARS);
  const result: CodeRunResult = {
    command: name, description: spec.description,
    ok: raw.exitCode === 0 && !raw.timedOut,
    exitCode: raw.exitCode, timedOut: !!raw.timedOut,
    output, truncated: (raw.output ?? "").length > MAX_OUTPUT_CHARS, durationMs,
    ...(notInstalled ? { error: spec.file + " is not installed on this machine - the allowlisted command '" + name + "' cannot run until it is installed (installing it is the operator's act)" } : {}),
  };
  recordActivity(root, actor, "code-run", "Ran " + name + " in the code root: " + (result.error ?? (result.ok ? "ok" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : ""))));
  // Verify-on-stop: a build/test verdict settles the verification
  // ledger the C1 writes feed - verified only through a fresh run.
  if (name === "build" || name === "test") {
    try { recordVerification(root, { kind: name, passed: result.ok, runId: randomUUID() }); } catch { /* the ledger never breaks a run */ }
  }
  return result;
}

// ---- Hands v2: git-clone, Python, sandboxes -------------------------
// git-clone is an allowlisted name with two structured fields. Python
// runs one script file. Sandboxes are per-project venvs under SAM's
// own sandboxes directory: dependency and filesystem isolation.

function oneLine(value: string): string {
  return String(value ?? "").replace(/[\r\n\0]/g, " ").slice(0, 180);
}

const LEDGER_LIMIT = 300;

function singleLine(value: string): string {
  return String(value ?? "").replace(/[\r\n\0]/g, " ").replace(/ +/g, " ").trim();
}

/** An activity summary that stays inside the ledger cap and still
 *  contains `mustKeep` (the destination, or the content hash). The
 *  detail is shortened before that required piece is. */
function boundedLedger(detail: string, mustKeep: string): string {
  const keep = singleLine(mustKeep);
  const body = singleLine(detail);
  if (keep.length >= LEDGER_LIMIT) return keep.slice(0, LEDGER_LIMIT);
  if (body.includes(keep) && body.length <= LEDGER_LIMIT) return body;
  const room = LEDGER_LIMIT - keep.length - 1;
  const head = body.replace(keep, "").replace(/\s+/g, " ").trim();
  const shown = room <= 1 ? "" : (head.length <= room ? head : head.slice(0, room - 1) + "…");
  const line = (shown + " " + keep).trim();
  return line.length <= LEDGER_LIMIT ? line : keep.slice(0, LEDGER_LIMIT);
}

const CLONE_PROTOCOLS = new Set(["http:", "https:", "file:", "ssh:", "git:"]);

/** Canonicalize a clone URL. A password, query, fragment, or non-URL
 *  is refused so the value that reaches git and the ledger is the
 *  URL itself, not an option and not an embedded credential. */
export function parseCloneUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000 || /[\s\0]/.test(raw) || raw.startsWith("-"))
    throw new Error("Clone URL must be an http, https, file, ssh, or git URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Clone URL must be an http, https, file, ssh, or git URL"); }
  if (!CLONE_PROTOCOLS.has(url.protocol)) throw new Error("Clone URL must use http, https, file, ssh, or git");
  if (url.password || url.hash || url.search) throw new Error("Clone URL must not embed a password, query, or fragment");
  return url.toString();
}

function resolveCloneDestination(base: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 240) throw new Error("Clone destination must be a relative path inside the code root");
  const parts = checkedParts(rel);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = lstatSync(current); } catch { continue; }
    if (st.isSymbolicLink()) throw new Error("Symlink access denied: " + rel);
    if (i === parts.length - 1) throw new Error("Clone destination already exists: " + rel);
    if (!st.isDirectory()) throw new Error("Clone destination parent is not a directory: " + rel);
  }
  const dest = resolve(base, ...parts);
  const back = relative(base, dest);
  if (back === "" || back === ".." || back.startsWith(".." + sep) || isAbsolute(back)) throw new Error("Path outside the code root");
  let ancestor = dirname(dest);
  const baseReal = realpathSync(base);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Path outside the code root");
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== baseReal && !realAncestor.startsWith(baseReal + sep)) throw new Error("Path outside the code root");
  return dest;
}

function buildCloneSpec(root: string, canonicalUrl: string, destination: string): CodeCommandSpec {
  const base = requireCodeRoot(root);
  const dest = resolveCloneDestination(base, destination);
  return {
    file: "git",
    args: ["clone", "--no-recurse-submodules", "--", canonicalUrl, dest],
    cwd: base,
    description: "Clone " + canonicalUrl + " into " + destination + " inside the code root (no shell, no push)",
  };
}

/** The argv git-clone will run. Previewing it does not create the
 *  destination or invoke git. */
export function gitCloneSpec(root: string, url: string, destination: string): CodeCommandSpec {
  return buildCloneSpec(root, parseCloneUrl(url), destination);
}

function gitCloneEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Clone one URL into a directory inside the designated code root.
 *  The URL and the relative destination are written to the activity
 *  ledger. The argv is built here. There is no shell and no push. */
export async function cloneIntoCodeRoot(root: string, actor: string, url: string, destination: string, opts: { timeoutMs?: number; runner?: CodeRunner } = {}): Promise<CodeRunResult> {
  let canonical: string | undefined;
  let spec: CodeCommandSpec;
  try {
    canonical = parseCloneUrl(url);
    spec = buildCloneSpec(root, canonical, destination);
    mkdirSync(dirname(spec.args[spec.args.length - 1]), { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const shown = canonical ? canonical + " into " + oneLine(destination) : "an invalid URL into " + oneLine(destination);
    recordActivity(root, actor, "git-clone", boundedLedger("Refused clone of " + shown + ": " + oneLine(msg), oneLine(destination)));
    throw e;
  }
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? 60_000));
  const runner = opts.runner ?? ((file, args, cwd, timeout) => execFileCapped(file, args, cwd, timeout, gitCloneEnv()));
  const start = Date.now();
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try { raw = await runner(spec.file, spec.args, spec.cwd, timeoutMs); }
  catch (e) { raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
  const output = (raw.output ?? "").slice(0, MAX_OUTPUT_CHARS);
  const result: CodeRunResult = {
    command: "git-clone", description: spec.description, url: canonical, destination,
    ok: raw.exitCode === 0 && !raw.timedOut,
    exitCode: raw.exitCode, timedOut: !!raw.timedOut,
    output, truncated: (raw.output ?? "").length > MAX_OUTPUT_CHARS, durationMs: Date.now() - start,
    ...(raw.exitCode === null && !raw.output && !raw.timedOut ? { error: "git is not installed on this machine - git-clone cannot run until it is installed (installing it is the operator's act)" } : {}),
  };
  const status = result.error ?? (result.ok ? "ok" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : ""));
  recordActivity(root, actor, "git-clone", boundedLedger("Cloned " + canonical + " into " + destination + ": " + status, destination));
  return result;
}

// ---- Python runner ---------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Connector tokens and model keys, plus PYTHONSTARTUP (it would run a
// second file ahead of the script the argv names).
const SCRUBBED_ENV = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY)(?:_|$)|_API_KEY$|^SAM_MCP_TOKEN_|^SAM_CHANNEL_|^PYTHONSTARTUP$/i;

export function python3Available(): { ok: true; bin: "python3" } | { ok: false; reason: string } {
  try {
    execFileSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)"], { stdio: "ignore" });
    return { ok: true, bin: "python3" };
  } catch {
    return { ok: false, reason: "python3 is not available on this machine" };
  }
}

export function venvModuleAvailable(): { ok: true } | { ok: false; reason: string } {
  const py = python3Available();
  if (!py.ok) return { ok: false, reason: py.reason };
  try {
    // `import venv` succeeds on Debian even when ensurepip is missing,
    // and `python3 -m venv` then fails. The venv is usable for pip
    // installs only when ensurepip is present.
    execFileSync("python3", ["-c", "import venv, ensurepip"], { stdio: "ignore" });
    return { ok: true };
  } catch {
    return { ok: false, reason: "python3 is installed but venv/ensurepip is not available, so a sandbox venv cannot be created" };
  }
}

/** Env names the install has registered as a connector token, a
 *  channel token, or a provider model key. The values are never read. */
export function registeredSecretEnvNames(root: string): string[] {
  const names = new Set<string>();
  try { for (const c of connectors(root)) if (c && typeof c.tokenEnv === "string" && c.tokenEnv) names.add(c.tokenEnv); } catch { /* pattern scrub still applies */ }
  try { for (const c of channels(root)) if (c && typeof c.tokenEnv === "string" && c.tokenEnv) names.add(c.tokenEnv); } catch { /* pattern scrub still applies */ }
  try { for (const p of readFileProviders(root)) if (p && typeof p.keyEnv === "string" && p.keyEnv) names.add(p.keyEnv); } catch { /* pattern scrub still applies */ }
  return [...names];
}

/** Copy an environment with connector tokens and model keys removed.
 *  passThrough is a list of variable NAMES to keep anyway. */
export function buildPythonEnv(root: string, env: NodeJS.ProcessEnv, passThrough: readonly string[]): { env: NodeJS.ProcessEnv; passed: string[] } {
  if (passThrough.length > 16) throw new Error("Pass-through list is limited to 16 environment variable names");
  const allow = new Set<string>();
  for (const name of passThrough) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) throw new Error("Pass-through entries are environment variable names, not values");
    allow.add(name);
  }
  let extra = new Set<string>();
  try { extra = new Set(registeredSecretEnvNames(root)); } catch { extra = new Set(); }
  const out: NodeJS.ProcessEnv = {};
  const passed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !ENV_NAME.test(key)) continue;
    const secret = SCRUBBED_ENV.test(key) || extra.has(key);
    if (secret && !allow.has(key)) continue;
    if (secret && allow.has(key)) passed.push(key);
    out[key] = value;
  }
  passed.sort();
  return { env: out, passed };
}

export type PythonRunner = (file: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

export interface PythonRunResult {
  path: string; sandbox: string | null; sha256: string; interpreter: string; passThrough: string[];
  ok: boolean; exitCode: number | null; timedOut: boolean; output: string; truncated: boolean; durationMs: number;
  error?: string;
}

function locatePythonScript(root: string, rel: string, sandbox: string | null): { abs: string; cwd: string; interpreter: string } {
  if (sandbox) {
    const owned = requireOwnSandbox(root, sandbox);
    if (!existsSync(owned.work)) mkdirSync(owned.work, { recursive: true, mode: 0o700 });
    const abs = targetPath(owned.work, rel, false);
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("Python script is not a file: " + rel);
    if (st.size > MAX_FILE_BYTES) throw new Error("Python script exceeds " + MAX_FILE_BYTES + " bytes: " + rel);
    return { abs, cwd: owned.work, interpreter: venvPythonPath(owned.dir) };
  }
  const base = requireCodeRoot(root);
  const abs = targetPath(base, rel, false);
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("Python script is not a file: " + rel);
  if (st.size > MAX_FILE_BYTES) throw new Error("Python script exceeds " + MAX_FILE_BYTES + " bytes: " + rel);
  return { abs, cwd: base, interpreter: "python3" };
}

/** Run one Python script that already exists in the code root or in a
 *  sandbox. argv is the interpreter plus that file. The activity line
 *  carries the script's content hash and the pass-through names. */
export async function runPython(root: string, actor: string, rel: string, opts: { sandbox?: string | null; passThrough?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv; runner?: PythonRunner } = {}): Promise<PythonRunResult> {
  const sandbox = opts.sandbox ? opts.sandbox : null;
  const requested = [...new Set(opts.passThrough ?? [])].sort();
  let digest: string | null = null;
  try {
    const built = buildPythonEnv(root, opts.env ?? process.env, requested);
    const located = locatePythonScript(root, rel, sandbox);
    const bytes = readFileSync(located.abs);
    if (bytes.includes(0)) throw new Error("Binary file denied: " + rel);
    digest = sha(bytes);
    if (sandbox) {
      if (!existsSync(located.interpreter)) throw new Error("Sandbox " + sandbox + " has no venv interpreter");
    } else if (!opts.runner) {
      const py = python3Available();
      if (!py.ok) throw new Error(py.reason + ", so a Python script cannot run");
    }
    const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? 30_000));
    const runner = opts.runner ?? ((file, args, cwd, timeout, env) => execFileCapped(file, args, cwd, timeout, env));
    const start = Date.now();
    let raw: { exitCode: number | null; output: string; timedOut?: boolean };
    try { raw = await runner(located.interpreter, [located.abs], located.cwd, timeoutMs, built.env); }
    catch (e) { raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
    const output = (raw.output ?? "").slice(0, MAX_OUTPUT_CHARS);
    const result: PythonRunResult = {
      path: rel, sandbox, sha256: digest, interpreter: located.interpreter, passThrough: requested,
      ok: raw.exitCode === 0 && !raw.timedOut,
      exitCode: raw.exitCode, timedOut: !!raw.timedOut,
      output, truncated: (raw.output ?? "").length > MAX_OUTPUT_CHARS, durationMs: Date.now() - start,
      ...(raw.exitCode === null && !raw.output && !raw.timedOut ? { error: located.interpreter + " is not installed on this machine" } : {}),
    };
    const status = result.error ?? (result.ok ? "ok" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : ""));
    const pass = requested.length ? requested.join(",") : "none";
    recordActivity(root, actor, "python-run", boundedLedger("sha256:" + digest + " pass-through:" + pass + " path:" + rel + (sandbox ? " sandbox:" + sandbox : "") + " -> " + status, "sha256:" + digest));
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordActivity(root, actor, "python-run", "Refused python " + oneLine(rel) + (digest ? " sha256:" + digest : "") + ": " + msg);
    throw e;
  }
}

// ---- Sandbox manager -------------------------------------------------

const SANDBOX_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const PACKAGE_VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;

interface SandboxMarker { version: 1; name: string; createdBy: "sam"; at: string }

/** Interpreter path inside a sandbox venv. */
export function venvPythonPath(sandboxDir: string): string {
  return process.platform === "win32"
    ? join(sandboxDir, "venv", "Scripts", "python.exe")
    : join(sandboxDir, "venv", "bin", "python");
}

function ensureSandboxesRoot(root: string): string {
  const sam = join(resolve(root), ".sam");
  mkdirSync(sam, { recursive: true, mode: 0o700 });
  if (lstatSync(sam).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const base = join(sam, "sandboxes");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (lstatSync(base).isSymbolicLink()) throw new Error("Sandboxes root must be a real directory");
  const realSam = realpathSync(sam);
  const realBase = realpathSync(base);
  if (relative(realSam, realBase) !== "sandboxes") throw new Error("Sandboxes root must stay inside SAM state");
  return realBase;
}

function sandboxPath(root: string, name: string): { base: string; dir: string } {
  if (typeof name !== "string" || !SANDBOX_NAME.test(name)) throw new Error("Invalid sandbox name");
  const base = ensureSandboxesRoot(root);
  const dir = join(base, name);
  if (relative(base, dir) !== name) throw new Error("Invalid sandbox name");
  return { base, dir };
}

function readSandboxMarker(dir: string): SandboxMarker | null {
  const file = join(dir, "sandbox.json");
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 8_000) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SandboxMarker;
    if (!parsed || parsed.version !== 1 || parsed.createdBy !== "sam" || typeof parsed.name !== "string" || typeof parsed.at !== "string") return null;
    return parsed;
  } catch { return null; }
}

export interface OwnedSandbox { name: string; dir: string; work: string; marker: SandboxMarker }

export function requireOwnSandbox(root: string, name: string): OwnedSandbox {
  const { base, dir } = sandboxPath(root, name);
  let st;
  try { st = lstatSync(dir); } catch { throw new Error("No SAM sandbox named " + name); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Refusing to use " + name + ": it is not a sandbox SAM created");
  const real = realpathSync(dir);
  if (relative(base, real) !== name) throw new Error("Refusing to use " + name + ": it is not inside the sandboxes root");
  const marker = readSandboxMarker(real);
  if (!marker || marker.name !== name) throw new Error("Refusing to use " + name + ": it is not a sandbox SAM created");
  return { name, dir: real, work: join(real, "work"), marker };
}

export interface SandboxInfo { name: string; path: string; work: string; python: string; at: string }

export async function createSandbox(root: string, actor: string, name: string, opts: { python?: string | null; runner?: CodeRunner; timeoutMs?: number } = {}): Promise<SandboxInfo> {
  const { dir } = sandboxPath(root, name);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try { existing = lstatSync(dir); } catch { existing = undefined; }
  if (existing?.isSymbolicLink()) throw new Error("Refusing to create sandbox " + name + ": that path is a symlink");
  if (existing) throw new Error("Sandbox already exists: " + name);
  if (opts.python === null) throw new Error("python3 is not available on this machine, so a sandbox venv cannot be created");
  let python = opts.python ?? "";
  if (!python) {
    if (!opts.runner) {
      const venv = venvModuleAvailable();
      if (!venv.ok) throw new Error(venv.reason + ", so a sandbox venv cannot be created");
    }
    python = "python3";
  }
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  const venvDir = join(dir, "venv");
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? 60_000));
  const runner = opts.runner ?? defaultCodeRunner;
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try { raw = await runner(python, ["-m", "venv", venvDir], dir, timeoutMs); }
  catch (e) { raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
  const py = venvPythonPath(dir);
  if (raw.exitCode !== 0 || raw.timedOut || !existsSync(py)) {
    try {
      const st = lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink()) rmSync(dir, { recursive: true, force: true });
    } catch { /* the partial directory is removed when it still can be */ }
    throw new Error("Sandbox venv was not created" + (raw.output ? ": " + raw.output.slice(0, 400) : ""));
  }
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const marker: SandboxMarker = { version: 1, name, createdBy: "sam", at };
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(marker), { mode: 0o600 });
  recordActivity(root, actor, "sandbox-create", "Created sandbox " + name);
  return { name, path: dir, work, python: py, at };
}

export function listSandboxes(root: string): Array<{ name: string; at: string }> {
  const base = ensureSandboxesRoot(root);
  const out: Array<{ name: string; at: string }> = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !SANDBOX_NAME.test(entry.name)) continue;
    try {
      const owned = requireOwnSandbox(root, entry.name);
      out.push({ name: owned.name, at: owned.marker.at });
    } catch { /* a directory without SAM's marker is not listed as a sandbox */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function destroySandbox(root: string, actor: string, name: string): { name: string; removed: true } {
  const owned = requireOwnSandbox(root, name);
  rmSync(owned.dir, { recursive: true, force: false });
  recordActivity(root, actor, "sandbox-destroy", "Deleted sandbox " + name);
  return { name, removed: true };
}

export function writeSandboxFile(root: string, actor: string, name: string, rel: string, content: string): { sandbox: string; path: string; sha256: string } {
  const owned = requireOwnSandbox(root, name);
  if (typeof content !== "string" || content.includes("\0")) throw new Error("Sandbox content must be text (no binary)");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Sandbox content exceeds " + MAX_FILE_BYTES + " bytes");
  if (!existsSync(owned.work)) mkdirSync(owned.work, { recursive: true, mode: 0o700 });
  const target = targetPath(owned.work, rel, true);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), ".sam-sandbox-" + randomUUID() + ".tmp");
  writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try { renameSync(temp, target); } catch (e) { try { unlinkSync(temp); } catch { /* already gone */ } throw e; }
  const digest = sha(content);
  recordActivity(root, actor, "sandbox-write", "Wrote " + rel + " in sandbox " + name + " sha256:" + digest);
  return { sandbox: name, path: rel, sha256: digest };
}

export function sandboxPipArgv(root: string, name: string, pkg: string, version: string): { file: string; args: string[]; cwd: string; spec: string } {
  if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg) || pkg.includes("..")) throw new Error("Package name must be a plain name, not a URL, path, or pip flag");
  if (typeof version !== "string" || !PACKAGE_VERSION.test(version)) throw new Error("Package version must be an exact version, not a range or a flag");
  const owned = requireOwnSandbox(root, name);
  const file = venvPythonPath(owned.dir);
  if (!existsSync(file)) throw new Error("Sandbox " + name + " has no venv interpreter");
  const spec = pkg + "==" + version;
  return { file, args: ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", spec], cwd: owned.work, spec };
}

export interface SandboxPipResult {
  sandbox: string; package: string; version: string; ok: boolean; exitCode: number | null;
  timedOut: boolean; output: string; truncated: boolean; durationMs: number;
}

/** pip install of one exact package==version inside a sandbox venv.
 *  The activity line records the package and the version. The child
 *  environment is scrubbed the same way a Python run is, with no
 *  pass-through. */
export async function installSandboxPackage(root: string, actor: string, name: string, pkg: string, version: string, opts: { timeoutMs?: number; runner?: CodeRunner } = {}): Promise<SandboxPipResult> {
  const argv = sandboxPipArgv(root, name, pkg, version);
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? 60_000));
  const runner = opts.runner ?? ((file, args, cwd, timeout) => execFileCapped(file, args, cwd, timeout, buildPythonEnv(root, process.env, []).env));
  const start = Date.now();
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try { raw = await runner(argv.file, argv.args, argv.cwd, timeoutMs); }
  catch (e) { raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) }; }
  const output = (raw.output ?? "").slice(0, MAX_OUTPUT_CHARS);
  const result: SandboxPipResult = {
    sandbox: name, package: pkg, version,
    ok: raw.exitCode === 0 && !raw.timedOut,
    exitCode: raw.exitCode, timedOut: !!raw.timedOut,
    output, truncated: (raw.output ?? "").length > MAX_OUTPUT_CHARS, durationMs: Date.now() - start,
  };
  recordActivity(root, actor, "sandbox-pip", "Installed " + argv.spec + " into sandbox " + name + ": " + (result.ok ? "ok" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : "")));
  return result;
}

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { recordActivity } from "./activity.js";
import { lineDiff, unifiedDiff } from "./line-diff.js";
import { recordChange, recordVerification } from "./verification.js";

/**
 * Coder hands (Phase D item 2, Dip's coder program 2026-11-09: C1 write
 * hands + C2 verify hands, ordered after the Phase D item 1 approvals
 * engine that is their safety floor).
 *
 * C1: write/edit tools scoped to ONE designated code root. The root is
 * set only by the operator via the CLI (`code set-root`) and stored in
 * .sam/code.db; the model can use the hands but can never move the
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
 */

const MAX_FILE_BYTES = 32_000;
const MAX_OUTPUT_CHARS = 8_000;
const PROTECTED = /^(?:\.env(?:\..*)?|\.git|\.sam|node_modules|keys|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|db|sqlite))$/i;
const SECRETISH = /secret/i;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ---- the designated code root ---------------------------------------

interface CodeConfig { version: 1; root: string | null }

function configPath(root: string): string { return join(resolve(root), ".sam", "code.json"); }
function configDbPath(root: string): string { return join(resolve(root), ".sam", "code.db"); }

// State convergence (UNIFICATION item 4, thirty-second store):
// the designated code root is SQLite (.sam/code.db, the
// dashboard-config / setup singleton pattern), ONE row holding
// the config's full JSON so the singleton keeps its exact shape.
// The old code.json was rewritten whole (temp + rename) by every
// setCodeRoot / clearCodeRoot, while codeRoot readers run in
// every process that touches the coder hands (every sam_code
// call, the coding loop, the C6 engine validation, the status
// builds) - two writers holding the same snapshot could lose
// the second one's change, and the designation IS the C1 fence:
// the one record that decides which tree SAM may write in at
// all. Its read path also created the .sam directory on every
// call, so even a pure read was a write. Here a save is a
// single-row UPSERT and connections carry a busy_timeout. First
// open imports a legacy code.json (validated through the old
// read shape: a plain object whose root is a string or null)
// and renames it code.json.migrated - imported, never deleted;
// a malformed file or a payload failing that shape imports
// nothing and is left in place (the migrated shape reads it as
// unset, exactly the old forgiving contract). A pure read on an
// install with neither file creates nothing, not even the .sam
// directory. The old configPath's .sam symlink refusal moves
// into the store open, so it binds writes and migrated reads
// exactly as before. The P9 backup snapshots every .sam/*.db
// generically, so the migrated store is carried with no backup
// change.
function parseCodeConfig(data: unknown): CodeConfig | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<CodeConfig>;
  if (typeof value.root !== "string" && value.root !== null) return null;
  return { version: 1, root: value.root };
}

function openCodeStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = new Database(configDbPath(root));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS code_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyConfig(db, root);
  return db;
}

function migrateLegacyConfig(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM code_config WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = configPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseCodeConfig(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO code_config (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}

function codeStoreExists(root: string): boolean {
  return existsSync(configDbPath(root)) || existsSync(configPath(root));
}

/** The store's read door: the recorded designation through the
 *  store's own shape, or null when none has ever been recorded -
 *  and a read on an install with no store at all creates
 *  nothing. */
export function readCodeStore(root: string): CodeConfig | null {
  if (!codeStoreExists(root)) return null;
  const db = openCodeStore(root);
  try {
    const row = db.prepare("SELECT data FROM code_config WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseCodeConfig(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function readConfig(root: string): CodeConfig {
  return readCodeStore(root) ?? { version: 1, root: null };
}

function writeConfig(root: string, cfg: CodeConfig): void {
  const db = openCodeStore(root);
  try {
    db.prepare("INSERT INTO code_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(cfg));
  } finally { db.close(); }
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
  return [...NPM_SCRIPT_COMMANDS, ...Object.keys(GIT_COMMANDS), ...Object.keys(AGENT_REACH_COMMANDS)];
}

/** Build the fixed argv for one allowlisted command NAME. The caller
 *  (model or CLI) supplies only the name; a missing package script or a
 *  non-git root refuses here, naming what IS available. */
export function codeCommandSpec(root: string, name: string): CodeCommandSpec {
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

export const defaultCodeRunner: CodeRunner = (file, args, cwd, timeoutMs) => new Promise(done => {
  let settled = false;
  const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 256_000, windowsHide: true }, (error, stdout, stderr) => {
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

export interface CodeRunResult {
  command: string; description: string; ok: boolean; exitCode: number | null;
  timedOut: boolean; output: string; truncated: boolean; durationMs: number; error?: string;
}

export async function runCodeCommand(root: string, actor: string, name: string, opts: { timeoutMs?: number; runner?: CodeRunner } = {}): Promise<CodeRunResult> {
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

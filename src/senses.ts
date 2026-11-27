import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { commandCandidates, namedExecutable, probeDelimiter, probePlatform, type BinaryProbe } from "./bin-path.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

/**
 * Senses (Plan Phase E item 2; the full-agent program's P2 order:
 * read-only Gmail and Calendar connectors for the CORE profile).
 *
 * The core SAM had no day to see: its only senses were the MCP
 * connectors (a person's business data), and nothing anywhere in
 * SAM could read the owner's own mail or calendar - the input
 * every brief, reminder, and "what is on today" answer needs.
 * This module is that door, built on the precedents the coder
 * program set (C2's agent-reach entry, C6's engine binary):
 *
 * - READER: one fixed external binary, gog (the Google Workspace
 *   CLI - the plan doc's "gog route"), resolved as the operator's
 *   SAM_GOG_BIN when it names an executable file, else "gog"
 *   found on PATH. Installing it and authorizing it with the
 *   owner's Google account is the operator's act; where no
 *   reader is installed, every surface reports not-installed
 *   cleanly, naming the fix, instead of failing obscurely.
 * - FIXED ARGV: the two senses are fixed command shapes built
 *   here in code (gmail search, calendar events, both --json).
 *   The caller (model or CLI) supplies only bounded parameters:
 *   a sanitized search query, a result count clamped to 1..25,
 *   and an agenda window of 1..7 days computed in code. There is
 *   no way to name a command, a flag, or a shell.
 * - CORE ONLY: the owner's mailbox and calendar are the core
 *   profile's senses. A scoped profile's world is its own
 *   connector pin, so every non-core actor is refused, and
 *   visitors are refused at the tool seam. The CLI is the
 *   operator's own door and acts as the core.
 * - READ-ONLY: no sense can send, modify, or delete anything -
 *   the argv shapes have no write verb in them at all.
 * - UNTRUSTED + LEDGERED: reader output is data, capped at
 *   8,000 chars and framed untrusted by the tool layer; every
 *   read writes one activity line naming the sense and the
 *   outcome - never the query and never the content, because
 *   both are the owner's private data.
 */

export const CORE_SENSE_ACTOR = "sam";

const MAX_OUTPUT_CHARS = 8_000;
const SENSE_TIMEOUT_MS = 30_000;
const DEFAULT_MAIL_QUERY = "in:inbox newer_than:7d";

export const SENSES_NOT_INSTALLED =
  "The senses reader (gog, the Google Workspace CLI) is not installed on this machine - no SAM_GOG_BIN is set and no \"gog\" binary is on PATH. Installing it and authorizing it with the owner's Google account is the operator's act; until then SAM cannot read Gmail or Calendar.";

/** The senses reader this install would run: the operator's
 *  SAM_GOG_BIN when it names an executable file, else "gog" found
 *  on PATH. Null means not installed (the engineBinary pattern).
 *  PATH uses path.delimiter, and win32 resolves gog.exe / gog.cmd.
 *  Tests inject platform and delimiter; they do not depend on the host. */
export function sensesBinary(env: NodeJS.ProcessEnv = process.env, probe?: BinaryProbe): string | null {
  const platform = probePlatform(probe);
  const delimiter = probeDelimiter(probe);
  const rawNamed = env.SAM_GOG_BIN;
  const named = rawNamed ? namedExecutable(rawNamed, platform) : rawNamed;
  if (named) {
    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }
  }
  for (const candidate of commandCandidates(env.PATH, delimiter, "gog", platform)) {
    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** The sense registry: the two senses the core profile has.
 *  Every surface that names the senses reads this constant
 *  (sensesStatus below, the refusal sources further down);
 *  SenseName derives from it, so the type and the runtime
 *  registry can never drift. */
export const senseNames = ["mail", "agenda"] as const;
export type SenseName = (typeof senseNames)[number];

export function sensesStatus(env: NodeJS.ProcessEnv = process.env): { installed: boolean; binary: string | null; coreOnly: true; senses: string[] } {
  const binary = sensesBinary(env);
  return { installed: binary !== null, binary, coreOnly: true, senses: [...senseNames] };
}

/** The core-only fence, in one place so every surface refuses
 *  identically: the owner's mail and calendar belong to the core
 *  profile; a scoped profile reads its own connector, never this. */
export function assertCoreSenseActor(actor: string): void {
  if (actor !== CORE_SENSE_ACTOR) {
    throw new Error("Gmail and Calendar are the core profile's senses (profile \"" + CORE_SENSE_ACTOR + "\") - a scoped profile reads only its own connector data, never the owner's mailbox or calendar.");
  }
}

/** A mail search query the reader can be handed safely: bounded
 *  length, no control characters, and never flag-shaped (a query
 *  starting with "-" would be read as a flag by the reader, so it
 *  refuses here and names the rule). */
export function sanitizeMailQuery(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAIL_QUERY;
  if (typeof raw !== "string") throw new Error("Mail query must be text");
  const query = raw.trim();
  if (!query) return DEFAULT_MAIL_QUERY;
  if (query.length > 200) throw new Error("Mail query is too long (200 characters at most)");
  if (/[\0-\x1f\x7f]/.test(query)) throw new Error("Mail query contains control characters");
  if (query.startsWith("-")) throw new Error("Mail query must not start with \"-\" (it would be read as a flag, not a search)");
  return query;
}

export function clampSenseMax(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
  return Math.min(25, Math.max(1, Math.floor(raw)));
}

export function clampSenseDays(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.min(7, Math.max(1, Math.floor(raw)));
}

function foldSenseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/** The ONE source for why a sense cannot be read under this
 *  name: the name is not one of the two senses in the
 *  senseNames registry, so no fixed argv exists for it and
 *  the read would have to invent a command shape - the one
 *  thing the senses door never does. senseArgv is the ONE
 *  seam every sense name rides (runSense builds its argv
 *  there; the CLI senses doors and the sam_senses chat tool
 *  both ride runSense), and it refused an unknown name with
 *  "Unknown sense 'X'. Senses: mail, agenda." - the value
 *  echoed and the registry named, but no fold correction,
 *  so a folded name ("Mail", "AGENDA", "a_genda")
 *  dead-ended even though the intended sense is
 *  unambiguous. senseArgv now throws this source (the
 *  "Unknown sense" prefix is kept). When exactly one sense
 *  matches the bad name folded for case and separators,
 *  the refusal names it. Null means the sense can be
 *  named. Stored sense names stay permissive by design:
 *  ledger lines and scorecards read names back as stored
 *  and never re-validate them. */
export function senseNameBlocker(value: unknown): string | null {
  if (typeof value === "string" && (senseNames as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldSenseName(value) : "";
  const matches = target ? senseNames.filter(s => foldSenseName(s) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown sense \"" + String(value) + "\". Senses: " + senseNames.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

/** The sam_senses tool's action registry: the sense names
 *  plus "status" (whether the reader is installed). Built
 *  from senseNames so the action set and the sense registry
 *  can never drift apart. */
export const sensesActions = ["status", ...senseNames] as const;

/** The ONE source for why the sam_senses tool cannot run
 *  this action: the action is not in the sensesActions
 *  registry, so the tool would have to guess whether the
 *  caller wanted the reader's state or one of the reads.
 *  The tool dispatch in own-tools.ts improvised this
 *  refusal ("Unknown senses action: X (status, mail,
 *  agenda)") with no fold correction, so the model's
 *  "Status" or "Mail" died with no path back; the dispatch
 *  now returns this source as the tool's error before any
 *  read is spent. When exactly one action matches the bad
 *  name folded for case and separators, the refusal names
 *  it. Null means the action can be named. */
export function sensesActionBlocker(value: unknown): string | null {
  if (typeof value === "string" && (sensesActions as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldSenseName(value) : "";
  const matches = target ? sensesActions.filter(a => foldSenseName(a) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown senses action \"" + String(value) + "\". Actions: " + sensesActions.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

/** Build the fixed argv for one sense. The binary and the verb
 *  shape are code; only the bounded parameters vary. */
export function senseArgv(name: SenseName, opts: { query?: unknown; max?: unknown; days?: unknown; now?: Date } = {}): string[] {
  if (name === "mail") {
    return ["gmail", "search", sanitizeMailQuery(opts.query), "--max", String(clampSenseMax(opts.max)), "--json"];
  }
  if (name === "agenda") {
    const days = clampSenseDays(opts.days);
    const from = opts.now ?? new Date();
    const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    return ["calendar", "events", "--from", from.toISOString(), "--to", to.toISOString(), "--json"];
  }
  throw new Error(senseNameBlocker(name) ?? "Unknown sense \"" + String(name) + "\". Senses: " + senseNames.join(", "));
}

export type SenseRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

export const defaultSenseRunner: SenseRunner = (file, args, timeoutMs) => new Promise(done => {
  let settled = false;
  const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 256_000, windowsHide: true }, (error, stdout, stderr) => {
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

export interface SenseResult {
  sense: SenseName; ok: boolean; exitCode: number | null; timedOut: boolean;
  output: string; truncated: boolean; durationMs: number; error?: string;
}

/** Run one sense read for the core profile. Refusals (non-core
 *  actor, bad parameters) throw with the reason, mirroring the
 *  code hands; a missing reader or a failed read returns as data
 *  with the error named, so a chat turn reports it honestly
 *  instead of dying. */
export async function runSense(root: string, actor: string, name: SenseName, opts: { query?: unknown; max?: unknown; days?: unknown; now?: Date; env?: NodeJS.ProcessEnv; runner?: SenseRunner } = {}): Promise<SenseResult> {
  assertCoreSenseActor(actor);
  const args = senseArgv(name, opts);
  const binary = sensesBinary(opts.env ?? process.env);
  if (!binary) {
    recordActivity(root, actor, "sense-read", senseReadLedgerSummary(name, "reader not installed"));
    return { sense: name, ok: false, exitCode: null, timedOut: false, output: "", truncated: false, durationMs: 0, error: SENSES_NOT_INSTALLED };
  }
  const runner = opts.runner ?? defaultSenseRunner;
  const start = Date.now();
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try {
    raw = await runner(binary, args, SENSE_TIMEOUT_MS);
  } catch (e) {
    raw = { exitCode: null, output: errorReason(e) };
  }
  const durationMs = Date.now() - start;
  const notInstalled = raw.exitCode === null && !raw.output && !raw.timedOut;
  const output = (raw.output ?? "").slice(0, MAX_OUTPUT_CHARS);
  const result: SenseResult = {
    sense: name,
    ok: raw.exitCode === 0 && !raw.timedOut,
    exitCode: raw.exitCode, timedOut: !!raw.timedOut,
    output, truncated: (raw.output ?? "").length > MAX_OUTPUT_CHARS, durationMs,
    ...(notInstalled ? { error: SENSES_NOT_INSTALLED } : {}),
    ...(!notInstalled && raw.exitCode !== 0 && !raw.timedOut ? { error: "The senses reader exited with code " + String(raw.exitCode) + " - it may not be authorized yet (authorizing it with the owner's Google account is the operator's act). Its output is carried below." } : {}),
    ...(raw.timedOut ? { error: "The senses reader timed out after " + String(SENSE_TIMEOUT_MS / 1000) + " seconds." } : {}),
  };
  const tail = result.error && !raw.output ? result.error.slice(0, 120) : result.ok ? "ok (" + output.length + " chars)" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : "");
  recordActivity(root, actor, "sense-read", senseReadLedgerSummary(name, tail));
  return result;
}

// --- The ONE writer for the sense-read ledger lines
// (2026-11-19, the measured-proof series): both seams above
// ledger exactly this shape, so the scorecard's parser below
// reads what the seams have always written. The outcome
// argument arrives composed by the seam, exactly as the
// inline writers composed it (the plain not-installed tail,
// an ok char count, an exit tail, or the reader error's own
// opening slice). A sense line never carries the query or
// the content, by this module's standing rule.
export function senseReadLedgerSummary(name: SenseName, outcome: string): string {
  return "Sense " + name + " read: " + outcome;
}

// The sense scorecard (2026-11-19, the measured-proof
// series): the P2 senses' one ledger class folded nowhere,
// so how often SAM tried to see the owner's day, through
// which sense, and how those reads ended was invisible in
// aggregate. The verdict is attention when any parsed read
// is not ok or any line is unparseable, else clear: a sense
// read is attempted only when the owner or the brief asks,
// so every read that ends without the owner's day in hand
// is a day SAM could not see. This text folds the class to
// counts only, on ONE line: the parsed read count split
// mail / agenda, counts per fixed outcome bucket (ok, not
// installed, failed, timed out), the summed chars from ok
// lines, and the total. No stamp, no actor, no query, no
// reader output, no error text, and no verbatim summary
// enters the text. A summary matching no fixed shape counts
// toward the total and the unparseable count only, and is
// never printed. A pure read: it creates nothing, spends no
// model call, and reads no sense - the ledger and the sense
// seams are untouched. (The error-opening shapes sit under
// the ledger's 300-char cap whole - the seam slices them to
// 120 - so their parsers anchor on the fixed prefixes.)
export type SenseOutcomeBucket = "ok" | "not-installed" | "failed" | "timed-out";
export function parseSenseReadSummary(summary: string): { sense: SenseName; bucket: SenseOutcomeBucket; chars: number } | null {
  const m = /^Sense (mail|agenda) read: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const sense = m[1] as SenseName;
  const tail = m[2];
  if (tail === "reader not installed") return { sense, bucket: "not-installed", chars: 0 };
  if (tail.startsWith("The senses reader (gog, the Google Workspace CLI) is not installed")) return { sense, bucket: "not-installed", chars: 0 };
  if (/^The senses reader timed out after \d+ seconds\.$/.test(tail)) return { sense, bucket: "timed-out", chars: 0 };
  if (/^The senses reader exited with code -?\d+/.test(tail)) return { sense, bucket: "failed", chars: 0 };
  const ok = /^ok \((\d+) chars\)$/.exec(tail);
  if (ok) return { sense, bucket: "ok", chars: Number(ok[1]) };
  const exit = /^exit (-?\d+|null)( \(timed out\))?$/.exec(tail);
  if (exit) return { sense, bucket: exit[2] ? "timed-out" : "failed", chars: 0 };
  return null;
}
export function senseScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "sense-read" });
  const senses: Record<SenseName, number> = { mail: 0, agenda: 0 };
  const buckets: Record<SenseOutcomeBucket, number> = { ok: 0, "not-installed": 0, failed: 0, "timed-out": 0 };
  let parsed = 0;
  let chars = 0;
  let unparseable = 0;
  for (const line of lines) {
    const p = parseSenseReadSummary(line.summary);
    if (!p) { unparseable += 1; continue; }
    parsed += 1;
    senses[p.sense] += 1;
    buckets[p.bucket] += 1;
    chars += p.chars;
  }
  const notOk = buckets["not-installed"] + buckets.failed + buckets["timed-out"];
  const parts: string[] = [];
  parts.push("Sense reads: " + (unparseable > 0 || notOk > 0 ? "attention" : "clear"));
  parts.push(String(parsed) + " reads (mail " + String(senses.mail) + ", agenda " + String(senses.agenda) + ")");
  parts.push("outcomes (ok " + String(buckets.ok) + ", not installed " + String(buckets["not-installed"]) + ", failed " + String(buckets.failed) + ", timed out " + String(buckets["timed-out"]) + ")");
  parts.push(String(chars) + " chars read");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

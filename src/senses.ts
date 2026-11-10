import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { recordActivity } from "./activity.js";

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
 *  on PATH. Null means not installed (the engineBinary pattern). */
export function sensesBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.SAM_GOG_BIN;
  if (named) {
    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }
  }
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "gog");
    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export function sensesStatus(env: NodeJS.ProcessEnv = process.env): { installed: boolean; binary: string | null; coreOnly: true; senses: string[] } {
  const binary = sensesBinary(env);
  return { installed: binary !== null, binary, coreOnly: true, senses: ["mail", "agenda"] };
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

export type SenseName = "mail" | "agenda";

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
  throw new Error("Unknown sense '" + String(name) + "'. Senses: mail, agenda.");
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
    recordActivity(root, actor, "sense-read", "Sense " + name + " read: reader not installed");
    return { sense: name, ok: false, exitCode: null, timedOut: false, output: "", truncated: false, durationMs: 0, error: SENSES_NOT_INSTALLED };
  }
  const runner = opts.runner ?? defaultSenseRunner;
  const start = Date.now();
  let raw: { exitCode: number | null; output: string; timedOut?: boolean };
  try {
    raw = await runner(binary, args, SENSE_TIMEOUT_MS);
  } catch (e) {
    raw = { exitCode: null, output: e instanceof Error ? e.message : String(e) };
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
  recordActivity(root, actor, "sense-read", "Sense " + name + " read: " + (result.error && !raw.output ? result.error.slice(0, 120) : result.ok ? "ok (" + output.length + " chars)" : "exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : "")));
  return result;
}

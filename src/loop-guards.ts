import { readActivity } from "./activity.js";
import type { VerificationStatus } from "./verification.js";

/**
 * Loop guards (HARNESS INTELLIGENCE item 3, Dip 2026-11-11: loop
 * smarts - verify-before-claiming, tool-failure repair instead of
 * surrender). The shared shapes both chat loops (own-tools and
 * connector-chat) ride, in the budgets.ts / tool-tiers.ts pattern:
 * stubs and notes are pure functions here so the two loops can
 * never drift apart, and the loop audit probes these exact shapes.
 *
 * - REPEATED-FAILURE GUARD: a tool result that comes back as an
 *   error is data the model can repair from - but only if the
 *   repair actually changes something. A call whose name AND
 *   arguments are identical to one that already failed in this
 *   turn, with no successful execution since that failure, will
 *   fail the same way; executing it again spends the turn's
 *   budget on a known outcome. The loops stub it instead (no
 *   execution, no budget spent) with a note naming the first
 *   error and ordering a changed approach or an honest report.
 *   Any successful execution clears the record, so re-running a
 *   verify command after a fix is never blocked, and the record
 *   is per-turn only: the next turn starts clean.
 * - VERIFY-BEFORE-CLAIMING SELF-CHECK: the coding loop already
 *   refuses to close unverified work; a live chat turn that
 *   changed code through sam_code gets the deterministic version
 *   of the same rule. When such a turn closes, the loop reads
 *   the verification ledger itself - never the model's text -
 *   and records the full bookkeeping (state, pending files, the
 *   works) in the activity ledger whenever the ledger does not
 *   read verified, so a change is never "done" on the model's
 *   say-so alone. The chat reply itself carries at most ONE
 *   plain sentence saying the change is not verified (Dip,
 *   2026-11-15: the bookkeeping block - "Verification note:",
 *   file lists, instructions to itself - was rendering in the
 *   owner's chat; that text belongs to the ledger and the
 *   coding surface, never the bubble).
 */

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = stableValue((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The identity of a tool call for repeat purposes: the tool name
 *  plus its arguments with object keys in a stable order, so the
 *  same call written two ways still reads as the same call. */
export function failureSignature(name: string, args: Record<string, unknown> | undefined): string {
  return name + " " + JSON.stringify(stableValue(args ?? {}));
}

/** The error text of a tool result, or null when the result is not
 *  an error shape. Tool errors ride as data ({error: "..."}) in
 *  both loops; anything else - a payload, a status object, a
 *  string - is a result, not a failure. */
export function toolResultError(out: unknown): string | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const error = (out as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

/** Duplicate-call suppression (Dip ruling 2026-11-14: the screenshot
 *  turn listed the same folder twice and paid for both). An identical
 *  call - same tool, same arguments, per failureSignature - repeated
 *  within one turn, with no state-changing execution since the first
 *  one ran, cannot produce a different result; re-executing it only
 *  re-spends the turn. The loops return the first result wrapped in
 *  this marker instead: the model sees it is a repeat and works from
 *  the result it already had. Only successful results are cached - a
 *  failed call's repeat stays with the repeated-failure guard above,
 *  whose stub carries the repair instruction. */
export function repeatCallResult(out: unknown): unknown {
  const note = "Identical call already ran this turn and nothing has changed since: this is that call's result, not a new execution. Do not call it again; work from this result.";
  if (out && typeof out === "object" && !Array.isArray(out)) return { ...(out as Record<string, unknown>), repeatedCall: true, note };
  return { repeatedCall: true, result: out, note };
}

/** Whether an executed call can change the state a later identical
 *  call would read - the invalidation rule for the duplicate cache.
 *  A verify re-run after an edit must really re-run (the edit bumped
 *  the version, so the cached test result no longer matches), while
 *  a repeat after only reads is the same question with the same
 *  answer. Conservative by construction: anything that writes,
 *  proposes, queues, spawns, reacts, or manages chats counts as
 *  state-changing, and sam_code counts unless the action is one of
 *  its read-only shapes. Connector (MCP) tools are approved reads
 *  and never appear here. */
const READ_ONLY_CODE_ACTIONS = new Set(["status", "list", "read", "writes"]);
const STATE_CHANGING_TOOLS = new Set(["sam_save_note", "sam_patch_note", "sam_propose_action", "sam_author_skill", "sam_open_loop", "sam_react", "sam_manage_chats", "sam_handoff_task", "sam_coding_task", "sam_parallel_task", "sam_spawn_subagent", "sam_ask_linked"]);
export function callChangesState(name: string, args: Record<string, unknown> | undefined): boolean {
  if (name === "sam_artifact") {
    const action = typeof args?.action === "string" ? args.action : "create";
    return action === "create" || action === "update";
  }
  if (name === "sam_code") {
    const action = typeof args?.action === "string" ? args.action : "";
    return !READ_ONLY_CODE_ACTIONS.has(action);
  }
  return STATE_CHANGING_TOOLS.has(name);
}

/** The stub that stands in for a repeated identical call: the
 *  transcript stays valid (every tool_call gets a tool reply),
 *  the call does not execute, and the note turns the first error
 *  into the repair instruction - change something, or report. */
export function repeatedFailureStubContent(name: string, firstError: string): string {
  return JSON.stringify({
    error: "Repeated identical call not executed: " + name + " already failed in this turn",
    note: "It failed with: " + firstError.slice(0, 300) + ". Repeating the same call unchanged will fail the same way. Change the arguments or the approach using that error, or answer now and report the failure plainly instead of retrying it.",
  });
}

/** The coding-loop bookkeeping for a code-changing chat turn
 *  that closes unverified or failed: the full text, file names
 *  and all, for the activity ledger and the coding surface
 *  ONLY - it never rides a chat reply. Null when there is
 *  nothing to record: the ledger reads verified (fresh build
 *  AND test after the last change) or clean (no changes
 *  recorded). An unverified epoch names its pending files; a
 *  failed epoch names the failure - in both cases the change
 *  is not done, whatever the model's reply claims. */
export function codeVerificationLedgerNote(status: VerificationStatus): string | null {
  if (status.state === "unverified") {
    const pending = status.pendingChanges.map(c => c.path).slice(0, 6).join(", ");
    return "Verification note: code changed in this turn and is not verified yet - a fresh build and test have not both passed after the last change" + (pending ? " (unverified: " + pending + ")" : "") + ". The change is not done until both pass; run them through sam_code, or hand the work to the coding loop.";
  }
  if (status.state === "failed") {
    return "Verification note: code changed in this turn and the latest verification after the change FAILED, so the change is not done. Read the failing build or test output, fix the cause, and verify again.";
  }
  return null;
}

/** The ONE plain sentence a chat reply may carry when the turn
 *  leaves code changed and unverified or failed (Dip ruling
 *  2026-11-15): the owner hears that the change is not counted
 *  as done, in a single line - no file lists, no verification
 *  machinery, no instructions to itself. Null when the ledger
 *  reads verified or clean. */
export function codeVerificationOwnerLine(status: VerificationStatus): string | null {
  if (status.state === "unverified") return "One heads-up: I changed code this turn and it has not been verified yet, so I am not counting it as done.";
  if (status.state === "failed") return "One heads-up: I changed code this turn and its latest check failed, so I am not counting it as done.";
  return null;
}

/**
 * - TURN ECONOMY (Dip ruling 2026-11-15, after chat afb0f1ef):
 *   a live owner chat turn is a conversation, not an engineering
 *   session - but left alone, a conversational question ("how
 *   can I integrate this repo with you?") escalated itself into
 *   ~23 sam_reach calls, then 23 sam_code calls writing throwaway
 *   grep scripts into the code root (sam-grep-phrase.py,
 *   sam-find-orch.py, sam-read-own-tools.py...), three turns in
 *   a row, each burning the full deadline. The box's write ledger
 *   is the inventory: EVERY code-root write ever recorded there
 *   (63 of 63) is a created sam-*.py scratch script - no chat
 *   turn has ever made a real edit through these hands, so the
 *   guards below are shaped around the observed signature and
 *   cost legitimate flows nothing:
 *
 *   1. SCRATCH-SCRIPT REFUSAL: a chat turn that tries to CREATE
 *      a script file matching the throwaway signature (a sam-*
 *      script at any depth, or a find/grep/search/probe-named
 *      script at the code-root top level) is refused before
 *      execution and redirected: read/search tools for looking,
 *      a SANDBOX for a script that truly must run, the coding
 *      loop for a real change. Replacing or editing a file that
 *      already exists is project work and is never refused -
 *      the refusal is creation-shaped, not name-shaped alone.
 *   2. SPELUNK TRIPWIRE: code-search calls (sam_code list /
 *      read / code-root python / read-only git) count against
 *      CODE_SEARCH_LIMIT in a turn that has not landed real
 *      code work. Past the limit they are stubbed: the turn
 *      must answer from what it has or hand the investigation
 *      to the background. The grant is behavioral, earned by
 *      the turn's own actions, never guessed from the ask: a
 *      landed write/edit (a real fix underway) or a queued
 *      coding/parallel task lifts the wire for the rest of the
 *      turn, so an explicit coding ask - look, edit, verify -
 *      runs end to end untouched.
 *   3. RESEARCH TRIPWIRE: the turn-1 shape, ~23 sam_reach calls
 *      on one question. sam_reach counts against
 *      REACH_CALL_LIMIT on the same terms; past it, the turn
 *      answers from what the research returned or hands the
 *      deep dive to sam_handoff_task, whose budget is deeper
 *      by design.
 *
 *   Scope: the loops instantiate the guard ONLY on live owner
 *   chat turns (the turns that carry the Lane F ceiling).
 *   Machine routes - the coding loop, background tasks,
 *   heartbeat turns, sub-agent drives - never see it: their
 *   code work is their job, bounded by their own verification
 *   and review machinery. A trip ledgers exactly one line per
 *   turn per wire (kind spelunk-tripwire / research-tripwire);
 *   each scratch refusal ledgers its own line (kind
 *   scratch-write-refused, the path only - SAM invented the
 *   name, it is not the owner's words). Stubbed calls spend no
 *   budget and never execute.
 */
export const CODE_SEARCH_LIMIT = 6;
export const REACH_CALL_LIMIT = 8;

const SCRATCH_SCRIPT_EXTENSIONS = new Set([".py", ".sh", ".js", ".mjs", ".cjs"]);
const SEARCHY_SCRIPT_BASENAME = /^(?:find|grep|search|probe|scratch|tmp|temp|lookup|inspect)[-_]/i;

/** The throwaway-script signature, name shape only: a script
 *  extension AND (a sam-* basename at any depth - SAM names its
 *  ad-hoc search scripts after itself - OR a search-shaped
 *  basename at the code-root top level, where project source
 *  does not live). Whether a matching write is a CREATION is
 *  the caller's check (codeFileExists): replacing an existing
 *  file is project work, never scratch. */
export function scratchScriptPath(rel: string): boolean {
  if (typeof rel !== "string" || !rel) return false;
  const parts = rel.split(/[\\/]+/).filter(p => p !== "" && p !== ".");
  if (!parts.length) return false;
  const base = parts[parts.length - 1].toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || !SCRATCH_SCRIPT_EXTENSIONS.has(base.slice(dot))) return false;
  if (/^sam[-_]/.test(base)) return true;
  return parts.length === 1 && SEARCHY_SCRIPT_BASENAME.test(base);
}

const CODE_SEARCH_ACTIONS = new Set(["list", "read"]);
const CODE_SEARCH_COMMANDS = new Set(["git-status", "git-diff", "git-log"]);

/** Whether a call digs through the code root: sam_code list /
 *  read, a code-root python run (a sandbox run is the sanctioned
 *  scratch space and never counts), or a read-only git look.
 *  Verify runs (build / test / lint), status, the writes ledger,
 *  clones, and sandbox actions are not digging. */
export function isCodeSearchCall(name: string, args: Record<string, unknown> | undefined): boolean {
  if (name !== "sam_code") return false;
  const action = typeof args?.action === "string" ? args.action : "";
  if (CODE_SEARCH_ACTIONS.has(action)) return true;
  if (action === "python") return !(typeof args?.sandbox === "string" && args.sandbox.length > 0);
  if (action === "run") return CODE_SEARCH_COMMANDS.has(typeof args?.command === "string" ? args.command : "");
  return false;
}

export function scratchScriptStubContent(rel: string): string {
  return JSON.stringify({
    error: "Scratch script write refused in a chat turn: " + rel + " is a throwaway script, and the code root is not a scratchpad",
    note: "Do not write ad-hoc scripts into the code root to search or inspect it. For looking, use sam_code list and read. For a script you truly need to run, use a sandbox instead: sam_code sandbox-create, sandbox-write, then python with that sandbox. For a real code change, edit the existing project files, or queue the change with sam_coding_task so the coding loop lands it with verification. If you already have what you need, answer the owner now.",
  });
}

export function spelunkStubContent(): string {
  return JSON.stringify({
    error: "Code digging stopped for this turn: " + CODE_SEARCH_LIMIT + " code lookups already ran and no code change has landed",
    note: "This conversation is not an engineering session. Answer the owner's question now, in plain words, from what you have already gathered. If the question genuinely needs a deep codebase investigation, hand it to the background with sam_handoff_task (or queue the change with sam_coding_task) and tell the owner it is handed off - do not keep digging in this turn.",
  });
}

export function researchStubContent(): string {
  return JSON.stringify({
    error: "Research calls stopped for this turn: " + REACH_CALL_LIMIT + " sam_reach calls already ran",
    note: "Answer the owner's question now from what the research already returned. If it needs a deeper dive, hand it to sam_handoff_task, where the research budget is deeper, and tell the owner it is handed off - do not keep searching inside this live turn.",
  });
}

export function spelunkSteerNote(): string {
  return "Turn economy: this conversation turn has spent its code-lookup allowance (" + CODE_SEARCH_LIMIT + ") without landing a code change. Stop investigating the codebase here. Answer the owner's question from what you have already gathered, in plain words - or, if the question truly needs the deep investigation, hand it to the background with sam_handoff_task and tell the owner plainly that it is handed off.";
}

export function researchSteerNote(): string {
  return "Turn economy: this conversation turn has spent its research allowance (" + REACH_CALL_LIMIT + " sam_reach calls). Answer the owner's question from what the research already returned, or hand the deep dive to sam_handoff_task and tell the owner plainly that it is handed off.";
}

export function scratchRefusalLedgerSummary(rel: string): string {
  return ("Refused a scratch script write in a chat turn: " + rel.replace(/\s+/g, " ").trim() + " in the code root - throwaway search scripts belong in a sandbox, and the code root stays clean").slice(0, 300);
}

export function spelunkLedgerSummary(): string {
  return "Code digging cut in a chat turn after " + CODE_SEARCH_LIMIT + " code lookups with no code change landed: the turn must answer from what it has or hand the investigation to the background";
}

export function researchLedgerSummary(): string {
  return "Research calls cut in a chat turn after " + REACH_CALL_LIMIT + " sam_reach calls: the turn must answer from what it gathered or hand the deep research to the background";
}

export interface TurnEconomyDecision {
  stub: string;
  ledger?: { kind: string; summary: string };
  steer?: string;
}

/** The per-turn economy state both chat loops ride. Constructed
 *  only for live owner chat turns; decide() is consulted in the
 *  classification pass (after duplicate / repeat suppression, so
 *  a free repeat never counts) and noteSuccess() in the executed
 *  bookkeeping, exactly where the other loop guards live. */
export class TurnEconomyGuard {
  private codeSearchUsed = 0;
  private reachUsed = 0;
  private codingGranted = false;
  private spelunkLedgered = false;
  private reachLedgered = false;

  /** The stub decision for a call about to execute, or null to
   *  let it run (counting it against its wire). exists() is the
   *  caller's code-root existence check (codeFileExists), kept
   *  injected so this guard stays pure. */
  decide(name: string, args: Record<string, unknown> | undefined, exists: (rel: string) => boolean): TurnEconomyDecision | null {
    if (name === "sam_code" && (typeof args?.action === "string" ? args.action : "") === "write") {
      const rel = typeof args?.path === "string" ? args.path : "";
      if (rel && scratchScriptPath(rel) && !exists(rel)) {
        return { stub: scratchScriptStubContent(rel), ledger: { kind: "scratch-write-refused", summary: scratchRefusalLedgerSummary(rel) } };
      }
    }
    if (isCodeSearchCall(name, args)) {
      if (this.codingGranted) return null;
      if (this.codeSearchUsed >= CODE_SEARCH_LIMIT) {
        const decision: TurnEconomyDecision = { stub: spelunkStubContent(), steer: spelunkSteerNote() };
        if (!this.spelunkLedgered) { this.spelunkLedgered = true; decision.ledger = { kind: "spelunk-tripwire", summary: spelunkLedgerSummary() }; }
        return decision;
      }
      this.codeSearchUsed++;
      return null;
    }
    if (name === "sam_reach") {
      if (this.reachUsed >= REACH_CALL_LIMIT) {
        const decision: TurnEconomyDecision = { stub: researchStubContent(), steer: researchSteerNote() };
        if (!this.reachLedgered) { this.reachLedgered = true; decision.ledger = { kind: "research-tripwire", summary: researchLedgerSummary() }; }
        return decision;
      }
      this.reachUsed++;
      return null;
    }
    return null;
  }

  /** A landed code change - or a coding job queued through the
   *  sanctioned doors - earns the turn its digging room: real
   *  code work is underway, and verifying it may need to look.
   *  Called only for executed calls that did not error. */
  noteSuccess(name: string, args: Record<string, unknown> | undefined): void {
    if (name === "sam_coding_task" || name === "sam_parallel_task") { this.codingGranted = true; return; }
    if (name !== "sam_code") return;
    const action = typeof args?.action === "string" ? args.action : "";
    if (action === "write" || action === "edit") this.codingGranted = true;
  }
}

// The tripwire scorecard (2026-11-18, the measured-proof
// series): the turn-economy guard ledgers exactly one line
// per tripped turn per wire - kind "spelunk-tripwire" when
// code digging passes CODE_SEARCH_LIMIT with no code change
// landed, kind "research-tripwire" when sam_reach passes
// REACH_CALL_LIMIT - but no daily surface ever counted the
// trips, so a model that started escalating ordinary
// questions into codebase digs or research sweeps was
// invisible in aggregate. This text folds both kinds' lines
// to counts only: the total tripped turns, counts per fixed
// wire (spelunk / research, an unmatched shape "other"), and
// the summed calls at trip parsed from the fixed summaries.
// A summary matching neither fixed shape counts as a trip
// and contributes no calls, and is never printed. No stamp,
// no actor, and no verbatim summary enters the text, so a
// day no wire trips is byte-identical and P3-silent, and the
// first new tripped turn is the news. A pure read: it
// creates nothing, spends no model call, and retries nothing
// - the ledger and the guard seam are untouched, and
// steering a tripped turn stays the guard's job.
export type TripwireWire = "spelunk" | "research";
export function parseTripwireSummary(summary: string): { wire: TripwireWire; calls: number } | null {
  const spelunk = /^Code digging cut in a chat turn after (\d+) code lookups/.exec(summary);
  if (spelunk) return { wire: "spelunk", calls: Number(spelunk[1]) };
  const research = /^Research calls cut in a chat turn after (\d+) sam_reach calls/.exec(summary);
  if (research) return { wire: "research", calls: Number(research[1]) };
  return null;
}
export function tripwireScorecardText(root: string): string {
  const lines = [
    ...readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "spelunk-tripwire" }),
    ...readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "research-tripwire" }),
  ];
  const wires: Record<string, number> = {};
  let calls = 0;
  for (const line of lines) {
    const parsed = parseTripwireSummary(line.summary);
    const wire = parsed ? parsed.wire : "other";
    wires[wire] = (wires[wire] ?? 0) + 1;
    if (parsed) calls += parsed.calls;
  }
  const wireText = (["spelunk", "research", "other"] as const).filter(w => wires[w]).map(w => w + " " + String(wires[w])).join(", ") || "none";
  const out: string[] = [];
  out.push("Tripwires: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Tripped turns: " + String(lines.length));
  out.push("By wire: " + wireText);
  out.push("Calls at trip: " + String(calls));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a turn or prints a summary; a new tripped turn is the news");
  return out.join("\n");
}

// The scratch-refusal scorecard (2026-11-18, the
// measured-proof series): the turn-economy guard's third
// wire refuses a chat turn's creation of a throwaway
// scratch script in the code root and ledgers one
// "scratch-write-refused" line per refusal, carrying the
// invented path only - but no daily surface ever counted
// the refusals, so a model that started inventing scratch
// scripts as a habit was invisible in aggregate. This text
// folds those lines to counts only: the total refused
// writes and counts per fixed extension bucket (py / sh /
// js / mjs / cjs, an unmatched shape "other") parsed from
// the fixed summary's path. A summary matching the fixed
// shape with an extension outside the set, and a summary
// matching no fixed shape at all, both count as a refusal
// under "other" and contribute nothing else, and no path
// is ever printed. No stamp, no actor, and no verbatim
// summary enters the text, so a day no write is refused is
// byte-identical and P3-silent, and the first refusal is
// the news. A pure read: it creates nothing, spends no
// model call, and retries nothing - the ledger and the
// guard seam are untouched, and refusing a scratch write
// stays the guard's job.
const SCRATCH_EXTENSIONS = ["py", "sh", "js", "mjs", "cjs"] as const;
export function parseScratchRefusalSummary(summary: string): { extension: string } | null {
  const m = /^Refused a scratch script write in a chat turn: (\S+) in the code root - /.exec(summary);
  if (!m) return null;
  const base = m[1].split(/[\\/]+/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return { extension: (SCRATCH_EXTENSIONS as readonly string[]).includes(ext) ? ext : "other" };
}
export function scratchScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "scratch-write-refused" });
  const exts: Record<string, number> = {};
  for (const line of lines) {
    const parsed = parseScratchRefusalSummary(line.summary);
    const ext = parsed ? parsed.extension : "other";
    exts[ext] = (exts[ext] ?? 0) + 1;
  }
  const extText = ([...SCRATCH_EXTENSIONS, "other"] as const).filter(e => exts[e]).map(e => e + " " + String(exts[e])).join(", ") || "none";
  const out: string[] = [];
  out.push("Scratch writes: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Refused writes: " + String(lines.length));
  out.push("By extension: " + extText);
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a write or prints a path or summary; a new refused write is the news");
  return out.join("\n");
}

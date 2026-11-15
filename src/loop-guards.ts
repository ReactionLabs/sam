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

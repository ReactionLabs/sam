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
 *   and appends a verification note whenever the ledger does
 *   not read verified, so a change is never "done" on the
 *   model's say-so alone.
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

/** The deterministic self-check note a code-changing chat turn
 *  closes with, or null when there is nothing to correct: the
 *  ledger reads verified (fresh build AND test after the last
 *  change) or clean (no changes recorded). An unverified epoch
 *  names its pending files; a failed epoch names the failure -
 *  in both cases the change is not done, whatever the reply
 *  above the note claims. */
export function codeVerificationNote(status: VerificationStatus): string | null {
  if (status.state === "unverified") {
    const pending = status.pendingChanges.map(c => c.path).slice(0, 6).join(", ");
    return "Verification note: code changed in this turn and is not verified yet - a fresh build and test have not both passed after the last change" + (pending ? " (unverified: " + pending + ")" : "") + ". The change above is not done until both pass; run them through sam_code, or hand the work to the coding loop.";
  }
  if (status.state === "failed") {
    return "Verification note: code changed in this turn and the latest verification after the change FAILED, so the change above is not done, whatever it says. Read the failing build or test output, fix the cause, and verify again.";
  }
  return null;
}

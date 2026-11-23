import { listActions, proposeAction, type ActionProposal } from "./actions.js";
import { PreferenceStore, type PreferenceKind } from "./preferences.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Corrections (program P6): when the owner corrects SAM - "don't call it a
// mini", "stop doing Y", "use X instead of Y" - the correction must not wash
// past, and it must not silently become law either. It proposes a standing
// law through the P1 approval gate: nothing is law until the owner approves
// the proposal in the dashboard or by CLI, and rejecting it leaves no trace
// in the profile's law. Detection is deterministic and deliberately narrow,
// in the same spirit as extractPreferences: it fires only on corrective
// imperative language aimed at SAM's own behaviour, extracts a concrete
// rule statement, and refuses vague corrections ("don't do that", a bare
// "not like that") that carry no rule worth proposing. First-person
// dislikes ("I don't like Mondays") are preferences, never corrections.
// A plain prospective rule ("never trade on Fridays") is not a correction
// either: it keeps the preferences path, where explicit rules are law the
// moment they are stated.
export interface Correction { statement: string }
const NO_CONTENT = new Set(["a", "an", "the", "it", "that", "this", "them", "those", "these", "me", "us", "you", "so", "do", "does", "be", "been", "to", "of", "at", "on", "in", "again", "just", "really"]);
const IMPERATIVES = new Set(["keep", "use", "make", "say", "call", "write", "send", "post", "put", "give", "show", "answer", "reply", "respond", "format", "leave", "list", "quote", "name", "spell", "check", "ask", "tell", "start", "try", "remember", "lead", "open", "close", "end", "begin"]);
function cleanFragment(raw: string): string {
  return raw.replace(/\s+/g, " ").trim()
    .replace(/^[,;:\-–—\s]+/, "")
    .replace(/\s+(please|thanks|thank you)$/i, "")
    .replace(/[.!?,;:\s]+$/, "")
    .trim();
}
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
// A fragment carries a rule only if, past its leading verb and the filler
// words, at least one concrete word remains ("a mini", "em dashes").
function hasContent(fragment: string, skipLeading = 0): boolean {
  const words = fragment.toLowerCase().replace(/[^a-z0-9' -]/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(skipLeading).some(w => !NO_CONTENT.has(w));
}
function finish(statement: string): Correction | null {
  const clean = capitalize(cleanFragment(statement));
  if (clean.length < 8 || clean.length > 200) return null;
  return { statement: clean };
}
export function detectCorrection(text: string): Correction | null {
  if (!text || text.length > 4000) return null;
  const t = text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  // Replacement corrections first: they carry both sides of the rule.
  m = /\bcall\s+(it|that|them|this)\s+([^.,!?;]+?)\s*,?\s+not\s+([^.,!?;]+)/i.exec(t);
  if (m && hasContent(m[2]) && hasContent(m[3])) return finish("Call " + m[1].toLowerCase() + " " + cleanFragment(m[2]) + ", not " + cleanFragment(m[3]));
  m = /\buse\s+([^.,!?;]+?)\s+instead\s+of\s+([^.,!?;]+)/i.exec(t);
  if (m && hasContent(m[1]) && hasContent(m[2])) return finish("Use " + cleanFragment(m[1]) + " instead of " + cleanFragment(m[2]));
  m = /\buse\s+([^.,!?;]+?)\s*,?\s+not\s+([^.,!?;]+?)(?:[.!?]|$)/i.exec(t);
  if (m && hasContent(m[1]) && hasContent(m[2])) return finish("Use " + cleanFragment(m[1]) + ", not " + cleanFragment(m[2]));
  // Naming corrections: "don't call it a mini" - the proof case. The rule is
  // the prohibition, stated positively so it reads as law once approved.
  m = /\b(?:don't|do not)\s+call\s+(?:(it|that|them|this)\s+)?([^.,!?;]+)/i.exec(t);
  if (m && hasContent(m[2])) return finish("Never call " + (m[1] ? m[1].toLowerCase() + " " : "") + cleanFragment(m[2]));
  m = /\bstop\s+calling\s+(?:(it|that|them|this)\s+)?([^.,!?;]+)/i.exec(t);
  if (m && hasContent(m[2])) return finish("Never call " + (m[1] ? m[1].toLowerCase() + " " : "") + cleanFragment(m[2]));
  // "Stop doing Y": the gerund phrase is the rule, kept in the owner's words.
  m = /\bstop\s+([a-z]+ing\b[^.,!?;]*)/i.exec(t);
  if (m && hasContent(m[1], 1)) return finish("Stop " + cleanFragment(m[1]));
  // "Not like that" only proposes when the owner says how instead; the
  // follow-on must itself be an imperative with concrete content.
  m = /\bnot\s+like\s+that\b[^a-z0-9]+(.+)/i.exec(t);
  if (m) {
    const rest = cleanFragment(m[1]);
    const first = rest.toLowerCase().split(/\s+/)[0] ?? "";
    if (IMPERATIVES.has(first) && hasContent(rest, 1)) return finish(rest);
    return null;
  }
  // General negative imperative: "don't use em dashes", "do not send that
  // yet". Fires anywhere EXCEPT directly after a subject pronoun - "I don't
  // like X" is a preference, and "you don't..." is a statement, neither is
  // the owner correcting SAM.
  m = /(?<!\b(?:i|we|you|he|she|they|it)\s)(?:don't|do not)\s+([^.,!?;]+)/i.exec(t);
  if (m && hasContent(m[1], 1)) return finish("Never " + cleanFragment(m[1]));
  return null;
}
function normStatement(s: string): string { return s.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " "); }
// Route one detected correction into the P1 gate. Deduped twice over: an
// identical pending law proposal for the same profile is returned as-is
// (created:false), and a correction that is already standing law proposes
// nothing at all. Returns null when there is nothing to approve.
export function proposeCorrection(root: string, input: { actor: string; chatId?: string | null; text: string }): { proposal: ActionProposal; created: boolean } | null {
  const found = detectCorrection(input.text);
  if (!found) return null;
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") return null;
  const prefs = new PreferenceStore(root);
  try {
    if (prefs.lawsFor(input.actor).some(l => normStatement(l.statement) === normStatement(found.statement))) return null;
  } finally { prefs.close(); }
  const pending = listActions(root).find(a => a.status === "pending" && a.kind === "law" && a.actor === input.actor && normStatement(a.detail) === normStatement(found.statement));
  if (pending) return { proposal: pending, created: false };
  const proposal = proposeAction(root, {
    actor: input.actor, kind: "law",
    title: ("Correction: " + found.statement).slice(0, 200),
    detail: found.statement, chatId: input.chatId ?? null,
  });
  recordActivity(root, input.actor, "correction", correctionLedgerSummary(found.statement));
  return { proposal, created: true };
}
// The ONE writer for the correction ledger line: the
// proposeCorrection seam above ledgers exactly this shape
// when a detected correction is proposed as law through the
// P1 gate, so the writer and the scorecard's parser below can
// never drift.
export function correctionLedgerSummary(statement: string): string {
  return "Correction proposed as law: " + statement;
}
// The correction scorecard (2026-11-19, the measured-proof
// series): owner corrections have ledgered as "correction"
// lines in the one fixed shape above since P6 landed, but the
// class was never folded, so how often the owner has had to
// correct SAM - and whether the same rule needed proposing
// twice - was invisible in aggregate. Every correction line
// is by construction a behaviour the owner had to correct, so
// the verdict is attention when any line exists or any line
// is unparseable, else clear. This text folds the whole
// ledger's correction lines to counts only, on ONE line: the
// proposed count, the distinct-rule count, and the total. The
// distinct count rides each line's statement internally
// (normalized exactly as the gate dedupes) and surfaces as a
// number only: no stamp, no actor, and never the statement
// itself enters the text - the statement is the owner's own
// words as law-to-be. A summary matching no fixed shape
// counts toward the total and the unparseable count only,
// and is never printed. A pure read: it creates nothing,
// spends no model call, and proposes nothing - the ledger
// and the gate seam are untouched. (Statements are capped at
// 200 chars by the detector, so a written line never reaches
// the ledger's 300-char summary cap and no capped shape
// exists for this class.)
export function parseCorrectionSummary(summary: string): { statement: string } | null {
  const m = /^Correction proposed as law: (\S.*)$/.exec(summary);
  if (!m) return null;
  const statement = m[1].trim();
  if (!statement) return null;
  return { statement };
}
export function correctionScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "correction" });
  const distinct = new Set<string>();
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseCorrectionSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    distinct.add(normStatement(parsed.statement));
  }
  const parts: string[] = [];
  parts.push("Corrections: " + (lines.length > 0 ? "attention" : "clear"));
  parts.push(String(lines.length - unparseable) + " proposed");
  parts.push(String(distinct.size) + " distinct rules");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
// Correction routing failure visibility (hourly run 2026-11-14):
// the LIVE TURN's correction catch was bare - proposeCorrection
// throwing (a dead actions.db or preferences.db) was swallowed
// under "correction plumbing never breaks a turn", the turn
// continued with no correction note, and SAM neither followed
// the correction in that reply nor acknowledged a proposal -
// the P6 contract failing silently, with no correction-failed
// kind anywhere to count it. (The consolidation scan ledgers
// the same routing failure as consolidate-failed:corrections,
// but it cannot restore the in-turn application the live path
// lost.) The guarded wrapper below is the live turn's seam:
// a throw ledgers ONE correction-failed line (phase propose;
// the actor named; the verbatim reason collapsed + capped;
// never the owner's message text or the correction statement)
// and returns null exactly as the swallowed catch did, so the
// turn still never breaks. proposeCorrection itself still
// throws, so its direct callers are unchanged: the CLI
// surfaces the error, and consolidation aggregates its own
// failures into its one consolidate-failed line per run -
// it calls proposeCorrection directly, never this wrapper,
// so one failed touch never ledgers twice.
export function correctionFailureSummary(actor: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Correction propose failed for " + actor + ": " + clean).slice(0, 200);
}
/**
 * The reason a correction-failed line carries (census sprint
 * 2026-11-17): recordCorrectionFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function correctionFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordCorrectionFailure(root: string, actor: string, error: unknown): void {
  const reason = correctionFailureReason(error);
  recordActivity(root, actor, "correction-failed", correctionFailureSummary(actor, reason));
}
// The correction failed history scorecard (2026-11-23, the
// measured-proof series): the live turn's correction routing
// ledgers every failed routing as a "correction-failed" line
// through the ONE writer above (correctionFailureSummary, one
// fixed shape: "Correction propose failed for <actor>:
// <reason>", the one fixed phase propose, capped 200), ridden
// by recordCorrectionFailure from the ONE seam
// tryRouteCorrection - but the class was never folded, so how
// often an owner's correction died at the routing (the turn
// continued without following it and without acknowledging a
// proposal, the P6 contract failing in the turn where it
// mattered) was invisible in aggregate. The correction
// scorecard folds only the successful proposed-law lines,
// never these failure lines. The parser learns only the
// writer's fixed shape: the fixed propose head, a single-token
// actor, and a non-empty reason; the actor is consumed for the
// distinct count and never printed, and the reason is consumed
// and never printed. A line from any other kind never parses.
// The fold is counts only: no stamp, no actor, no reason, no
// verbatim summary, and never the owner's message text or the
// correction statement (neither ever enters the writer's line
// either). A pure read: it creates nothing, spends no model
// call, and routes nothing - the routing seam is untouched.
export function parseCorrectionFailedSummary(summary: string): { actor: string } | null {
  const m = /^Correction propose failed for (\S+): ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const actor = m[1] ?? "";
  const reason = m[2] ?? "";
  if (!actor || !reason.trim()) return null;
  return { actor };
}

export function correctionFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "correction-failed" });
  let failed = 0;
  let unparseable = 0;
  const actors = new Set<string>();
  for (const line of lines) {
    const parsed = parseCorrectionFailedSummary(line.summary);
    if (parsed) { failed += 1; actors.add(parsed.actor); continue; }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Correction failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(actors.size) + " distinct actors");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
export function tryRouteCorrection(root: string, input: { actor: string; chatId?: string | null; text: string }): { proposal: ActionProposal; created: boolean } | null {
  try { return proposeCorrection(root, input); }
  catch (error) { recordCorrectionFailure(root, input.actor, error); return null; }
}
// When a message is a correction, a preference rule extracted from the same
// words must not slip in as instant law beside the gate: drop rule extractions
// that restate the correction; likes and dislikes from the message still note.
export function withoutCorrectedRules<T extends { statement: string; kind: PreferenceKind }>(found: T[], correction: Correction | null): T[] {
  if (!correction) return found;
  const target = normStatement(correction.statement);
  return found.filter(f => {
    if (f.kind !== "rule") return true;
    const s = normStatement(f.statement);
    return !(s === target || target.includes(s) || s.includes(target));
  });
}

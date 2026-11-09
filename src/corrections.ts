import { listActions, proposeAction, type ActionProposal } from "./actions.js";
import { PreferenceStore, type PreferenceKind } from "./preferences.js";
import { recordActivity } from "./activity.js";

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
  recordActivity(root, input.actor, "correction", "Correction proposed as law: " + found.statement);
  return { proposal, created: true };
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

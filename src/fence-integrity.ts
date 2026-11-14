import { createHash } from "node:crypto";
import { PreferenceStore, type Preference } from "./preferences.js";
import { recordActivity } from "./activity.js";

// Fence integrity (Program H, self-knowledge item C - filed
// requirement 4): fences get first claim on the budget and must
// survive any summarization VERBATIM, verified by a separate
// diff + identifier check after the compaction runs; a single
// changed identifier fails the pass.
//
// Where Sam stands structurally: standing law never enters a
// summarizer at all. Law lives in preferences.db, is read from
// the store on every turn, and assembles last in the prompt as
// the override layer - compaction folds CHAT history, and its
// flush writes observations, never law. So the invariant "law
// is byte-identical across any compaction" holds by
// construction today, but until this module NOTHING CHECKED it:
// an unmeasured invariant is a hope, and Mita's own trim pass
// two survived only because a separate fence-diff pass compared
// the FENCES block byte-for-byte against the verified base and
// grep-checked 15 critical identifiers before the result was
// trusted. This is that pass, as a mechanism:
//
// - snapshotLaw reads the profile's standing law (id +
//   statement, in store order) and digests it.
// - verifyLawVerbatim diffs two snapshots byte-for-byte per
//   record and re-checks every identifier extracted from the
//   BEFORE statements (UUIDs, emails, URLs, phone-shaped digit
//   runs, and letter+digit codes like 47-ALPHA) against the
//   AFTER text: an identifier that moved, even inside an
//   otherwise plausible rewrite, fails the check by name.
// - buildChatContext runs the pair around every fold: snapshot
//   before the flush, verify after the save; a failure ledgers
//   ONE fence-integrity-failed line and the fold's context is
//   refused (the caller fails open to the raw tail, exactly its
//   standing contract) instead of a quietly altered prompt
//   being trusted.
// The reader is injectable so the check can be PROVEN able to
// say no (the prompt-audit precedent: an instrument that cannot
// fail is decoration) - the eval battery and the tests tamper
// with the after-read and require the failure.
export interface LawSnapshot {
  profile: string;
  entries: Array<{ id: string; statement: string }>;
  digest: string;
}
export interface FenceCheck {
  ok: boolean;
  changedIds: string[];
  missingIdentifiers: string[];
}

export function digestLaw(entries: Array<{ id: string; statement: string }>): string {
  return createHash("sha256").update(entries.map(e => e.id + "\n" + e.statement).join("\n--\n")).digest("hex");
}

export function snapshotFromLaws(profile: string, laws: Preference[]): LawSnapshot {
  const entries = laws.map(l => ({ id: l.id, statement: l.statement }));
  return { profile, entries, digest: digestLaw(entries) };
}

export function readLawSnapshot(root: string, profile: string): LawSnapshot {
  const store = new PreferenceStore(root);
  try { return snapshotFromLaws(profile, store.lawsFor(profile)); } finally { store.close(); }
}

/** Identifiers worth failing a compaction over: the strings a
 *  summary must never be allowed to "helpfully" rewrite. */
export function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    /[\w.+-]+@[\w-]+\.[\w.]+/g,
    /https?:\/\/[^\s)]+/g,
    /\b\d[\d\s().-]{5,}\d\b/g,
    /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{4,}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found].sort();
}

/** The verbatim diff: every BEFORE entry must exist in AFTER
 *  with a byte-identical statement, and every identifier in the
 *  BEFORE text must still appear in the AFTER text. Changed or
 *  vanished records and lost identifiers are named, never
 *  summarized away. */
export function verifyLawVerbatim(before: LawSnapshot, after: LawSnapshot): FenceCheck {
  const afterById = new Map(after.entries.map(e => [e.id, e.statement]));
  const changedIds: string[] = [];
  for (const entry of before.entries) {
    if (afterById.get(entry.id) !== entry.statement) changedIds.push(entry.id);
  }
  const afterText = after.entries.map(e => e.statement).join("\n");
  const missingIdentifiers = extractIdentifiers(before.entries.map(e => e.statement).join("\n"))
    .filter(id => !afterText.includes(id));
  return { ok: changedIds.length === 0 && missingIdentifiers.length === 0, changedIds, missingIdentifiers };
}

export function fenceIntegrityFailureSummary(profile: string, check: FenceCheck): string {
  const parts: string[] = [];
  if (check.changedIds.length) parts.push(String(check.changedIds.length) + " law record(s) changed: " + check.changedIds.map(id => id.slice(0, 8)).join(", "));
  if (check.missingIdentifiers.length) parts.push("identifier(s) lost: " + check.missingIdentifiers.slice(0, 4).join(", "));
  return ("Fence integrity check failed for profile " + profile + ": " + (parts.join("; ") || "law snapshot digest changed")).slice(0, 300);
}

export function recordFenceIntegrityFailure(root: string, actor: string, profile: string, check: FenceCheck): void {
  recordActivity(root, actor, "fence-integrity-failed", fenceIntegrityFailureSummary(profile, check));
}

/** The paired check compaction runs around a fold: snapshot,
 *  run the fold steps, verify. Returns the check; the caller
 *  decides how to refuse (compaction ledgers and rethrows). The
 *  reader seam exists for the negative control in tests. */
export function verifyLawAcrossFold(
  root: string,
  profile: string,
  before: LawSnapshot,
  readAfter: (root: string, profile: string) => LawSnapshot = readLawSnapshot,
): FenceCheck {
  return verifyLawVerbatim(before, readAfter(root, profile));
}

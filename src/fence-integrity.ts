import { createHash } from "node:crypto";
import { PreferenceStore, type Preference } from "./preferences.js";
import { readActivity, recordActivity } from "./activity.js";

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

// The fence integrity failed history scorecard (2026-11-22, the
// measured-proof series): the compaction fold ledgers every
// standing-law movement as a "fence-integrity-failed" line
// through the ONE writer fenceIntegrityFailureSummary above,
// ridden by the one seam recordFenceIntegrityFailure - but the
// class was never folded, so how often a profile's law moved
// across a fold was invisible in aggregate. The parser learns
// only the writer's fixed shapes: the digest fallback; a
// changed part whose explicit count precedes its list of
// 8-char record-id slices (the listed ids must agree with the
// count, unless the writer's 300-char cap truncated the list,
// which only a line at the cap can claim); and a lost part of
// at most 4 comma-separated identifiers (identifiers never
// carry a comma or a semicolon; the list is consumed and
// never counted or printed). A line from any other kind never
// parses. The fold is counts only: no stamp, no actor, no
// profile name, no record id, no identifier, no verbatim
// summary - the changed-record counts are summed from the
// explicit counts at the head of each changed part, which the
// cap can never reach.
export function parseFenceIntegrityFailedSummary(summary: string): { profile: string; changed: number } | null {
  const m = /^Fence integrity check failed for profile ([^:]+): ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const profile = m[1] ?? "";
  if (!profile || profile !== profile.trim()) return null;
  const tail = m[2] ?? "";
  if (tail === "law snapshot digest changed") return { profile, changed: 0 };
  let changedPart: string | null = tail;
  let lostPart: string | null = null;
  const lostSep = "; identifier(s) lost: ";
  const lostIdx = tail.indexOf(lostSep);
  if (lostIdx >= 0) {
    changedPart = tail.slice(0, lostIdx);
    lostPart = tail.slice(lostIdx + lostSep.length);
  } else if (tail.startsWith("identifier(s) lost: ")) {
    changedPart = null;
    lostPart = tail.slice("identifier(s) lost: ".length);
  }
  if (lostPart !== null) {
    if (!lostPart) return null;
    const identifiers = lostPart.split(", ");
    if (identifiers.length > 4) return null;
    for (const identifier of identifiers) {
      if (!identifier || identifier !== identifier.trim() || /[,;]/.test(identifier)) return null;
    }
  }
  let changed = 0;
  if (changedPart !== null) {
    const cm = /^(\d+) law record\(s\) changed: ([\s\S]+)$/.exec(changedPart);
    if (!cm) return null;
    const n = Number(cm[1]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    const ids = (cm[2] ?? "").split(", ");
    for (const id of ids) {
      if (!/^[^\s,;]{1,8}$/.test(id)) return null;
    }
    if (ids.length > n) return null;
    if (ids.length < n && summary.length < 300) return null;
    changed = n;
  }
  return { profile, changed };
}

export function fenceIntegrityFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "fence-integrity-failed" });
  let failed = 0;
  let unparseable = 0;
  let changedRecords = 0;
  const profiles = new Set<string>();
  for (const line of lines) {
    const parsed = parseFenceIntegrityFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      profiles.add(parsed.profile);
      changedRecords += parsed.changed;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Fence integrity failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(profiles.size) + " distinct profiles");
  parts.push(String(changedRecords) + " changed records");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
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

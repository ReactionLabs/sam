import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Capture guard (Program H, self-knowledge item A - the keystone):
// a standing owner instruction to keep something out of memory now
// BINDS every automatic capture path at write time.
//
// The live defect this closes (2026-11-14, found by SAM itself
// during the owner-budget acceptance run): Dip told SAM to keep a
// test secret phrase out of memory, and the automatic episode
// flush wrote the phrase verbatim into a memory observation
// record anyway - where SAM later found it and answered from it,
// citations and all. The instruction existed only as words in a
// chat; nothing in the write path ever consulted it. Mita's own
// harness learned the same lesson the same week (a standing
// instruction that no mechanism enforces is a slogan, not a rule).
//
// The mechanism, deliberately narrow and deterministic (the
// extractPreferences precedent - owner's own words, no model call):
// - A suppression is a per-profile record in preferences.db (the
//   law store's home): a needle (the phrase or topic, normalized),
//   provenance, and a status. It is governance metadata for the
//   write path only - it is NEVER injected into a prompt, never
//   returned by recall, and the needle itself never enters an
//   activity line (lines carry the suppression id and a sha256
//   prefix of the needle, never the words).
// - Creation doors: deterministic extraction from the owner's own
//   chat words at the two existing capture seams (the live turn
//   and the heartbeat scan), and the operator CLI
//   (sam memory suppress). Revocation is the owner's word via
//   the CLI (status flip, never a delete - the record of the
//   instruction survives, like revoked law).
// - Enforcement is at write time, in depth: the episode flush
//   filters suppressed messages out of the day's evidence AND
//   summary (and the evidence row is rewritten filtered, so the
//   derived cache heals on the next consolidation), the
//   compaction flush drops suppressed messages from its digest,
//   the two preference-extraction seams skip suppressed finds,
//   and MemoryStore.add itself refuses any record whose content
//   matches an active suppression for its scope (the backstop
//   that binds every present and future writer). Automatic paths
//   catch the refusal, ledger ONE memory-suppressed line, and
//   degrade exactly as their contracts already promise; an
//   explicit door (CLI add, a saved note, an approved action)
//   surfaces the refusal loudly instead - the owner can revoke
//   the suppression first if the save is truly intended.
// - What it does NOT do: the chat record itself is untouched
//   (the owner's words in his own chats are his history, not
//   memory capture), and records written BEFORE a suppression
//   existed are never auto-purged - archiving stored memory is
//   the owner's tap, so a new suppression ledgers how many live
//   records already match, for his purge decision.
export interface CaptureSuppression {
  id: string; profile: string; needle: string; source: string;
  status: "active" | "revoked"; created_at: string; updated_at: string;
}

function validProfile(profile: string): boolean {
  return profile === "sam" || /^[a-z][a-z0-9._-]{0,63}$/.test(profile);
}
function prefsDbPath(root: string): string {
  return join(resolve(root), ".sam", "preferences.db");
}

// Failure visibility (gap found 2026-11-15, hourly run
// 04:04 EST): CaptureGuardStore rides the same
// preferences.db file as PreferenceStore under its own
// class and table, so the preference-store guard does not
// name it. Every touch opened the file raw: the
// constructor's open (schema creation), add (the CLI
// suppress door plus both capture seams), list / activeFor
// (the episode and compaction flushes consult the active
// list on every consolidation), revoke (the CLI door), and
// the direct-DB backstop findSuppressionHitInDb, which
// MemoryStore.add consults on every memory write. A dead
// store threw with the seam unnamed - and the capture seams
// swallow throws by design, so a dead guard would stop
// recording new do-not-store instructions with nothing
// counted, while any reader folding a dead store as "no
// suppressions" would silently unbind the owner's standing
// instruction dressed as an empty list. Now the touches
// own their failure (the preferences / chats precedent,
// adapted to this class): a failed touch ledgers ONE
// capture-guard-failed line (the constructor's open at
// phase write, because the open performs the schema
// writes; list / activeFor and the backstop door at phase
// read; add / revoke at phase write; actor sam; the
// verbatim reason collapsed and capped; never any
// suppression record - needles are the owner's secret
// words, not failure data), tags the error, and rethrows
// exactly, so every caller's handling is unchanged and
// reads still fail closed. A touch already ledgered by an
// inner door keeps its one line and gains no second.
// Validation errors (Invalid profile, Invalid suppression
// phrase) are not store failures and ledger nothing. The
// backstop door's absent-file and no-table-yet shapes
// still read as no suppressions, creating nothing.
export type CaptureGuardPhase = "read" | "write";

export function captureGuardFailureSummary(phase: CaptureGuardPhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Capture guard store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a capture-guard-failed line carries (census sprint
 * 2026-11-17): recordCaptureGuardFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function captureGuardFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordCaptureGuardFailure(root: string, phase: CaptureGuardPhase, error: unknown): void {
  const reason = captureGuardFailureReason(error);
  recordActivity(root, "sam", "capture-guard-failed", captureGuardFailureSummary(phase, reason));
}

function tagCaptureGuardLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { captureGuardLedgered?: boolean }).captureGuardLedgered = true;
  }
}

export function isCaptureGuardLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { captureGuardLedgered?: boolean }).captureGuardLedgered === true;
}

const CAPTURE_GUARD_VALIDATION = [/^Invalid profile$/, /^Invalid suppression phrase/];

function isCaptureGuardValidation(error: unknown): boolean {
  return error instanceof Error && CAPTURE_GUARD_VALIDATION.some(re => re.test(error.message));
}

function failCaptureGuard(root: string, phase: CaptureGuardPhase, error: unknown): never {
  if (!isCaptureGuardLedgered(error) && !isCaptureGuardValidation(error)) recordCaptureGuardFailure(root, phase, error);
  if (!isCaptureGuardValidation(error)) tagCaptureGuardLedgered(error);
  throw error;
}

/** Normalize free text to a word stream: lowercase, punctuation
 *  becomes spacing, whitespace collapsed. Needles and content are
 *  compared in this space so case, quoting, and punctuation never
 *  decide whether a standing instruction held. */
export function normalizeGuardText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function needleKey(needle: string): string { return normalizeGuardText(needle); }
export function needleFingerprint(needle: string): string {
  return createHash("sha256").update(needleKey(needle)).digest("hex").slice(0, 12);
}

/** Whether content carries a needle: the full normalized needle
 *  as a phrase, or - for needles with at least two distinctive
 *  words (4+ chars) - every distinctive word present anywhere in
 *  the content (word order and interruption do not rescue a
 *  restated secret; a single shared word never trips it). */
export function needleMatches(needle: string, content: string): boolean {
  const key = needleKey(needle);
  if (!key) return false;
  const hay = " " + normalizeGuardText(content) + " ";
  if (hay.includes(" " + key + " ")) return true;
  const tokens = [...new Set(key.split(" ").filter(t => t.length >= 4))];
  if (tokens.length >= 2) {
    const words = new Set(hay.split(" ").filter(Boolean));
    return tokens.every(t => words.has(t));
  }
  return false;
}

export class CaptureGuardStore {
  private db: Database.Database;
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
    let db: Database.Database | undefined;
    try {
      const dir = join(this.root, ".sam");
      mkdirSync(dir, { recursive: true });
      db = openDatabase(join(dir, "preferences.db"));
      db.exec(`CREATE TABLE IF NOT EXISTS capture_suppressions (
      id TEXT PRIMARY KEY, profile TEXT NOT NULL, needle TEXT NOT NULL,
      needle_key TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capture_suppressions_by_profile ON capture_suppressions(profile, status);`);
    } catch (error) { try { db?.close(); } catch { /* the open already failed */ } failCaptureGuard(this.root, "write", error); }
    this.db = db!;
  }
  private touch<T>(phase: CaptureGuardPhase, fn: () => T): T {
    try { return fn(); }
    catch (error) { failCaptureGuard(this.root, phase, error); }
  }
  add(profile: string, needle: string, source: string): { record: CaptureSuppression; created: boolean } {
    return this.touch("write", () => this.addInner(profile, needle, source));
  }
  private addInner(profile: string, needle: string, source: string): { record: CaptureSuppression; created: boolean } {
    if (!validProfile(profile)) throw new Error("Invalid profile");
    const clean = needle.trim().replace(/\s+/g, " ");
    if (clean.length < 3 || clean.length > 200) throw new Error("Invalid suppression phrase (3 to 200 characters)");
    const key = needleKey(clean);
    if (!key) throw new Error("Invalid suppression phrase");
    const existing = this.db.prepare("SELECT * FROM capture_suppressions WHERE profile = ? AND needle_key = ? AND status = 'active'")
      .get(profile, key) as CaptureSuppression | undefined;
    if (existing) return { record: existing, created: false };
    const now = new Date().toISOString();
    const record: CaptureSuppression = { id: randomUUID(), profile, needle: clean, source, status: "active", created_at: now, updated_at: now };
    this.db.prepare("INSERT INTO capture_suppressions (id, profile, needle, needle_key, source, status, created_at, updated_at) VALUES (@id, @profile, @needle, @key, @source, @status, @created_at, @updated_at)")
      .run({ ...record, key });
    return { record, created: true };
  }
  list(profile?: string, includeRevoked = false): CaptureSuppression[] {
    return this.touch("read", () => {
    const statusSql = includeRevoked ? "" : " AND status = 'active'";
    return (profile
      ? this.db.prepare("SELECT id, profile, needle, source, status, created_at, updated_at FROM capture_suppressions WHERE profile = ?" + statusSql + " ORDER BY created_at").all(profile)
      : this.db.prepare("SELECT id, profile, needle, source, status, created_at, updated_at FROM capture_suppressions WHERE 1 = 1" + statusSql + " ORDER BY created_at").all()) as CaptureSuppression[];
    });
  }
  activeFor(profile: string): CaptureSuppression[] { return this.list(profile); }
  revoke(id: string): boolean {
    return this.touch("write", () =>
      this.db.prepare("UPDATE capture_suppressions SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'active'")
        .run(new Date().toISOString(), id).changes === 1);
  }
  close(): void { this.db.close(); }
}

/** The refusal MemoryStore.add throws when a write matches an
 *  active suppression. Automatic capture paths catch this exact
 *  class, ledger one memory-suppressed line, and degrade;
 *  explicit doors let it surface to the owner. */
export class MemorySuppressedError extends Error {
  suppressionId: string;
  /** The matched suppression (in-process only - automatic
   *  paths use it to ledger the block in the family's shape). */
  hit: CaptureSuppression;
  constructor(hit: CaptureSuppression) {
    super("Memory write suppressed: the content matches a standing do-not-store instruction for profile " + hit.profile +
      " (suppression " + hit.id.slice(0, 8) + ", needle sha256 " + needleFingerprint(hit.needle) + "); nothing was stored. " +
      "Revoke the suppression first if this save is intended.");
    this.name = "MemorySuppressedError";
    this.suppressionId = hit.id;
    this.hit = hit;
  }
}

/** First active suppression whose needle matches the content,
 *  checked against a preferences.db file directly (the
 *  MemoryStore backstop's door: the missions.db and
 *  preferences.db live in the same .sam directory). profiles
 *  null means every profile's suppressions (link scopes are
 *  shared, so any owner's suppression binds them). A missing
 *  file or a store with no table yet reads as no suppressions -
 *  a fresh install has issued none. */
export function findSuppressionHitInDb(dbPath: string, profiles: string[] | null, content: string): CaptureSuppression | null {
  if (!existsSync(dbPath)) return null;
  // The install root rides two levels up from the db path
  // (<root>/.sam/preferences.db), so a dead backstop read
  // ledgers its capture-guard-failed line in the install's
  // own ledger and rethrows exactly; the absent-file shape
  // above and the no-table-yet shape below still read as
  // no suppressions and ledger nothing.
  const root = resolve(join(dirname(dbPath), ".."));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(dbPath);
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_suppressions'").get();
    if (!has) return null;
    const rows = (profiles && profiles.length
      ? db.prepare("SELECT id, profile, needle, source, status, created_at, updated_at FROM capture_suppressions WHERE status = 'active' AND profile IN (" + profiles.map(() => "?").join(",") + ")").all(...profiles)
      : db.prepare("SELECT id, profile, needle, source, status, created_at, updated_at FROM capture_suppressions WHERE status = 'active'").all()) as CaptureSuppression[];
    for (const row of rows) if (needleMatches(row.needle, content)) return row;
    return null;
  } catch (error) {
    failCaptureGuard(root, "read", error);
    throw error; // unreachable: failCaptureGuard always throws; this satisfies the compiler's end-of-function check
  }
  finally { try { db?.close(); } catch { /* a dead handle needs no close */ } }
}

/** The profiles a memory scope answers to for suppression
 *  checks: core is the operator profile, profile:<name> is that
 *  profile, a link scope is shared (null: every profile). */
export function suppressionProfilesForScope(scope: string): string[] | null {
  if (scope === "core") return ["sam"];
  if (scope.startsWith("profile:")) return [scope.slice("profile:".length)];
  return null;
}

export function activeSuppressions(root: string, profile: string): CaptureSuppression[] {
  if (!existsSync(prefsDbPath(root))) return [];
  const store = new CaptureGuardStore(root);
  try { return store.activeFor(profile); } finally { store.close(); }
}

export function findSuppressionHit(root: string, profile: string, content: string): CaptureSuppression | null {
  return findSuppressionHitInDb(prefsDbPath(root), [profile], content);
}

/** Record a suppression from the owner's own words (or the
 *  operator CLI): stores it (deduped against the active list)
 *  and, when newly created, ledgers ONE memory-suppression line
 *  naming how many live memory records already match - the
 *  backlog the owner may purge; nothing is auto-deleted. The
 *  count read is best-effort (a dead memory store never blocks
 *  recording the owner's instruction). */
export function addSuppression(root: string, input: { profile: string; needle: string; source: string; existingMatches?: number }): { record: CaptureSuppression; created: boolean } {
  const store = new CaptureGuardStore(root);
  let result: { record: CaptureSuppression; created: boolean };
  try { result = store.add(input.profile, input.needle, input.source); } finally { store.close(); }
  if (result.created) {
    const backlog = typeof input.existingMatches === "number" ? input.existingMatches : countExistingMatches(root, input.profile, result.record.needle);
    recordActivity(root, input.profile, "memory-suppression",
      suppressionRecordedLedgerSummary(input.profile, needleFingerprint(result.record.needle), result.record.id.slice(0, 8), String(input.source).slice(0, 40), backlog));
  }
  return result;
}

/** The ONE writer for the memory-suppression ledger line: a
 *  newly recorded suppression ledgers exactly this shape, so
 *  the writer and the scorecard's parser below can never
 *  drift. The line carries the needle's fingerprint and the
 *  suppression's 8-char prefix only - never the needle. */
export function suppressionRecordedLedgerSummary(profile: string, fingerprint: string, suppressionPrefix: string, source: string, backlog: number): string {
  return "Capture suppression recorded for profile " + profile + ": needle sha256 " + fingerprint +
    " (suppression " + suppressionPrefix + ", from " + source + "); " +
    String(backlog) + " live memory record(s) already match and await the owner's purge decision";
}

/** The ONE writer for the memory-suppressed ledger line: a
 *  blocked automatic write ledgers exactly this shape, so the
 *  writer and the scorecard's parser below can never drift.
 *  The line carries the suppression's 8-char prefix and the
 *  needle's fingerprint only - never the needle, never the
 *  content. */
export function suppressionBlockedLedgerSummary(via: string, actor: string, suppressionPrefix: string, fingerprint: string): string {
  return "Memory write suppressed via " + via + " for " + actor + ": matched capture suppression " + suppressionPrefix +
    " (needle sha256 " + fingerprint + "); nothing was stored";
}

// The suppression scorecard (2026-11-19, the measured-proof
// series): the capture guard's two ledger classes have folded
// nowhere, so how many suppressions the owner has standing,
// how much already-stored memory awaited a purge decision
// when each was recorded, and how often the guard has
// actually held a write back (and through which seam) was
// invisible in aggregate. The verdict is attention ONLY on an
// unparseable line, else clear: a recorded suppression is the
// owner's own governance act and a blocked write is the guard
// holding - the system working, deliberately not a defect
// (the self-work doctrine). This text folds both classes to
// counts only, on ONE line: the recorded count, the summed
// already-matching backlog, the blocked count with counts per
// fixed via bucket (episodes, compaction, other), the
// distinct-profile count, and the total. The distinct count
// rides each recorded line's profile internally and surfaces
// as a number only: no stamp, no actor, no profile name, no
// needle, no fingerprint, no suppression id, no source, and
// no verbatim summary enters the text. A summary matching no
// fixed shape counts toward the total and the unparseable
// count only, and is never printed. A pure read: it creates
// nothing, spends no model call, and suppresses nothing -
// the ledger and the guard seams are untouched. (Both
// written lines are short and fixed-shape, far under the
// ledger's 300-char summary cap, so no capped shape exists
// for this pair.)
export function parseSuppressionRecordedSummary(summary: string): { profile: string; backlog: number } | null {
  const m = /^Capture suppression recorded for profile ([^:]+): needle sha256 [0-9a-f]+ \(suppression [0-9a-f]{8}, from .+\); (\d+) live memory record\(s\) already match and await the owner's purge decision$/.exec(summary);
  if (!m) return null;
  return { profile: m[1], backlog: Number(m[2]) };
}
export function parseSuppressionBlockedSummary(summary: string): { via: string } | null {
  const m = /^Memory write suppressed via (\S+) for \S+: matched capture suppression [0-9a-f]{8} \(needle sha256 [0-9a-f]+\); nothing was stored$/.exec(summary);
  if (!m) return null;
  return { via: m[1] };
}
export function suppressionScorecardText(root: string): string {
  const recorded = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "memory-suppression" });
  const blocked = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "memory-suppressed" });
  const profiles = new Set<string>();
  let backlog = 0;
  let recordedParsed = 0;
  let unparseable = 0;
  for (const line of recorded) {
    const parsed = parseSuppressionRecordedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    recordedParsed += 1;
    profiles.add(parsed.profile);
    backlog += parsed.backlog;
  }
  let episodes = 0;
  let compaction = 0;
  let other = 0;
  for (const line of blocked) {
    const parsed = parseSuppressionBlockedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    if (parsed.via === "episodes") episodes += 1;
    else if (parsed.via === "compaction") compaction += 1;
    else other += 1;
  }
  const total = recorded.length + blocked.length;
  const parts: string[] = [];
  parts.push("Suppressions: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(recordedParsed) + " recorded");
  parts.push(String(backlog) + " already-matching records awaiting purge");
  parts.push(String(episodes + compaction + other) + " writes blocked (episodes " + String(episodes) + ", compaction " + String(compaction) + ", other " + String(other) + ")");
  parts.push(String(profiles.size) + " distinct profiles");
  parts.push(String(total) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

// The capture guard failed history scorecard (2026-11-23, the
// measured-proof series): the capture guard store's touches
// ledger every failure as a "capture-guard-failed" line
// through the ONE writer above (captureGuardFailureSummary,
// fixed shape "Capture guard store <phase> failed: <reason>",
// capped 200; phases read / write, ridden by
// recordCaptureGuardFailure from the store's touches, actor
// sam) - and while the suppression scorecard folds the guard's
// other two kinds (memory-suppression / memory-suppressed), it
// never touches this kind, so a dead store - the store that
// holds the owner's do-not-store instructions - could fail
// every touch with nothing counting the class in aggregate.
// Every failure line is by construction a guard touch that did
// not complete its store work, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. This parser is strict: only the two
// phases the store's touches write parse, and a non-empty
// reason is required and consumed, never printed - suppression
// needles are the owner's secret words and never enter the
// writer's line or this fold. A line from any other kind never
// parses. A pure read: it creates nothing, updates nothing,
// and reads no suppression record - the guard seams themselves
// are untouched.
export function parseCaptureGuardFailedSummary(summary: string): { phase: CaptureGuardPhase } | null {
  const m = /^Capture guard store (read|write) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[2] ?? "").trim()) return null;
  return { phase: m[1] as CaptureGuardPhase };
}

export function captureGuardFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "capture-guard-failed" });
  let failed = 0;
  let unparseable = 0;
  let read = 0;
  let write = 0;
  for (const line of lines) {
    const parsed = parseCaptureGuardFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      if (parsed.phase === "read") read += 1;
      else write += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Capture guard failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(write) + " write");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function countExistingMatches(root: string, profile: string, needle: string): number {
  try {
    // Lazy import shape avoided: missions.db is read directly so
    // this module never imports the memory store (no cycle).
    const dbPath = join(resolve(root), ".sam", "missions.db");
    if (!existsSync(dbPath)) return 0;
    const db = openDatabase(dbPath);
    try {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_records'").get();
      if (!has) return 0;
      const scope = profile === "sam" ? "core" : "profile:" + profile;
      const rows = db.prepare("SELECT content FROM memory_records WHERE archived_at IS NULL AND scope = ?").all(scope) as Array<{ content: string }>;
      return rows.filter(r => needleMatches(needle, r.content)).length;
    } finally { db.close(); }
  } catch { return 0; }
}

/** ONE memory-suppressed ledger line for a blocked automatic
 *  write: the seam that dropped it, the profile, the suppression
 *  id and the needle's fingerprint - never the needle, never the
 *  content. Deliberately NOT classified as a defect in
 *  self-work: the guard holding is the system working. */
export function recordSuppressionBlock(root: string, actor: string, via: string, hit: CaptureSuppression): void {
  recordActivity(root, actor, "memory-suppressed",
    suppressionBlockedLedgerSummary(via, actor, hit.id.slice(0, 8), needleFingerprint(hit.needle)));
}

/** Drop suppressed finds from a preference-extraction result
 *  (the two capture seams share this): a preference statement
 *  carrying a suppressed needle is itself a capture of the
 *  suppressed words, so it never reaches the preference store. */
export function filterUnsuppressed<T extends { statement: string }>(root: string, profile: string, found: T[]): T[] {
  if (!found.length) return found;
  const active = activeSuppressions(root, profile);
  if (!active.length) return found;
  return found.filter(f => !active.some(s => needleMatches(s.needle, f.statement)));
}

// Deterministic extraction of do-not-store instructions from the
// owner's own words (the extractPreferences discipline: narrow
// first-person forms only, capped, cleaned). Covered shapes:
// - "keep <X> out of memory" / "keep <X> out of your memory"
// - "do not / don't / never store|remember|record <X> ..."
//   ("save" counts only when the message also names memory)
// - "do not keep <X> in memory"
// - a bare form ("keep it out of memory", "don't store this")
//   in the same message as a named secret ("the secret phrase
//   is <X>", "the launch code is <X>") - the incident's shape.
// NOT covered, by design: a bare "keep it out of memory" with no
// named secret anywhere in the message (there is no object to
// bind; the operator CLI door exists for that), and anything a
// model would have to infer. A theatrical guesser here would
// suppress the wrong things; a narrow extractor plus the CLI
// covers the honest ground.
const BARE_OBJECTS = new Set(["this", "that", "it", "this one", "that one", "this please"]);
function cleanNeedle(raw: string): string {
  let out = raw.replace(/\s+/g, " ").trim();
  out = out.replace(/^["'`]+|["'`]+$/g, "");
  out = out.replace(/[.!?,;:]+$/g, "").trim();
  out = out.replace(/^(?:that|the|a|an)\s+/i, "");
  out = out.replace(/\s+(?:in|into|from|out of)\s+(?:your\s+|my\s+)?memory$/i, "");
  out = out.replace(/\s+anywhere$/i, "").trim();
  if (out.length < 3 || out.length > 200) return "";
  if (BARE_OBJECTS.has(out.toLowerCase())) return "";
  return out;
}
export function extractSuppressions(text: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const clean = cleanNeedle(raw);
    if (clean && !out.some(o => needleKey(o) === needleKey(clean))) out.push(clean);
  };
  const t = text.trim();
  const keepOut = /\bkeep\s+(.{3,160}?)\s+out of\s+(?:your\s+|my\s+)?memory\b/i.exec(t);
  if (keepOut) push(keepOut[1]);
  const keepIn = /\b(?:do not|don't|never)\s+keep\s+(.{3,160}?)\s+in\s+(?:your\s+|my\s+)?memory\b/i.exec(t);
  if (keepIn) push(keepIn[1]);
  const verbs = /\bmemory\b/i.test(t)
    ? /\b(?:do not|don't|never)\s+(?:store|save|remember|record)\s+(.{3,160})/i.exec(t)
    : /\b(?:do not|don't|never)\s+(?:store|remember|record)\s+(.{3,160})/i.exec(t);
  if (verbs) push(verbs[1].split(/[.!?;]/)[0]);
  const bare = /\b(?:keep\s+it\s+out of\s+(?:your\s+)?memory|keep\s+this\s+out of\s+(?:your\s+)?memory|do not store this|don't store this|do not remember this|never store this)\b/i.test(t);
  if (bare) {
    const named = /\b(?:secret phrase|secret code|passphrase|password|launch code|access code)\s+is\s+["']?(.{2,120})/i.exec(t);
    if (named) push(named[1].split(/\s+(?:and\s+)?(?:keep|do not|don't|never)\b/i)[0].split(/[,;.!?]/)[0]);
  }
  return out.slice(0, 3);
}

/** The capture seam both owner-text paths share: extract any
 *  do-not-store instructions from the owner's words and record
 *  them as suppressions for the profile. Returns the newly
 *  created records (deduped repeats return []). Never throws:
 *  the caller is a turn or a tick, and a guard failure must not
 *  break either - a store failure is ledgered once as a
 *  capture-guard-failed line by the store's own touch before
 *  it reaches this catch; here it simply yields []. */
export function captureSuppressionsFromText(root: string, profile: string, text: string, source: string): CaptureSuppression[] {
  const created: CaptureSuppression[] = [];
  for (const needle of extractSuppressions(text)) {
    try {
      const result = addSuppression(root, { profile, needle, source });
      if (result.created) created.push(result.record);
    } catch { /* the guard never breaks the path that feeds it */ }
  }
  return created;
}

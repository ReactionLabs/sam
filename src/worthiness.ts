import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity } from "./activity.js";
import { PreferenceStore } from "./preferences.js";

/**
 * Notification worthiness (Smarter-and-Smoother S5 + parity
 * item 7: "law-seeded notification worthiness checked before
 * any delivery"). Every PROACTIVE delivery - a heartbeat job
 * pushing to a channel today, second-answer updates when that
 * engine lands - passes this gate before it may interrupt the
 * owner. The reply itself always lands in its chat as the
 * record; the gate governs only the interruption leg.
 *
 * The judgment is deterministic and auditable, never a model
 * call: (1) the identical content already delivered inside the
 * cooldown is a duplicate; (2) a profile may push at most a
 * few proactive deliveries an hour; (3) the profile's standing
 * law seeds the taste - a law like "never alert me about X"
 * denies X, and a law like "only notify me about Y" turns the
 * gate into an allowlist. Unparseable law is ignored, never
 * invented. Owner-approved actions (the `say` kind) are exempt
 * by design: the owner's approval IS the worthiness check.
 * Every assessment, delivered or held, appends to
 * .sam/delivery-ledger.jsonl so the owner can audit what SAM
 * chose not to bother them with (sam deliveries list).
 *
 * The gate follows the house ledger contract: an assessment
 * never breaks the delivery it judges, and a ledger failure
 * is never silent. assessDelivery owns its append touch - a
 * failed append ledgers one line and the verdict returns
 * regardless - and readDeliveryLedger owns the read touch:
 * a failed read ledgers one worthiness-failed line and
 * rethrows exactly (fail-closed), carrying the assessment's
 * profile/kind when a caller passes that context and the
 * generic system shape when a direct reader (status counts,
 * the deliveries list) has none, so no surface dies raw and
 * no caller ledgers a second line for the same touch.
 * Without that, a dead ledger threw the verdict away (the
 * heartbeat jobs stage ate it as a generic tick failure
 * with the delivery left pending and undecided, the loop
 * revisit aborted before its state advanced) while the
 * gate's duplicate/rate memory - and the status counts that
 * fold the same ledger - kept reading the frozen file as
 * truth with no trace anywhere.
 */

export interface DeliveryAssessment { deliver: boolean; reason: string }
export interface DeliveryLedgerEntry { at: string; profile: string; kind: string; deliver: boolean; reason: string; fingerprint: string; preview: string }

const COOLDOWN_MS = 6 * 3_600_000;
const RATE_WINDOW_MS = 3_600_000;
const RATE_MAX = 3;

export function deliveryFingerprint(text: string): string {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

function ledgerPath(root: string): string {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "delivery-ledger.jsonl");
}

export function readDeliveryLedger(root: string, limit = 50, ctx?: { profile: string; kind: string }): DeliveryLedgerEntry[] {
  // The read seam follows the house contract fail-closed (gap
  // found 2026-11-14): this ledger is the gate's only memory
  // and the status delivered/suppressed counts fold it as
  // truth, so a dead read folded to [] reads as a gate that
  // has never held or sent anything, while a raw throw killed
  // the whole status payload / the CLI list with no trace.
  // So a failed filesystem touch ledgers ONE
  // worthiness-failed read line and rethrows exactly. The
  // line's shape follows the caller's context: assessDelivery
  // passes its profile/kind and its line keeps the assessed
  // shape (the 2026-11-13 contract, byte-unchanged); a direct
  // reader has no assessment, so its line is the generic
  // system shape (actor sam, the usage / skill-use read
  // precedent). The error is tagged so a catching caller
  // (assessDelivery) can tell a read failure - already
  // ledgered here, under the seam that actually died - and
  // never records it twice (the session-caps tagging
  // precedent). An absent ledger still reads [] (a fresh
  // install has genuinely assessed nothing) and per-line
  // torn parsing stays forgiving; only the filesystem touch
  // is guarded.
  let raw: string | null;
  try {
    const path = ledgerPath(root);
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    if (ctx) recordWorthinessFailure(root, "read", ctx.profile, ctx.kind, null, error);
    else recordWorthinessReadFailure(root, error);
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      (error as { worthinessReadLedgered?: boolean }).worthinessReadLedgered = true;
    }
    throw error;
  }
  if (raw === null) return [];
  const out: DeliveryLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as DeliveryLedgerEntry); } catch { /* a torn line is skipped, never fatal */ }
  }
  return out.slice(-limit);
}

const RULE_STOPWORDS = new Set(["me", "about", "for", "on", "the", "a", "an", "and", "or", "to", "of", "in", "is", "it", "my", "i"]);

function ruleTerms(tail: string): string[] {
  const terms: string[] = [];
  for (const raw of tail.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || RULE_STOPWORDS.has(raw)) continue;
    terms.push(raw);
    if (terms.length >= 6) break;
  }
  return terms;
}

export interface NotificationRules { denyTerms: string[]; onlyTerms: string[] | null }

export function notificationRules(root: string, profile: string): NotificationRules {
  const denyTerms: string[] = [];
  let onlyTerms: string[] | null = null;
  const prefs = new PreferenceStore(root);
  try {
    for (const law of prefs.lawsFor(profile)) {
      const s = (law.statement ?? "").toLowerCase();
      if (!/(notif|alert|ping|interrupt|bother)/.test(s)) continue;
      const never = s.match(/(?:never|do not|don't)[^.]*?(?:about|for|on)\s+(.+)$/);
      if (never) { denyTerms.push(...ruleTerms(never[1])); continue; }
      const only = s.match(/only[^.]*?(?:about|for|on)\s+(.+)$/);
      if (only) onlyTerms = ruleTerms(only[1]);
    }
  } finally { prefs.close(); }
  return { denyTerms, onlyTerms };
}

// One ledger line per failed worthiness-ledger touch (gap
// found 2026-11-13): the phase (read / append), the profile
// and kind, the verdict on an append failure, and the
// verbatim reason (collapsed, capped) - never the message
// text; its fingerprint is a hash, not content.
export function worthinessFailureSummary(phase: "read" | "append", profile: string, kind: string, verdict: DeliveryAssessment | null, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Worthiness " + phase + " failed for profile " + profile + " (" + kind + (verdict ? ", verdict " + (verdict.deliver ? "deliver" : "held") : "") + "): " + clean).slice(0, 200);
}

export function recordWorthinessFailure(root: string, phase: "read" | "append", profile: string, kind: string, verdict: DeliveryAssessment | null, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, profile, "worthiness-failed", worthinessFailureSummary(phase, profile, kind, verdict, reason));
}

// One ledger line per failed worthiness READ on a direct
// surface (gap found 2026-11-14): status and the CLI list
// read the ledger with no assessment in hand, so their line
// carries no profile/kind - the reader is the system, actor
// sam, and the summary keeps the "Worthiness read failed"
// prefix classifyDefect keys the phase off. Never any ledger
// content; previews in the ledger are message text.
export function worthinessReadFailureSummary(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Worthiness read failed: " + clean).slice(0, 200);
}

export function recordWorthinessReadFailure(root: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "worthiness-failed", worthinessReadFailureSummary(reason));
}

export function assessDelivery(root: string, input: { profile: string; kind: string; text: string; now?: Date }): DeliveryAssessment {
  const now = input.now ?? new Date();
  const fingerprint = deliveryFingerprint(input.text);
  let recent: DeliveryLedgerEntry[] = [];
  // The reader ledgers its own failed touch (with this
  // assessment's profile/kind, passed as context) and tags
  // the error; the catch records nothing more - one touch,
  // one line - and the assessment proceeds on law rules
  // alone exactly as before.
  try { recent = readDeliveryLedger(root, 500, { profile: input.profile, kind: input.kind }); } catch { /* already ledgered by the reader under the seam that died */ }
  const within = (e: DeliveryLedgerEntry, ms: number) => now.getTime() - Date.parse(e.at) < ms;
  let verdict: DeliveryAssessment;
  if (recent.some(e => e.deliver && e.profile === input.profile && e.kind === input.kind && e.fingerprint === fingerprint && within(e, COOLDOWN_MS))) {
    verdict = { deliver: false, reason: "duplicate of a delivery in the last 6h" };
  } else if (recent.filter(e => e.deliver && e.profile === input.profile && within(e, RATE_WINDOW_MS)).length >= RATE_MAX) {
    verdict = { deliver: false, reason: "rate: more than " + RATE_MAX + " proactive deliveries this hour" };
  } else {
    let rules: NotificationRules = { denyTerms: [], onlyTerms: null };
    try { rules = notificationRules(root, input.profile); } catch { /* law reading never blocks or forces a delivery */ }
    const hay = input.text.toLowerCase();
    const denyHit = rules.denyTerms.find(t => hay.includes(t));
    if (denyHit) verdict = { deliver: false, reason: "law: never alert about " + denyHit };
    else if (rules.onlyTerms && !rules.onlyTerms.some(t => hay.includes(t))) verdict = { deliver: false, reason: "law: outside the only-alert-about list" };
    else verdict = { deliver: true, reason: "worthy" };
  }
  const entry: DeliveryLedgerEntry = { at: now.toISOString(), profile: input.profile, kind: input.kind, deliver: verdict.deliver, reason: verdict.reason, fingerprint, preview: input.text.replace(/\s+/g, " ").trim().slice(0, 160) };
  try { appendFileSync(ledgerPath(root), JSON.stringify(entry) + "\n", { mode: 0o600 }); } catch (error) { recordWorthinessFailure(root, "append", input.profile, input.kind, verdict, error); }
  return verdict;
}

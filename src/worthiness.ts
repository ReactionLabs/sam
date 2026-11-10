import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
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

export function readDeliveryLedger(root: string, limit = 50): DeliveryLedgerEntry[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  const out: DeliveryLedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
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

export function assessDelivery(root: string, input: { profile: string; kind: string; text: string; now?: Date }): DeliveryAssessment {
  const now = input.now ?? new Date();
  const fingerprint = deliveryFingerprint(input.text);
  const recent = readDeliveryLedger(root, 500);
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
  appendFileSync(ledgerPath(root), JSON.stringify(entry) + "\n", { mode: 0o600 });
  return verdict;
}

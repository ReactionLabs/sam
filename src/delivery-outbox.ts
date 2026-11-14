import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity } from "./activity.js";

// Durable delivery outbox (Phase C item 1): the delivery ledger the
// plan asks for. Before this, a changed heartbeat reply with a
// channel was delivered inline inside the tick - if the process
// died between the reply and the send, the delivery was simply
// gone; heartbeats.jsonl is an audit log, not a queue, and the S5
// worthiness ledger records assessments, not delivery state.
//
// The outbox is an append-only event log (.sam/delivery-outbox.jsonl)
// folded to the latest state per delivery: queued BEFORE any send
// is attempted, then delivered / attempt-failed / suppressed events
// as the tick works it. A delivery still pending when a later tick
// starts is redelivered and its delivered event is marked
// recovered:true - at-least-once, with crash redeliveries visible
// as recovered instead of looking like fresh news. Suppression by
// the worthiness gate is a terminal state recorded here too, so
// one ledger answers "did SAM tell me, and if not, why not".

export interface DeliveryRecord {
  id: string; jobId: string; jobName: string; profile: string;
  channelId: string; text: string; queuedAt: string;
  status: "pending" | "delivered" | "suppressed" | "failed";
  attempts: number; recovered: boolean; deliveredAt: string | null;
  reason: string | null;
}
type OutboxEvent =
  | { type: "queued"; at: string; record: DeliveryRecord }
  | { type: "delivered" | "attempt-failed" | "suppressed" | "failed"; at: string; id: string; reason?: string; recovered?: boolean };

const MAX_ATTEMPTS = 5;

function outboxPath(root: string): string { return join(resolve(root), ".sam", "delivery-outbox.jsonl"); }

function append(root: string, event: OutboxEvent): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  appendFileSync(outboxPath(root), JSON.stringify(event) + "\n", { mode: 0o600 });
}

// Outbox ledger failure visibility (gap found 2026-11-13, hourly
// run 20:04): both touches of this ledger were unguarded, so a
// dead append threw out of whichever caller held it - a queue
// failure lost a changed reply's only durable record, a
// markDelivered failure threw inside the send's own try and
// reclassified a delivery that HAD happened as a failed attempt,
// a markAttemptFailed failure threw out of the failure handler
// itself - and a dead read threw raw out of the heartbeat legs,
// status, and the CLI, when folding it to [] would have read as
// "no deliveries owed" while owed updates sat unredelivered.
// The house contract, split by what each append records: the
// READ fails closed (one line, then the rethrow - the
// session-caps / usage precedent) and the QUEUE append fails
// closed with it (the goldfish precedent: the append IS the
// record, an unrecorded queue is a delivery owed that nobody
// can prove was owed), while the TRANSITION appends (delivered
// / attempt-failed / suppressed) never throw and never
// reclassify the send, attempt, or hold that already happened
// (the verification / code-writes precedent) - they ledger one
// line and report whether the record landed. Summaries carry
// the verbatim reason collapsed and capped, never the delivery
// text.
export function outboxFailureSummary(phase: "append" | "read", label: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Delivery outbox " + phase + " failed for " + label + ": " + clean).slice(0, 200);
}

export function recordOutboxFailure(root: string, actor: string, phase: "append" | "read", label: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, actor, "outbox-failed", outboxFailureSummary(phase, label, reason));
}

// A transition append: never throws, ledgers one line on
// failure, returns whether the event landed.
function appendTransition(root: string, event: OutboxEvent, actor: string, label: string): boolean {
  try {
    append(root, event);
    return true;
  } catch (error) {
    recordOutboxFailure(root, actor, "append", label, error);
    return false;
  }
}

// The queue append: ledgers one line on failure, then rethrows
// exactly - no record, no delivery silently owed.
function appendQueue(root: string, event: OutboxEvent, actor: string, label: string): void {
  try {
    append(root, event);
  } catch (error) {
    recordOutboxFailure(root, actor, "append", label, error);
    throw error;
  }
}

export function readDeliveries(root: string): DeliveryRecord[] {
  const path = outboxPath(root);
  // The read seam fails closed (gap above): a dead read ledgers
  // ONE outbox-failed line (actor sam, the reader is the system)
  // and rethrows exactly, so pendingDeliveries, deliverySummary,
  // and the CLI surface the error instead of a false "nothing
  // owed". An absent ledger still reads [] - a fresh install
  // genuinely owes nothing - and per-line torn parsing stays
  // forgiving; only the filesystem touch is guarded.
  let raw: string | null;
  try {
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    recordOutboxFailure(root, "sam", "read", "ledger", error);
    throw error;
  }
  if (raw === null) return [];
  const byId = new Map<string, DeliveryRecord>();
  const order: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: OutboxEvent;
    try { event = JSON.parse(line) as OutboxEvent; } catch { continue; }
    if (event.type === "queued") {
      if (!byId.has(event.record.id)) order.push(event.record.id);
      byId.set(event.record.id, { ...event.record });
      continue;
    }
    const rec = byId.get(event.id);
    if (!rec) continue;
    if (event.type === "delivered") { rec.status = "delivered"; rec.deliveredAt = event.at; rec.attempts += 1; rec.recovered = !!event.recovered || rec.recovered; rec.reason = null; }
    else if (event.type === "attempt-failed") { rec.attempts += 1; rec.reason = event.reason ?? "delivery failed"; if (rec.attempts >= MAX_ATTEMPTS) rec.status = "failed"; }
    else if (event.type === "suppressed") { rec.status = "suppressed"; rec.reason = event.reason ?? "held by the worthiness gate"; }
    else if (event.type === "failed") { rec.status = "failed"; rec.reason = event.reason ?? "delivery failed"; }
  }
  return order.map(id => byId.get(id) as DeliveryRecord);
}

export function queueDelivery(root: string, input: { jobId: string; jobName: string; profile: string; channelId: string; text: string }): DeliveryRecord {
  const record: DeliveryRecord = {
    id: randomUUID(), jobId: input.jobId, jobName: input.jobName, profile: input.profile,
    channelId: input.channelId, text: input.text, queuedAt: new Date().toISOString(),
    status: "pending", attempts: 0, recovered: false, deliveredAt: null, reason: null,
  };
  appendQueue(root, { type: "queued", at: record.queuedAt, record }, input.profile, "queued delivery for heartbeat '" + input.jobName + "'");
  return record;
}

export function markDelivered(root: string, id: string, recovered: boolean): boolean {
  // The send already happened: a dead append must never throw
  // back into the send's try and reclassify it as a failed
  // attempt. The record stays pending (at-least-once redelivery
  // is the outbox's own design) and the failure line names the
  // true seam, so the duplicate-delivery risk is countable.
  return appendTransition(root, { type: "delivered", at: new Date().toISOString(), id, recovered }, "sam", "delivered event for delivery " + id.slice(0, 8));
}
export function markAttemptFailed(root: string, id: string, reason: string): { attempts: number; settled: boolean } {
  // The fold settles a record when its attempts reach the cap, so
  // the caller needs to know whether THIS attempt was the terminal
  // one: before this return, a delivery that gave up after 5
  // attempts was announced nowhere - the record simply stopped
  // being pending (gap found 2026-11-13, hourly run 06:04). The
  // count comes from the pre-append fold, exactly the state the
  // appended event will produce.
  // The pre-append fold rides the guarded read: a dead read
  // stands on its own outbox-failed:read line (the read seam
  // already ledgered it) and the count reads as unknown (0) -
  // never a second, mislabeled line for the same touch. The
  // append itself is a transition: the failed attempt already
  // happened, so a dead append ledgers once and never throws
  // out of the caller's failure handler.
  let before: DeliveryRecord | undefined;
  try { before = readDeliveries(root).find(d => d.id === id); } catch { before = undefined; }
  const attempts = before ? before.attempts + 1 : 0;
  const settled = !!before && before.status === "pending" && attempts >= MAX_ATTEMPTS;
  appendTransition(root, { type: "attempt-failed", at: new Date().toISOString(), id, reason: String(reason).slice(0, 200) },
    before ? before.profile : "sam",
    before ? "attempt-failed event for heartbeat '" + before.jobName + "'" : "attempt-failed event for delivery " + id.slice(0, 8));
  return { attempts, settled };
}
export function markSuppressed(root: string, id: string, reason: string): boolean {
  // The worthiness hold already happened and is ledgered by the
  // caller: a dead append never throws it away - it ledgers one
  // line and the record stays pending, visibly, instead of the
  // hold vanishing with the throw.
  return appendTransition(root, { type: "suppressed", at: new Date().toISOString(), id, reason }, "sam", "suppressed event for delivery " + id.slice(0, 8));
}
export function pendingDeliveries(root: string): DeliveryRecord[] {
  return readDeliveries(root).filter(d => d.status === "pending");
}
export function deliverySummary(root: string): { pending: number; delivered: number; suppressed: number; failed: number; recovered: number } {
  const all = readDeliveries(root);
  return {
    pending: all.filter(d => d.status === "pending").length,
    delivered: all.filter(d => d.status === "delivered").length,
    suppressed: all.filter(d => d.status === "suppressed").length,
    failed: all.filter(d => d.status === "failed").length,
    recovered: all.filter(d => d.deliveredAt && d.recovered).length,
  };
}

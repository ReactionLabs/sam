import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

export function readDeliveries(root: string): DeliveryRecord[] {
  const path = outboxPath(root);
  if (!existsSync(path)) return [];
  const byId = new Map<string, DeliveryRecord>();
  const order: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
  append(root, { type: "queued", at: record.queuedAt, record });
  return record;
}

export function markDelivered(root: string, id: string, recovered: boolean): void {
  append(root, { type: "delivered", at: new Date().toISOString(), id, recovered });
}
export function markAttemptFailed(root: string, id: string, reason: string): { attempts: number; settled: boolean } {
  // The fold settles a record when its attempts reach the cap, so
  // the caller needs to know whether THIS attempt was the terminal
  // one: before this return, a delivery that gave up after 5
  // attempts was announced nowhere - the record simply stopped
  // being pending (gap found 2026-11-13, hourly run 06:04). The
  // count comes from the pre-append fold, exactly the state the
  // appended event will produce.
  const before = readDeliveries(root).find(d => d.id === id);
  const attempts = before ? before.attempts + 1 : 0;
  const settled = !!before && before.status === "pending" && attempts >= MAX_ATTEMPTS;
  append(root, { type: "attempt-failed", at: new Date().toISOString(), id, reason: String(reason).slice(0, 200) });
  return { attempts, settled };
}
export function markSuppressed(root: string, id: string, reason: string): void {
  append(root, { type: "suppressed", at: new Date().toISOString(), id, reason });
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

// Live chat channel (Sprint 4 item 1). The dashboard page used to
// poll the thread every two seconds, and only while it believed a
// turn was running. That poll compared message ids, so a reply that
// finished on the same row never reached the open chat until a
// manual refresh. The server now keeps one Server-Sent Events
// stream per open chat and writes the thread payload only when
// this signature changes. A comment heartbeat keeps the connection
// from looking dead without shipping the thread on a timer. The
// phone holds one idle connection; it does not poll.

export const CHAT_LIVE_POLL_MS = 400;
export const CHAT_LIVE_HEARTBEAT_MS = 15000;
export const CHAT_LIVE_RETRY_MS = 4000;

export interface LiveThreadSnapshot {
  messages?: unknown;
  events?: unknown;
  actions?: unknown;
  artifacts?: unknown;
  citations?: unknown;
  sources?: unknown;
  queue?: unknown;
  turnActive?: unknown;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}
function cell(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === undefined || value === null ? "" : String(value);
}
function keys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

/** Stable identity of everything the open thread renders. Content
 *  and partial flags are included so a reply that keeps its message
 *  id still counts as a change. Queue status is included so queued
 *  and steered update on their own. */
export function chatThreadSignature(snapshot: LiveThreadSnapshot): string {
  return JSON.stringify({
    messages: rows(snapshot.messages).map(m => [cell(m, "id"), cell(m, "role"), cell(m, "partial"), cell(m, "reaction"), cell(m, "content")]),
    queue: rows(snapshot.queue).map(q => [cell(q, "id"), cell(q, "status")]),
    turnActive: snapshot.turnActive ? 1 : 0,
    events: rows(snapshot.events).map(e => [cell(e, "id"), cell(e, "content")]),
    actions: rows(snapshot.actions).map(a => [cell(a, "id"), cell(a, "status"), cell(a, "result")]),
    artifacts: rows(snapshot.artifacts).map(a => [cell(a, "id"), cell(a, "version"), cell(a, "updatedAt")]),
    citations: keys(snapshot.citations),
    sources: keys(snapshot.sources),
  });
}

/** One SSE message event. JSON.stringify escapes newlines, so the
 *  event stays a single data line. */
export function sseThreadEvent(snapshot: unknown): string {
  return "data: " + JSON.stringify(snapshot) + "\n\n";
}

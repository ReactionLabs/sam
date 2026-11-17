// The one cause-carrying failure reason, in a leaf module.
// It lived in telegram.ts (the 2026-11-16 04:04 bridge seam)
// and every failure helper composed through it from there -
// until the activity ledger itself needed it (gap found
// 2026-11-17, hourly run 10:04 EST): telegram.ts imports
// recordActivity from activity.ts, so activity.ts could not
// import the reason back without a cycle. The function now
// lives here, in a module that imports nothing, and
// telegram.ts re-exports it so every existing import from
// telegram.js keeps working byte-for-byte.
//
// The reason a failure line carries: Node's fetch wraps
// every transport failure in the same TypeError "fetch
// failed" - DNS, connect refused or timed out, socket
// reset, and TLS are indistinguishable in the message
// alone, and the live ledger held 61 bridge-poll-failed
// lines of which 60 said exactly those three words, so the
// bridge's top defect class was countable but never
// diagnosable. The real reason rides error.cause, so the
// reason walks the cause chain (bounded, deduped) and
// appends each cause's message plus its errno-style code
// when it carries one. The bot token never enters a line:
// the Telegram API URL carries it in its path
// (bot<token>/method), so any bot-token segment or
// token-shaped credential in a message is redacted before
// the line is composed. Whitespace collapses and callers
// cap their composed summaries, the house failure-summary
// shape.
export function errorReason(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown })?.code;
    const part = typeof code === "string" && code && !message.includes(code) ? message + " (" + code + ")" : message;
    if (part && !parts.includes(part)) parts.push(part);
    current = (current as { cause?: unknown })?.cause;
  }
  return parts.join(": ").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>").replace(/\s+/g, " ").trim() || "unknown error";
}

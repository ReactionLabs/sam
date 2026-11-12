// Message provenance. Every client stamps the surface that sent an
// owner message: dashboard, rust-cli, ts-cli, telegram, or api. The
// stamp is stored on the chat message, handed to the model as a
// provenance line (not as words the owner typed), and drawn as a
// small label in the dashboard and the TS CLI. Legacy rows and
// turns that are not a client (heartbeat, background, a door) are
// unknown.

export const MESSAGE_SOURCES = ["dashboard", "rust-cli", "ts-cli", "telegram", "api"] as const;
export type MessageSource = typeof MESSAGE_SOURCES[number];
export type StoredMessageSource = MessageSource | "unknown";

export function normalizeMessageSource(value: unknown): StoredMessageSource {
  return typeof value === "string" && (MESSAGE_SOURCES as readonly string[]).includes(value) ? value as MessageSource : "unknown";
}

// The dashboard messages route is the API. A named client sends its
// own source. An omitted field is the generic API client. A value
// outside the set is unknown and is never copied into the prompt.
export function sourceFromApiBody(value: unknown): StoredMessageSource {
  if (value === undefined) return "api";
  return normalizeMessageSource(value);
}

export function withMessageProvenance(content: string, source: unknown): string {
  const normalized = normalizeMessageSource(source);
  if (normalized === "unknown") return content;
  return "[metadata source=" + normalized + "]\n" + content;
}

// Dim transcript mark. Empty for unknown so legacy rows stay quiet.
export function cliSourceMark(source: unknown): string {
  const normalized = normalizeMessageSource(source);
  return normalized === "unknown" ? "" : "· " + normalized;
}

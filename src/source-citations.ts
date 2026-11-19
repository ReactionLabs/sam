import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

/**
 * Perplexity-style source citations for factual answers (Dip ruling
 * 2026-11-14, standing behavior; the general sibling of the #92
 * chat-history citations in chat-citations.ts).
 *
 * When a reply states facts, each fact grounded in this session
 * carries an inline numbered citation, [n], and the reply ends with
 * a Sources list naming what each number is: the file path read,
 * the command run, the web page fetched, the connector tool read.
 *
 * The honesty rules are the feature, and they are enforced here,
 * not left to the model's good behavior:
 * - The ONLY citable sources are the source-bearing tool results
 *   this reply's own run actually produced. Dispatch records them
 *   in the run registry below (keyed by the turn's chat + user
 *   message, consumed exactly once by the turn pass), and each
 *   registered result is annotated as the model sees it with its
 *   number - so the model can only ever cite numbers it was shown.
 * - The Sources list the owner reads is generated HERE from the
 *   registry entries the reply actually cited, with the registry's
 *   canonical descriptors, and appended to the reply text before
 *   it is saved - so every surface (dashboard, Telegram, CLI, API)
 *   shows the same single list, and it can never name a source the
 *   run did not touch. A Sources list the model wrote itself is
 *   stripped and replaced by the canonical one; a model list with
 *   no valid citations behind it disappears entirely (padding is
 *   fabrication with better formatting).
 * - A citation number outside the run's registry is a fabrication
 *   shape: the token is stripped from the visible reply and one
 *   source-citation-rejected line is ledgered. [0] and bracketed
 *   numbers of 4+ digits are never citations (index syntax, years)
 *   and pass through untouched.
 * - A claim with no session source gets no citation and no list:
 *   the doctrine (identity.ts) has SAM say plainly that it is from
 *   memory. The runtime never guesses which source a claim came
 *   from - an uncited factual reply is a doctrine miss, not
 *   something to dress up after the fact.
 *
 * Chat-history hits are NOT this registry: they stay with the #92
 * cite-marker system, which resolves to a clickable link. This
 * registry covers files, skills, commands, web results, connector
 * reads, memory records, and the senses/brief docs.
 *
 * Citation plumbing never breaks a turn: failures on the record /
 * attach path ledger one source-citation-failed line and the turn
 * carries on without them.
 */

export const SOURCE_GUIDANCE =
  "Cite facts you take from this result inline in your reply with its source number, like [1], and list every number you cited under a plain 'Sources:' line at the end of your reply. Only cite numbers a result actually showed you in this session - never invent a number or list a source you did not use. A fact with no session source behind it is stated plainly as from memory, never dressed up with a citation.";

export type SourceKind = "file" | "skill" | "command" | "web" | "connector" | "memory" | "doc";

export interface SourceDescriptor {
  kind: SourceKind;
  descriptor: string;
}

export interface RunSource extends SourceDescriptor {
  n: number;
}

const DESCRIPTOR_CAP = 180;

function capDescriptor(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > DESCRIPTOR_CAP ? clean.slice(0, DESCRIPTOR_CAP - 1) + "…" : clean;
}

// ----------------------------------------------------------------
// Which tool results are sources, and what they are called.
// Pure and exported for tests: given the tool name, its arguments,
// and its result, the source descriptors the result grounds - an
// empty list when the call read nothing citable (an action, a
// proposal, a refusal, an error, a stub). One call can ground
// several sources (a memory list grounds each record it returned).
// ----------------------------------------------------------------

function isErrorResult(result: unknown): boolean {
  return !!result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string";
}

function asRecord(result: unknown): Record<string, unknown> | null {
  return !!result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
}

export function describeToolSources(name: string, args: Record<string, unknown>, result: unknown): SourceDescriptor[] {
  if (isErrorResult(result)) return [];
  const rec = asRecord(result);
  const argStr = (key: string): string => typeof args[key] === "string" ? String(args[key]) : "";
  switch (name) {
    case "sam_workspace_read": {
      const path = rec && typeof rec.path === "string" ? rec.path : argStr("path");
      return path ? [{ kind: "file", descriptor: capDescriptor(path) }] : [];
    }
    case "sam_code": {
      const action = argStr("action");
      if (action === "read") {
        const path = rec && typeof rec.path === "string" ? rec.path : argStr("path");
        return path ? [{ kind: "file", descriptor: capDescriptor(path) }] : [];
      }
      if (action === "run") {
        const command = argStr("command");
        if (!command) return [];
        const detail = command === "git-clone" && argStr("url") ? "git-clone " + argStr("url") : command;
        return [{ kind: "command", descriptor: capDescriptor("command: " + detail) }];
      }
      if (action === "python") {
        const path = argStr("path");
        return path ? [{ kind: "command", descriptor: capDescriptor("command: python " + path) }] : [];
      }
      return [];
    }
    case "sam_read_skill": {
      const skill = rec && typeof rec.name === "string" ? rec.name : argStr("name");
      return skill ? [{ kind: "skill", descriptor: capDescriptor("skill: " + skill) }] : [];
    }
    case "sam_reach": {
      if (!rec || rec.ok !== true) return [];
      const channel = typeof rec.channel === "string" ? rec.channel : argStr("channel");
      const action = typeof rec.action === "string" ? rec.action : argStr("action");
      const query = argStr("query");
      if (/^https?:\/\//i.test(query)) {
        const items = Array.isArray(rec.items) ? rec.items : [];
        const first = items.length ? asRecord(items[0]) : null;
        const title = first && typeof first.title === "string" ? first.title : "";
        return [{ kind: "web", descriptor: capDescriptor(title ? query + " - " + title : query) }];
      }
      return [{ kind: "web", descriptor: capDescriptor("agent-reach " + channel + " " + action + (query ? ": " + query : "")) }];
    }
    case "sam_search_skills": {
      if (!rec || !Array.isArray(rec.results)) return [];
      return [{ kind: "web", descriptor: capDescriptor("skills.sh search: " + argStr("query")) }];
    }
    case "sam_memory_search":
    case "sam_memory_list": {
      if (!rec || !Array.isArray(rec.records)) return [];
      const out: SourceDescriptor[] = [];
      for (const raw of rec.records) {
        const record = asRecord(raw);
        if (!record || typeof record.id !== "string") continue;
        const kind = typeof record.kind === "string" ? record.kind : "note";
        out.push({ kind: "memory", descriptor: capDescriptor("memory: " + kind + " record " + record.id.slice(0, 8)) });
      }
      return out;
    }
    case "sam_senses": {
      if (!rec || rec.ok !== true) return [];
      const action = argStr("action");
      if (action === "mail") {
        const query = argStr("query");
        return [{ kind: "doc", descriptor: capDescriptor("Gmail (senses): " + (query ? "search " + query : "inbox, last 7 days")) }];
      }
      if (action === "agenda") {
        const days = typeof args.days === "number" && Number.isFinite(args.days) ? Math.floor(args.days) : 1;
        return [{ kind: "doc", descriptor: capDescriptor("Calendar (senses): next " + days + (days === 1 ? " day" : " days")) }];
      }
      return [];
    }
    case "sam_brief": {
      if (!rec || typeof rec.text !== "string") return [];
      return [{ kind: "doc", descriptor: "morning brief (sam_brief)" }];
    }
    case "sam_address_book": {
      // The Address Book (2026-11-16): a recall (show) grounds the
      // person's entry, a list grounds the index - the reply cites
      // the people file it actually read. A save is an action and
      // grounds nothing, exactly like every other write.
      const action = argStr("action");
      if (action === "show" && rec && rec.found === true) {
        const display = typeof rec.display === "string" ? rec.display : argStr("name");
        const slug = typeof rec.slug === "string" ? rec.slug : "";
        if (!display) return [];
        return [{ kind: "doc", descriptor: capDescriptor("Address Book entry: " + display + (slug ? " (.sam/address-book/" + slug + ".md)" : "")) }];
      }
      if (action === "list") {
        return [{ kind: "doc", descriptor: "Address Book index (.sam/address-book/INDEX.md)" }];
      }
      return [];
    }
    default:
      return [];
  }
}

// ----------------------------------------------------------------
// Run registry: the sources one reply's run actually produced.
// In-process on purpose, the #92 shape - a citation can only ever
// point at a result from the run still being answered, so nothing
// here survives a restart or is readable by another process. The
// same source read twice in one run keeps its first number.
// ----------------------------------------------------------------

const runSources = new Map<string, RunSource[]>();
const RUN_SOURCES_KEY_CAP = 100;
const RUN_SOURCES_PER_KEY_CAP = 120;

function runKey(chatId: string, userMessageId: string): string {
  return chatId + "|" + userMessageId;
}

export function recordRunSource(chatId: string, userMessageId: string, source: SourceDescriptor): number {
  const key = runKey(chatId, userMessageId);
  const existing = runSources.get(key) ?? [];
  const found = existing.find(s => s.kind === source.kind && s.descriptor === source.descriptor);
  if (found) return found.n;
  const entry: RunSource = { n: existing.length + 1, kind: source.kind, descriptor: source.descriptor };
  existing.push(entry);
  runSources.set(key, existing.slice(-RUN_SOURCES_PER_KEY_CAP));
  while (runSources.size > RUN_SOURCES_KEY_CAP) {
    const oldest = runSources.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    runSources.delete(oldest);
  }
  return entry.n;
}

export function consumeRunSources(chatId: string, userMessageId: string): RunSource[] {
  const key = runKey(chatId, userMessageId);
  const sources = runSources.get(key) ?? [];
  runSources.delete(key);
  return sources;
}

export function peekRunSources(chatId: string, userMessageId: string): RunSource[] {
  return [...(runSources.get(runKey(chatId, userMessageId)) ?? [])];
}

// ----------------------------------------------------------------
// Annotation: the result as the model sees it, carrying the source
// number(s) it may cite. Object results gain citeSources (the
// "[Source n: descriptor]" lines) and citeGuidance; string results
// (command output) gain the lines as a header. No live turn key,
// no citable descriptors, or an already-annotated result passes
// through unchanged - annotation is idempotent, so a result that
// crosses two dispatch wrappers is numbered exactly once.
// ----------------------------------------------------------------

/** The reason a source-citation-failed line carries
 * (census sprint 2026-11-17): sourceCitationFailureSummary
 * took error.message alone, discarding error.cause. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no source content ever enters the line. */
export function sourceCitationFailureReason(error: unknown): string {
  return errorReason(error);
}

export function sourceCitationFailureSummary(phase: string, error: unknown): string {
  const reason = sourceCitationFailureReason(error).replace(/\s+/g, " ").slice(0, 160);
  return "Source citation " + phase + " failed: " + reason;
}

function recordSourceFailure(root: string, actor: string, phase: string, error: unknown): void {
  try { recordActivity(root, actor, "source-citation-failed", sourceCitationFailureSummary(phase, error)); } catch { /* the ledger never breaks a turn */ }
}

export function annotateToolResult(root: string, input: {
  chatId?: string; userMessageId?: string; actor: string;
  name: string; args: Record<string, unknown>; result: unknown;
  descriptors?: SourceDescriptor[];
}): unknown {
  const { chatId, userMessageId, result } = input;
  if (!chatId || !userMessageId) return result;
  if (result && typeof result === "object" && "citeSources" in (result as Record<string, unknown>)) return result;
  if (typeof result === "string" && result.startsWith("[Source ")) return result;
  let descriptors = input.descriptors;
  if (!descriptors) {
    try { descriptors = describeToolSources(input.name, input.args, result); } catch { descriptors = []; }
  }
  if (!descriptors.length) return result;
  // Only shapes the model reads as one result can carry the
  // annotation visibly: a string (header lines) or a plain object
  // (citeSources fields). Anything else passes through unregistered
  // - a source the model never saw numbered is never citable.
  if (typeof result !== "string" && !asRecord(result)) return result;
  try {
    const lines = descriptors.map(d => {
      const n = recordRunSource(chatId, userMessageId, d);
      return "[Source " + n + ": " + d.descriptor + "]";
    });
    if (typeof result === "string") return lines.join("\n") + "\n" + result;
    return { ...(result as Record<string, unknown>), citeSources: lines, citeGuidance: SOURCE_GUIDANCE };
  } catch (error) {
    recordSourceFailure(root, input.actor, "annotate", error);
    return result;
  }
}

// ----------------------------------------------------------------
// The turn's source pass over a finished reply: consume the run's
// registered sources, strip a Sources list the model wrote itself,
// validate the inline [n] citations against the registry, strip
// fabricated numbers (ledgered once), and append the canonical
// Sources list built from the registry entries actually cited.
// ----------------------------------------------------------------

const SOURCES_HEADER = /^\s{0,3}(?:\*\*|__)?sources:?\s*(?:\*\*|__)?\s*$/i;
const SOURCES_LIST_LINE = /^\s*(?:[-*•]|\[?\d{1,3}\]?[.)]?)\s+\S/;

export function stripModelSourcesList(text: string): { text: string; stripped: boolean } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!SOURCES_HEADER.test(lines[i])) continue;
    const tail = lines.slice(i + 1);
    const content = tail.filter(l => l.trim().length > 0);
    if (!content.length) return { text, stripped: false };
    if (!content.every(l => SOURCES_LIST_LINE.test(l))) return { text, stripped: false };
    return { text: lines.slice(0, i).join("\n").replace(/\s+$/, ""), stripped: true };
  }
  return { text, stripped: false };
}

export interface ProcessedSources {
  text: string;
  sources: RunSource[];
  registered: RunSource[];
  rejectedCount: number;
}

export function processReplySources(root: string, input: { chatId: string; userMessageId: string | null; actor: string; text: string }): ProcessedSources {
  const registered = input.userMessageId ? consumeRunSources(input.chatId, input.userMessageId) : [];
  const valid = new Set(registered.map(s => s.n));
  let { text } = stripModelSourcesList(input.text);
  const cited = new Set<number>();
  let rejectedCount = 0;
  text = text.replace(/\[(\d{1,3})\]/g, (match, num: string) => {
    const n = Number.parseInt(num, 10);
    if (n >= 1 && valid.has(n)) { cited.add(n); return match; }
    if (n >= 1) { rejectedCount++; return ""; }
    return match;
  });
  if (rejectedCount) {
    // A stripped token leaves doubled spaces and orphaned gaps
    // before punctuation; tidy only because something was removed.
    text = text.split("\n").map(l => l.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1")).join("\n");
    recordActivity(root, input.actor, "source-citation-rejected",
      "Source citation rejected in chat " + input.chatId.slice(0, 8) + ": the reply cited " + rejectedCount + " source number(s) outside this run's registered sources (" + registered.length + " registered); the invalid citations were stripped and no source was listed for them");
  }
  const sources = registered.filter(s => cited.has(s.n));
  if (sources.length) {
    text = text + "\n\nSources:\n" + sources.map(s => "[" + s.n + "] " + s.descriptor).join("\n");
  }
  return { text, sources, registered, rejectedCount };
}

// The source-citation rejection scorecard (2026-11-18, the
// measured-proof series): the citation pass above ledgers
// every reply that tried to cite a number outside its run's
// registered sources as a "source-citation-rejected" line,
// in the one fixed shape processReplySources writes - the
// rejected count and the registered count that reply was
// offered. Self-work classifies the kind, but no daily
// surface ever counted it, so a model that started
// fabricating citations regularly was invisible until the
// owner read a reply closely. This text folds the whole
// ledger's rejection lines to counts only: the replies with
// rejections, the summed rejected citations, and the summed
// registered sources. A summary matching the fixed shape's
// counts in neither place counts as a rejection and
// contributes no counts, and is never printed. No stamp, no
// chat id, no actor, no source descriptor, no verbatim
// summary enters the text, so a day no reply fabricates a
// citation is byte-identical and P3-silent, and the first
// new fabricated citation is the news. A pure read: it
// creates nothing, spends no model call, and retries
// nothing - the ledger and the citation pass are untouched.
export function parseSourceCitationRejection(summary: string): { rejected: number; registered: number } | null {
  const m = /^Source citation rejected in chat [0-9a-f]+: the reply cited (\d+) source number\(s\) outside this run's registered sources \((\d+) registered\);/.exec(summary);
  if (!m) return null;
  return { rejected: Number(m[1]), registered: Number(m[2]) };
}
export function sourceCitationRejectionScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "source-citation-rejected" });
  let rejected = 0;
  let registered = 0;
  for (const line of lines) {
    const parsed = parseSourceCitationRejection(line.summary);
    if (parsed) { rejected += parsed.rejected; registered += parsed.registered; }
  }
  const out: string[] = [];
  out.push("Source citation rejections: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Replies with rejections: " + String(lines.length));
  out.push("Rejected citations: " + String(rejected));
  out.push("Registered sources: " + String(registered));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a reply or prints a source; a new fabricated citation is the news");
  return out.join("\n");
}

// The ONE writer for the positive citation line: a turn that
// saved a reply with a Sources list attached ledgers exactly
// this shape (the chat id's first 8, the cited count, the
// registered count), so the writer and the scorecard's parser
// below can never drift.
export function sourceCitationLedgerSummary(chatId: string, cited: number, registered: number): string {
  return "Sources attached in chat " + chatId.slice(0, 8) + ": " + String(cited) + " cited of " + String(registered) + " registered this run";
}

// The source-citation scorecard (2026-11-19, the
// measured-proof series): the rejection scorecard above has
// counted fabricated citations since 2026-11-18, but the
// positive class - replies that actually attached a Sources
// list, ledgered as "source-citation" lines in the one fixed
// shape sourceCitationLedgerSummary writes - was never
// folded, so whether SAM grounds its replies at all, and
// what share of a run's registered sources its replies
// actually cite, was invisible in aggregate. This text folds
// the whole ledger's source-citation lines to counts only:
// the replies with sources, the summed cited and registered
// counts, and the distinct-chat count as a NUMBER only
// (counted from the lines' chat ids, which are never
// printed). A summary matching the fixed shape counts as a
// reply and contributes nothing else, and is never printed.
// The verdict is attention only when a line is unparseable,
// else clear - attached sources are the healthy case, not
// news by themselves. No stamp, no actor, no chat id, no
// source descriptor, no verbatim summary enters the text, so
// a day no reply attaches sources is byte-identical and
// P3-silent, and a malformed line or a mix shift is the
// news. A pure read: it creates nothing, spends no model
// call, and retries nothing - the ledger and the citation
// pass are untouched.
export function parseSourceCitation(summary: string): { chatId: string; cited: number; registered: number } | null {
  const m = /^Sources attached in chat ([0-9a-f]+): (\d+) cited of (\d+) registered this run$/.exec(summary);
  if (!m) return null;
  return { chatId: m[1], cited: Number(m[2]), registered: Number(m[3]) };
}
export function sourceCitationScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "source-citation" });
  let cited = 0;
  let registered = 0;
  let unparseable = 0;
  const chats = new Set<string>();
  for (const line of lines) {
    const parsed = parseSourceCitation(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    cited += parsed.cited;
    registered += parsed.registered;
    chats.add(parsed.chatId);
  }
  const out: string[] = [];
  out.push("Source citations: " + (unparseable > 0 ? "attention" : "clear"));
  out.push("Replies with sources: " + String(lines.length));
  out.push("Cited sources: " + String(cited));
  out.push("Registered sources: " + String(registered));
  out.push("Distinct chats: " + String(chats.size));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never attaches a source or prints one; a malformed line or a mix shift is the news");
  return out.join("\n");
}

// ----------------------------------------------------------------
// The store: one row per answered reply, keyed by the reply's own
// message id, holding the run's full registry and the subset the
// reply cited - the audit record behind the rendered list.
// .sam/source-citations.db through openDatabase, the F1 store
// discipline like every other store.
// ----------------------------------------------------------------

function sourcesDbFile(root: string): string {
  return join(resolve(root), ".sam", "source-citations.db");
}

export interface StoredReplySources {
  messageId: string;
  chatId: string;
  actor: string;
  registered: RunSource[];
  cited: RunSource[];
  createdAt: string;
}

export function attachReplySources(root: string, input: { messageId: string; chatId: string; actor: string; registered: RunSource[]; cited: RunSource[] }): boolean {
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    const db = openDatabase(sourcesDbFile(root));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS message_sources (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, actor TEXT NOT NULL, registered_json TEXT NOT NULL, cited_json TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO message_sources (message_id, chat_id, actor, registered_json, cited_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.messageId, input.chatId, input.actor, JSON.stringify(input.registered), JSON.stringify(input.cited), new Date().toISOString());
    } finally { db.close(); }
    return true;
  } catch (error) {
    recordSourceFailure(root, input.actor, "attach", error);
    return false;
  }
}

interface SourceRow { message_id: string; chat_id: string; actor: string; registered_json: string; cited_json: string; created_at: string }

function parseSources(json: string): RunSource[] {
  try {
    const rows = JSON.parse(json) as Array<Partial<RunSource>>;
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => typeof r?.n === "number" && typeof r?.descriptor === "string")
      .map(r => ({ n: r.n as number, kind: (r.kind as SourceKind) ?? "doc", descriptor: r.descriptor as string }));
  } catch { return []; }
}

function rowToStored(row: SourceRow): StoredReplySources {
  return {
    messageId: row.message_id, chatId: row.chat_id, actor: row.actor,
    registered: parseSources(row.registered_json), cited: parseSources(row.cited_json),
    createdAt: row.created_at,
  };
}

export function sourcesForMessage(root: string, messageId: string): StoredReplySources | null {
  if (!existsSync(sourcesDbFile(root))) return null;
  const db = openDatabase(sourcesDbFile(root), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM message_sources WHERE message_id = ?").get(messageId) as SourceRow | undefined;
    return row ? rowToStored(row) : null;
  } finally { db.close(); }
}

export function sourcesForChat(root: string, chatId: string): StoredReplySources[] {
  if (!existsSync(sourcesDbFile(root))) return [];
  const db = openDatabase(sourcesDbFile(root), { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM message_sources WHERE chat_id = ?").all(chatId) as SourceRow[];
    return rows.map(rowToStored);
  } finally { db.close(); }
}

/** The dashboard/API view: reply message id -> the sources that reply cited. */
export function sourceViewsForChat(root: string, chatId: string): Record<string, RunSource[]> {
  const views: Record<string, RunSource[]> = {};
  for (const stored of sourcesForChat(root, chatId)) {
    if (stored.cited.length) views[stored.messageId] = stored.cited;
  }
  return views;
}

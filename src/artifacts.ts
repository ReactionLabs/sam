import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import type { RunSource, SourceKind } from "./source-citations.js";

/**
 * Artifacts: durable deliverables Sam hands the owner.
 *
 * An artifact is not a chat message and not a loose workspace file.
 * It is a named, profile-owned record with a stable dashboard path,
 * a current version, and an append-only version history. Updating an
 * artifact creates the next version of the SAME record, so a link the
 * owner already has keeps opening the current deliverable while every
 * earlier version remains listable and readable.
 *
 * The store is SQLite at .sam/artifacts.db through openDatabase (the
 * F1 discipline, like every other store). Artifact content is data:
 * it is rendered or sandboxed for reading, never interpreted as an
 * instruction to SAM, and this module contains no path by which an
 * artifact can call a SAM tool or leave the owner's installation.
 */

export const ARTIFACT_KINDS = ["html", "markdown"] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

/** The named per-version content cap. One megabyte is generous for a
 *  self-contained page or a document, and small enough that a runaway
 *  generation cannot fill the store one artifact at a time. The cap
 *  is measured in UTF-8 bytes and its refusal names it. */
export const ARTIFACT_CONTENT_MAX_BYTES = 1_000_000;
export const ARTIFACT_TITLE_MAX_CHARS = 160;
export const ARTIFACT_PROFILE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** The CSP served with raw artifact content. Scripts may run for
 *  interactivity, but the content gets no network at all
 *  (connect-src 'none' covers fetch, XHR, WebSocket, and beacons),
 *  no forms, no base-URL games, and no framing except by SAM's own
 *  reading shell. Inline data/media are allowed because a static
 *  page's assets have to live somewhere. */
export const ARTIFACT_CONTENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
/** The sandbox attribute on the reading shell's frame: scripts run,
 *  but with an opaque origin - no same-origin privileges, no access
 *  to the dashboard's token-bearing API, no forms, popups, downloads,
 *  or top navigation. */
export const ARTIFACT_FRAME_SANDBOX = "allow-scripts";

export interface ArtifactProvenance {
  profile: string;
  chatId: string | null;
  jobId: string | null;
  sources: RunSource[];
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  profile: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: ArtifactProvenance;
  content: string;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  kind: ArtifactKind;
  profile: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: ArtifactProvenance;
  contentBytes: number;
  path: string;
}

export interface ArtifactVersion {
  version: number;
  title: string;
  content: string;
  createdAt: string;
  createdBy: ArtifactProvenance;
}

export interface ArtifactVersionSummary {
  version: number;
  title: string;
  createdAt: string;
  createdBy: ArtifactProvenance;
  contentBytes: number;
}

export function artifactPath(id: string): string {
  return "/artifact/" + id;
}

function artifactsDbFile(root: string): string {
  return join(resolve(root), ".sam", "artifacts.db");
}

function storeExists(root: string): boolean {
  return existsSync(artifactsDbFile(root));
}

function openArtifactsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(artifactsDbFile(root));
  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by_json TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version)
    );
    CREATE INDEX IF NOT EXISTS artifacts_by_profile ON artifacts(profile, updated_at DESC);`);
  return db;
}

// Failure visibility (the record-honesty family): a dead artifact
// store ledgers ONE artifact-failed line (phase + verbatim reason,
// never any artifact content) and the failure rethrows - a failed
// read never folds to a false empty library, and a failed write
// never reports success. The tag keeps one touch to one line when
// a caller wraps an already-ledgered failure.
export function artifactFailureSummary(phase: string, reason: string): string {
  const clean = String(reason ?? "").replace(/\s+/g, " ").trim() || "unknown error";
  return ("Artifact " + phase + " failed: " + clean).slice(0, 300);
}

export function recordArtifactFailure(root: string, actor: string, phase: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, actor, "artifact-failed", artifactFailureSummary(phase, reason));
}

function tagLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { artifactLedgered?: boolean }).artifactLedgered = true;
  }
}

function isLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { artifactLedgered?: boolean }).artifactLedgered === true;
}

function failArtifact(root: string, actor: string, phase: string, error: unknown): never {
  if (!isLedgered(error)) recordArtifactFailure(root, actor, phase, error);
  tagLedgered(error);
  throw error;
}

const SOURCE_KINDS: SourceKind[] = ["file", "skill", "command", "web", "connector", "memory", "doc"];

function cleanSources(raw: unknown): RunSource[] {
  if (!Array.isArray(raw)) return [];
  const out: RunSource[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<RunSource>;
    if (typeof s.n !== "number" || !Number.isInteger(s.n) || s.n < 1) continue;
    if (typeof s.descriptor !== "string" || !s.descriptor.trim()) continue;
    out.push({
      n: s.n,
      kind: SOURCE_KINDS.includes(s.kind as SourceKind) ? s.kind as SourceKind : "doc",
      descriptor: s.descriptor.replace(/\s+/g, " ").trim().slice(0, 180),
    });
  }
  return out;
}

function provenance(input: { profile: string; chatId?: string | null; jobId?: string | null; sources?: unknown }): ArtifactProvenance {
  return {
    profile: input.profile,
    chatId: typeof input.chatId === "string" && input.chatId ? input.chatId : null,
    jobId: typeof input.jobId === "string" && input.jobId ? input.jobId : null,
    sources: cleanSources(input.sources),
  };
}

function parseProvenance(json: string, fallbackProfile: string): ArtifactProvenance {
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === "object") {
      const p = value as Partial<ArtifactProvenance>;
      return provenance({
        profile: typeof p.profile === "string" ? p.profile : fallbackProfile,
        chatId: typeof p.chatId === "string" ? p.chatId : null,
        jobId: typeof p.jobId === "string" ? p.jobId : null,
        sources: p.sources,
      });
    }
  } catch { /* a torn provenance reads as the row's own profile with no sources */ }
  return provenance({ profile: fallbackProfile });
}

function validateProfile(profile: string): string {
  if (profile !== "sam" && !ARTIFACT_PROFILE_PATTERN.test(profile ?? "")) throw new Error("Invalid artifact profile");
  return profile;
}

function validateTitle(title: string): string {
  const clean = (title ?? "").trim();
  if (!clean || clean.length > ARTIFACT_TITLE_MAX_CHARS) throw new Error("Artifact title must be 1 to " + String(ARTIFACT_TITLE_MAX_CHARS) + " characters");
  return clean;
}

function validateKind(kind: string): ArtifactKind {
  if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) throw new Error("Invalid artifact kind: " + String(kind) + " (html or markdown)");
  return kind as ArtifactKind;
}

export function artifactContentBytes(content: string): number {
  return Buffer.byteLength(content ?? "", "utf8");
}

function validateContent(content: string): string {
  if (typeof content !== "string" || !content.trim()) throw new Error("Artifact content must not be empty");
  const bytes = artifactContentBytes(content);
  if (bytes > ARTIFACT_CONTENT_MAX_BYTES) {
    throw new Error("Artifact content is " + String(bytes) + " bytes, over the per-artifact cap of " + String(ARTIFACT_CONTENT_MAX_BYTES) + " bytes (ARTIFACT_CONTENT_MAX_BYTES); refusing to store it");
  }
  return content;
}

interface ArtifactRow {
  id: string; profile: string; title: string; kind: string; current_version: number;
  created_at: string; updated_at: string; created_by_json: string;
  content: string; version_created_at: string; version_created_by_json: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as ArtifactKind,
    profile: row.profile,
    version: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: parseProvenance(row.version_created_by_json, row.profile),
    content: row.content,
  };
}

function summaryOf(artifact: Artifact): ArtifactSummary {
  return {
    id: artifact.id, title: artifact.title, kind: artifact.kind, profile: artifact.profile,
    version: artifact.version, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
    createdBy: artifact.createdBy, contentBytes: artifactContentBytes(artifact.content),
    path: artifactPath(artifact.id),
  };
}

const CURRENT_SELECT = `SELECT a.id, a.profile, a.title, a.kind, a.current_version, a.created_at, a.updated_at,
  a.created_by_json, v.content, v.created_at AS version_created_at, v.created_by_json AS version_created_by_json
  FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version`;

export interface CreateArtifactInput {
  profile: string; title: string; kind: string; content: string;
  chatId?: string | null; jobId?: string | null; sources?: unknown;
}

export function createArtifact(root: string, input: CreateArtifactInput): Artifact {
  const profile = validateProfile(input.profile);
  const title = validateTitle(input.title);
  const kind = validateKind(input.kind);
  const content = validateContent(input.content);
  const by = provenance({ profile, chatId: input.chatId, jobId: input.jobId, sources: input.sources });
  const now = new Date().toISOString();
  const id = randomUUID();
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const write = db.transaction(() => {
      db!.prepare("INSERT INTO artifacts (id, profile, title, kind, current_version, created_at, updated_at, created_by_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
        .run(id, profile, title, kind, now, now, JSON.stringify(by));
      db!.prepare("INSERT INTO artifact_versions (artifact_id, version, title, content, created_at, created_by_json) VALUES (?, 1, ?, ?, ?, ?)")
        .run(id, title, content, now, JSON.stringify(by));
    });
    write();
  } catch (error) {
    failArtifact(root, profile, "create", error);
  } finally { db?.close(); }
  recordActivity(root, profile, "artifact", "Created artifact '" + title + "' (" + kind + ", v1) " + id.slice(0, 8));
  return { id, title, kind, profile, version: 1, createdAt: now, updatedAt: now, createdBy: by, content };
}

export interface UpdateArtifactInput {
  profile: string; content: string; title?: string;
  chatId?: string | null; jobId?: string | null; sources?: unknown;
}

export function updateArtifact(root: string, id: string, input: UpdateArtifactInput): Artifact {
  const profile = validateProfile(input.profile);
  const content = validateContent(input.content);
  const by = provenance({ profile, chatId: input.chatId, jobId: input.jobId, sources: input.sources });
  let result: Artifact | null = null;
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const write = db.transaction(() => {
      const row = db!.prepare(CURRENT_SELECT + " WHERE a.id = ?").get(id) as ArtifactRow | undefined;
      if (!row) throw new Error("Artifact not found: " + id);
      if (row.profile !== profile) throw new Error("Artifact " + id.slice(0, 8) + " belongs to profile " + row.profile + ", not " + profile);
      const current = rowToArtifact(row);
      const title = input.title !== undefined ? validateTitle(input.title) : current.title;
      const version = current.version + 1;
      const now = new Date().toISOString();
      db!.prepare("INSERT INTO artifact_versions (artifact_id, version, title, content, created_at, created_by_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, version, title, content, now, JSON.stringify(by));
      db!.prepare("UPDATE artifacts SET title = ?, current_version = ?, updated_at = ? WHERE id = ?")
        .run(title, version, now, id);
      result = { ...current, title, version, updatedAt: now, createdBy: by, content };
    });
    write();
  } catch (error) {
    failArtifact(root, profile, "update", error);
  } finally { db?.close(); }
  const done = result as Artifact | null;
  if (!done) throw new Error("Artifact not found: " + id);
  recordActivity(root, profile, "artifact", "Updated artifact '" + done.title + "' (" + done.kind + ", v" + String(done.version) + ") " + id.slice(0, 8));
  return done;
}

/** Summaries for one profile (or every profile when none is named -
 *  the operator/CLI door), newest update first. A pure read on an
 *  install with no store returns [] and creates nothing. */
export function listArtifacts(root: string, profile?: string): ArtifactSummary[] {
  if (profile !== undefined) validateProfile(profile);
  if (!storeExists(root)) return [];
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const rows = (profile
      ? db.prepare(CURRENT_SELECT + " WHERE a.profile = ? ORDER BY a.updated_at DESC").all(profile)
      : db.prepare(CURRENT_SELECT + " ORDER BY a.updated_at DESC").all()) as ArtifactRow[];
    return rows.map(row => summaryOf(rowToArtifact(row)));
  } catch (error) {
    failArtifact(root, profile ?? "sam", "read", error);
  } finally { db?.close(); }
  throw new Error("unreachable artifact read");
}

export function getArtifact(root: string, id: string, profile?: string): Artifact | null {
  if (profile !== undefined) validateProfile(profile);
  if (!storeExists(root)) return null;
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const row = db.prepare(CURRENT_SELECT + " WHERE a.id = ?").get(id) as ArtifactRow | undefined;
    if (!row) return null;
    if (profile !== undefined && row.profile !== profile) return null;
    return rowToArtifact(row);
  } catch (error) {
    failArtifact(root, profile ?? "sam", "read", error);
  } finally { db?.close(); }
  return null;
}

/** One historical version of an artifact, or null. Versions are
 *  immutable: this is the only read for them and there is no write. */
export function getArtifactVersion(root: string, id: string, version: number, profile?: string): Artifact | null {
  if (profile !== undefined) validateProfile(profile);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!storeExists(root)) return null;
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const head = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Omit<ArtifactRow, "content" | "version_created_at" | "version_created_by_json"> | undefined;
    if (!head) return null;
    if (profile !== undefined && head.profile !== profile) return null;
    const v = db.prepare("SELECT title, content, created_at, created_by_json FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(id, version) as { title: string; content: string; created_at: string; created_by_json: string } | undefined;
    if (!v) return null;
    return {
      id: head.id, title: v.title, kind: head.kind as ArtifactKind, profile: head.profile,
      version, createdAt: head.created_at, updatedAt: v.created_at,
      createdBy: parseProvenance(v.created_by_json, head.profile), content: v.content,
    };
  } catch (error) {
    failArtifact(root, profile ?? "sam", "read", error);
  } finally { db?.close(); }
  return null;
}

export function listArtifactVersions(root: string, id: string, profile?: string): ArtifactVersionSummary[] {
  if (profile !== undefined) validateProfile(profile);
  if (!storeExists(root)) return [];
  let db: Database.Database | null = null;
  try {
    db = openArtifactsStore(root);
    const head = db.prepare("SELECT profile FROM artifacts WHERE id = ?").get(id) as { profile: string } | undefined;
    if (!head) return [];
    if (profile !== undefined && head.profile !== profile) return [];
    const rows = db.prepare("SELECT version, title, content, created_at, created_by_json FROM artifact_versions WHERE artifact_id = ? ORDER BY version").all(id) as Array<{ version: number; title: string; content: string; created_at: string; created_by_json: string }>;
    return rows.map(r => ({
      version: r.version, title: r.title, createdAt: r.created_at,
      createdBy: parseProvenance(r.created_by_json, head.profile),
      contentBytes: artifactContentBytes(r.content),
    }));
  } catch (error) {
    failArtifact(root, profile ?? "sam", "read", error);
  } finally { db?.close(); }
  return [];
}

/** The artifacts one chat produced or revised, newest first - the
 *  seam the dashboard's chat-reply affordance rides: a turn's
 *  artifact calls stamp their chat id in the version provenance. */
export function artifactsForChat(root: string, chatId: string): ArtifactSummary[] {
  return listArtifacts(root).filter(a => a.createdBy.chatId === chatId);
}

// ----------------------------------------------------------------
// Reading: markdown rendering + the reading shell. Markdown is
// escaped FIRST and only a small formatting subset is applied to
// the escaped text, so a document can never inject markup into the
// shell. HTML artifacts never render in the shell's own origin:
// they ride the sandboxed frame at the content path.
// ----------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>');
}

export function renderMarkdownArtifact(content: string): string {
  const lines = (content ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) { out.push("<p>" + inlineMarkdown(escapeHtml(paragraph.join(" "))) + "</p>"); paragraph = []; }
  };
  const flushList = () => {
    if (list.length) { out.push("<ul>" + list.map(item => "<li>" + inlineMarkdown(escapeHtml(item)) + "</li>").join("") + "</ul>"); list = []; }
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) { out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>"); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushParagraph(); flushList(); code = []; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      out.push("<h" + String(level) + ">" + inlineMarkdown(escapeHtml(heading[2])) + "</h" + String(level) + ">");
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    flushList();
    paragraph.push(line.trim());
  }
  if (code !== null) out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
  flushParagraph(); flushList();
  return out.join("\n");
}

const SHELL_CSS = "body{font-family:system-ui,sans-serif;margin:0;background:#101113;color:#f2f3f5}header{padding:18px 22px;border-bottom:1px solid #303137}header h1{font-size:20px;margin:0 0 6px}header p{margin:0;color:#a8a399;font-size:13px}main{max-width:860px;margin:0 auto;padding:24px 22px 48px;line-height:1.65}main h1{font-size:28px}main h2{font-size:22px}main h3{font-size:18px}pre{background:#1a1b1e;border:1px solid #303137;border-radius:10px;padding:14px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}a{color:#9fc3ff}iframe{width:100%;height:calc(100dvh - 130px);border:0;background:#fff}.versions{max-width:860px;margin:0 auto;padding:0 22px 28px;color:#a8a399;font-size:13px}.versions a{color:#9fc3ff}";

/** The reading page for one artifact version: chrome (title, kind,
 *  version, provenance, version history) around either the rendered
 *  markdown or the sandboxed HTML frame. This page is served at the
 *  token-free stable path /artifact/<id>; the raw HTML of an html
 *  artifact is served separately at /artifact/<id>/content under
 *  ARTIFACT_CONTENT_CSP. */
export function artifactReadingHtml(artifact: Artifact, versions: ArtifactVersionSummary[]): string {
  const title = escapeHtml(artifact.title);
  const meta = artifact.kind + " · version " + String(artifact.version) + " · profile " + escapeHtml(artifact.profile)
    + " · updated " + escapeHtml(artifact.updatedAt)
    + (artifact.createdBy.chatId ? " · from chat " + escapeHtml(artifact.createdBy.chatId.slice(0, 8)) : "")
    + (artifact.createdBy.jobId ? " · job " + escapeHtml(artifact.createdBy.jobId.slice(0, 8)) : "");
  const sources = artifact.createdBy.sources.length
    ? "<p>Sources: " + artifact.createdBy.sources.map(s => "[" + String(s.n) + "] " + escapeHtml(s.descriptor)).join(" · ") + "</p>"
    : "";
  const body = artifact.kind === "markdown"
    ? renderMarkdownArtifact(artifact.content)
    : '<iframe title="' + title + '" sandbox="' + ARTIFACT_FRAME_SANDBOX + '" src="' + artifactPath(artifact.id) + "/content?version=" + String(artifact.version) + '"></iframe>';
  const history = versions.length > 1
    ? '<div class="versions">History: ' + versions.map(v =>
      v.version === artifact.version
        ? "<strong>v" + String(v.version) + "</strong>"
        : '<a href="' + artifactPath(artifact.id) + "?version=" + String(v.version) + '">v' + String(v.version) + "</a>",
    ).join(" · ") + "</div>"
    : "";
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>"
    + title + " · S.A.M. Artifact</title><style>" + SHELL_CSS + "</style></head><body><header><h1>" + title + "</h1><p>"
    + meta + "</p>" + sources + "</header><main>" + body + "</main>" + history + "</body></html>";
}

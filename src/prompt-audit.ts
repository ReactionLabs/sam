import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { CAPABILITY_STATEMENT } from "./identity.js";
import { PLAIN_STYLE_INSTRUCTION } from "./style.js";
import { OWN_TOOLS } from "./own-tools.js";
import { toolNameOf } from "./tool-tiers.js";
import { budgetFallbackAnswer, budgetStubContent } from "./budgets.js";
import { loaderLoopFallbackAnswer, loaderLoopNudge } from "./tool-tiers.js";

/**
 * The prompt audit (HARNESS INTELLIGENCE item 1, Dip 2026-11-11):
 * SAM's harness is only as smart as the prompts it ships, and
 * until now nothing measured them - "prompted right" was vibes.
 * This module scores the LIVE shipped surfaces deterministically
 * (no model call): the core capability statement, the plain-style
 * instruction, every own-tool description, and the budget /
 * loader stub texts the model reads mid-turn as instructions.
 *
 * - FIVE DIMENSIONS, ANCHORED CHECKS: role clarity, decision
 *   rules (act vs ask), tool-use discipline, honesty under
 *   uncertainty, output hygiene - the five item 1 names. Each
 *   check is an anchored pattern over a named surface; a failed
 *   check is a FINDING that names the line that is missing, so
 *   the audit is a work list, not a grade. Scores are passed /
 *   total per dimension and overall, so a prompt change is
 *   measured before/after, never asserted.
 * - THE SURFACES ARE THE SHIPPED ONES: the audit reads the same
 *   constants the turn assembles, so a green audit can never
 *   drift from what the model actually receives. Tests may feed
 *   synthetic surfaces to prove the instrument can fail.
 * - RECORDED: a run persists to SQLite (.sam/prompt-audit.db,
 *   the singleton pattern through openDatabase - ONE row holding
 *   the audit's full JSON, legacy JSON import-once) and writes
 *   one prompt-audit activity line carrying counts only. A pure
 *   read (readPromptAudit) creates nothing. "sam-prompt-audit"
 *   joins the Phase C script allowlist so a heartbeat job CAN
 *   re-measure on a schedule.
 */

export const PROMPT_AUDIT_SCRIPT = "sam-prompt-audit";

export interface PromptSurfaces {
  core: string;
  style: string;
  tools: Array<{ name: string; description: string }>;
  stubs: string;
}
export interface PromptCheck { id: string; label: string; surface: string; passed: boolean }
export interface PromptDimension { id: string; label: string; passed: number; total: number; checks: PromptCheck[] }
export interface PromptAudit {
  at: string;
  overall: { passed: number; total: number };
  dimensions: PromptDimension[];
  findings: Array<{ dimension: string; check: string; missing: string }>;
  surfaces: { coreChars: number; styleChars: number; tools: number; stubChars: number };
}

/** The surfaces exactly as a live turn receives them. */
export function promptSurfaces(): PromptSurfaces {
  const tools = OWN_TOOLS.map(def => {
    const fn = (def as { function?: { description?: unknown } }).function;
    return { name: toolNameOf(def), description: typeof fn?.description === "string" ? fn.description : "" };
  }).filter(t => t.name);
  const stubs = [
    budgetStubContent(["sam_code"], 6),
    budgetFallbackAnswer(["sam_code"], ["sam_brief"], 6),
    loaderLoopNudge(),
    loaderLoopFallbackAnswer(["sam_load_tools"]),
  ].join("\n");
  return { core: CAPABILITY_STATEMENT, style: PLAIN_STYLE_INSTRUCTION, tools, stubs };
}

interface CheckSpec { id: string; label: string; missing: string; surface: "core" | "style" | "tools" | "stubs"; test: (s: PromptSurfaces) => boolean }
const has = (surface: "core" | "style" | "stubs", re: RegExp): ((s: PromptSurfaces) => boolean) => (s) => re.test(s[surface]);

const DIMENSIONS: Array<{ id: string; label: string; checks: CheckSpec[] }> = [
  { id: "role", label: "Role clarity", checks: [
    { id: "role-name", label: "names itself as S.A.M.", missing: "an opening line naming SAM and what SAM is", surface: "core", test: has("core", /You are S\.A\.M\./) },
    { id: "role-owner", label: "works for the owner of the installation", missing: "a line saying SAM works for the owner of this installation", surface: "core", test: has("core", /work for the owner/i) },
    { id: "role-scoped", label: "a scoped profile is still that person's SAM, never a mini", missing: "the scoped-identity rule (never call yourself a mini / sub-agent)", surface: "core", test: has("core", /never call yourself a mini/i) },
  ] },
  { id: "decision", label: "Decision rules (act vs ask)", checks: [
    { id: "decision-ask", label: "consequential actions need the owner's permission", missing: "the ask rule: permission before consequential actions", surface: "core", test: has("core", /Ask for permission before consequential actions/) },
    { id: "decision-act", label: "internal, reversible work proceeds without asking", missing: "the act rule: internal reversible work is done without asking", surface: "core", test: has("core", /do it without asking/) },
    { id: "decision-unsure", label: "unsure whether consequential means treat it as consequential and ask", missing: "the unsure rule: when unsure whether an act is consequential, treat it as consequential and ask", surface: "core", test: has("core", /treat it as consequential and ask/) },
    { id: "decision-fences", label: "standing fences: never send externally, never move money", missing: "the standing fences (no external sends, no money movement)", surface: "core", test: has("core", /never move money/i) },
  ] },
  { id: "tools", label: "Tool-use discipline", checks: [
    { id: "tools-claim", label: "never claim an action without a confirming tool result", missing: "the claim rule: never claim an action unless a tool result confirms it", surface: "core", test: has("core", /Never claim to have performed an action unless a tool result confirms it/) },
    { id: "tools-skill-vs-fact", label: "a skill's text is a claim, a tool result is the fact", missing: "the claim-vs-fact rule for skill text vs tool results", surface: "core", test: has("core", /What a skill's text says you can do is a claim; what a tool just returned is the fact/) },
    { id: "tools-loader", label: "loading tools is preparation, not progress", missing: "the loader rule: loading is preparation, not progress", surface: "core", test: has("core", /loading is preparation, not progress/) },
    { id: "tools-fenced-descriptions", label: "tool descriptions carry their fences (untrusted / refused / never)", missing: "fence language inside the tool descriptions themselves (at least 8 tools)", surface: "tools", test: (s) => s.tools.filter(t => /untrusted|refused|never/i.test(t.description)).length >= 8 },
    { id: "tools-stub-honesty", label: "budget / loader stubs tell the model to answer from what it gathered", missing: "an honest stub text for budget / loader exhaustion", surface: "stubs", test: (s) => /answer|report/i.test(s.stubs) && s.stubs.length > 100 },
  ] },
  { id: "honesty", label: "Honesty under uncertainty", checks: [
    { id: "honesty-plain", label: "unknown means say so plainly and name what is missing instead of guessing", missing: "the general uncertainty rule: say so plainly and name what is missing instead of guessing", surface: "core", test: has("core", /say so plainly and name what is missing instead of guessing/) },
    { id: "honesty-tool-fact", label: "facts about the owner's data come only from a tool result just read", missing: "the fresh-fact rule: owner's-data facts only from a tool result just read, not memory of an earlier turn", surface: "core", test: has("core", /only from a tool result you just read/) },
    { id: "honesty-floor", label: "an unknowable exact count is reported as a floor, never faked", missing: "the floor rule for paged counts (a floor instead of a fake exact number)", surface: "core", test: has("core", /gives the floor instead of an exact number/) },
    { id: "honesty-capability", label: "never announce a capability from a skill description alone", missing: "the capability honesty rule (never announce a capability from a skill description alone)", surface: "core", test: has("core", /never announce a capability from a skill description alone/) },
  ] },
  { id: "hygiene", label: "Output hygiene", checks: [
    { id: "hygiene-emphasis", label: "no bold, italics, or asterisk emphasis", missing: "the plain-style emphasis ban", surface: "style", test: has("style", /never use bold, italics/) },
    { id: "hygiene-structure", label: "no markdown headings or tables", missing: "the plain-style ban on headings and tables", surface: "style", test: has("style", /do not use markdown headings or tables/) },
    { id: "hygiene-lists", label: "lists only when listing real items", missing: "the plain-style rule that lists are only for real items", surface: "style", test: has("style", /only when listing real items/) },
  ] },
];

/** Score the given surfaces. Pure and deterministic: the same
 *  surfaces always produce the same audit (apart from `at`). */
export function auditPrompts(surfaces: PromptSurfaces): PromptAudit {
  const dimensions: PromptDimension[] = [];
  const findings: PromptAudit["findings"] = [];
  let passed = 0; let total = 0;
  for (const dim of DIMENSIONS) {
    const checks: PromptCheck[] = dim.checks.map(spec => {
      let ok = false;
      try { ok = spec.test(surfaces); } catch { ok = false; }
      if (!ok) findings.push({ dimension: dim.id, check: spec.id, missing: spec.missing });
      return { id: spec.id, label: spec.label, surface: spec.surface, passed: ok };
    });
    const p = checks.filter(c => c.passed).length;
    passed += p; total += checks.length;
    dimensions.push({ id: dim.id, label: dim.label, passed: p, total: checks.length, checks });
  }
  return {
    at: new Date().toISOString(),
    overall: { passed, total },
    dimensions,
    findings,
    surfaces: { coreChars: surfaces.core.length, styleChars: surfaces.style.length, tools: surfaces.tools.length, stubChars: surfaces.stubs.length },
  };
}

export function buildPromptAudit(): PromptAudit { return auditPrompts(promptSurfaces()); }

function auditPath(root: string) { return join(resolve(root), ".sam", "prompt-audit.json"); }
function auditDbPath(root: string) { return join(resolve(root), ".sam", "prompt-audit.db"); }

function parseAudit(data: unknown): PromptAudit | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<PromptAudit>;
  if (typeof value.at !== "string" || !value.at) return null;
  if (!value.overall || typeof value.overall.passed !== "number" || typeof value.overall.total !== "number") return null;
  if (!Array.isArray(value.dimensions) || !Array.isArray(value.findings)) return null;
  return value as PromptAudit;
}
function openAuditStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(auditDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS prompt_audit (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyAudit(db, root);
  return db;
}
function migrateLegacyAudit(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM prompt_audit WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = auditPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseAudit(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO prompt_audit (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function auditStoreExists(root: string): boolean {
  return existsSync(auditDbPath(root)) || existsSync(auditPath(root));
}

/** The recorded audit through the store's own shape, or null
 *  when no audit has ever run - and a read on an install with
 *  no store at all creates nothing. */
export function readPromptAudit(root: string): PromptAudit | null {
  if (!auditStoreExists(root)) return null;
  const db = openAuditStore(root);
  try {
    const row = db.prepare("SELECT data FROM prompt_audit WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseAudit(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function savePromptAudit(root: string, audit: PromptAudit): void {
  const db = openAuditStore(root);
  try {
    db.prepare("INSERT INTO prompt_audit (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(audit));
  } finally { db.close(); }
}

/** Run the audit over the live shipped surfaces: build it,
 *  record it (one UPSERT), and ledger one line carrying counts
 *  only. Returns the recorded audit. */
export function runPromptAudit(root: string): PromptAudit {
  const audit = buildPromptAudit();
  savePromptAudit(root, audit);
  recordActivity(root, "sam", "prompt-audit", "Prompt audit recorded: " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks, " + String(audit.findings.length) + " finding(s), " + String(audit.surfaces.tools) + " tool descriptions");
  return audit;
}

/** The audit as plain text (the sam-prompt-audit script job's
 *  stdout shape): the scorecard a person reads. */
export function promptAuditText(audit: PromptAudit): string {
  const lines: string[] = ["Prompt audit - " + audit.at + " - " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks passed"];
  for (const dim of audit.dimensions) lines.push("- " + dim.label + ": " + String(dim.passed) + "/" + String(dim.total));
  if (audit.findings.length) {
    lines.push("", "Findings (missing lines):");
    for (const f of audit.findings) lines.push("- [" + f.dimension + "/" + f.check + "] " + f.missing);
  } else lines.push("", "Findings: none - every anchored line is present in the shipped prompts.");
  lines.push("", "Surfaces: core " + String(audit.surfaces.coreChars) + " chars; style " + String(audit.surfaces.styleChars) + " chars; " + String(audit.surfaces.tools) + " tool descriptions; stubs " + String(audit.surfaces.stubChars) + " chars.");
  return lines.join("\n");
}

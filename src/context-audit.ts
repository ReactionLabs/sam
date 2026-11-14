import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore, MEMORY_RECORD_MAX_WORDS } from "./memory.js";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { CAPABILITY_STATEMENT } from "./identity.js";
import { PLAIN_STYLE_INSTRUCTION } from "./style.js";
import { ChatStore } from "./chats.js";
import { PreferenceStore, lawPromptBlock, LAW_PROMPT_MAX_CHARS, type Preference } from "./preferences.js";
import { fitRecallBlock, RECALL_MAX_CHARS, type RecallSection } from "./recall.js";
import { composeSystemPrompt, standingPromptParts, STANDING_FILE_MAX_CHARS } from "./standing-files.js";
import { COMPACT_KEEP_MESSAGES, COMPACT_SUMMARY_MAX_CHARS, COMPACT_TRIGGER_CHARS, COMPACT_TRIGGER_MESSAGES } from "./compaction.js";
import { assembleTurnMessages, duplicateMessageIdCount } from "./prompt-assembly.js";

/**
 * The context audit (HARNESS INTELLIGENCE item 2, Dip 2026-11-11):
 * item 1 measured the prompts; this measures what a turn actually
 * LOADS around them - memory recall, standing law, standing files,
 * and the compacted history tail - and whether the assembly's
 * fitting rules can silently lose the parts that matter most.
 *
 * - FUNCTIONAL ANCHORED CHECKS: each check runs the REAL assembly
 *   function on a synthetic oversize input (the prompt-audit
 *   precedent: the instrument must be able to say no). Recall must
 *   fit its cap in whole lines with the message-relevant section
 *   protected and omissions marked; the law block must fit its
 *   character cap with omissions named; law must assemble AFTER
 *   the standing tiers so it stays the override layer; compaction
 *   bounds must be sane relationships, not vibes.
 * - MEASURED LIVE LOAD: for every profile, the fixed system load
 *   a chat turn carries before history (core + style + standing
 *   files + role instructions + law block) is counted in chars
 *   against a named budget, so a profile that outgrows its
 *   context says so in a finding instead of degrading quietly.
 * - RECORDED: a run persists to SQLite (.sam/context-audit.db,
 *   the singleton pattern through openDatabase - ONE row holding
 *   the audit's full JSON, legacy JSON import-once) and writes
 *   one context-audit activity line carrying counts only. A pure
 *   read (readContextAudit) creates nothing. "sam-context-audit"
 *   joins the Phase C script allowlist so a heartbeat job CAN
 *   re-measure on a schedule. No model call anywhere.
 */

export const CONTEXT_AUDIT_SCRIPT = "sam-context-audit";
export const SYSTEM_CONTEXT_BUDGET_CHARS = 32000;

export interface ContextCheck { id: string; label: string; passed: boolean }
export interface ContextDimension { id: string; label: string; passed: number; total: number; checks: ContextCheck[] }
export interface ProfileLoad { profile: string; chars: number; standingChars: number; lawChars: number; lawCount: number; roleChars: number }
export interface ContextAudit {
  at: string;
  overall: { passed: number; total: number };
  dimensions: ContextDimension[];
  findings: Array<{ dimension: string; check: string; missing: string }>;
  profiles: ProfileLoad[];
  budget: number;
}

function syntheticLaws(n: number, chars: number): Preference[] {
  return Array.from({ length: n }, (_, i) => ({
    id: "synthetic-" + String(i), profile: "sam", statement: ("Law number " + String(i) + " ").padEnd(chars, "x").slice(0, chars),
    kind: "rule" as const, status: "law" as const, hits: 1, source: "context-audit", created_at: "", updated_at: "",
  }));
}

function oversizeSections(): RecallSection[] {
  const lines = (tag: string, n: number, len: number) => Array.from({ length: n }, (_, i) => "- [" + tag + " " + String(i) + "] " + tag.repeat(Math.max(1, Math.floor(len / tag.length))).slice(0, len));
  return [
    { heading: "Where things stand:", lines: lines("standing", 8, 200), priority: 1 },
    { heading: "Recent episodes:", lines: lines("episode", 4, 300), priority: 2 },
    { heading: "Records relevant to this message:", lines: lines("relevant", 5, 260), priority: 3 },
  ];
}

interface CheckSpec { id: string; label: string; missing: string; run: (a: ContextAssembly) => boolean }
export interface ContextAssembly { profiles: ProfileLoad[] }

const DIMENSIONS: Array<{ id: string; label: string; checks: CheckSpec[] }> = [
  { id: "recall", label: "Memory recall fitting", checks: [
    { id: "recall-capped", label: "the recall block never exceeds its character cap", missing: "a character cap the fitted recall block actually respects", run: () => fitRecallBlock("header", oversizeSections()).length <= RECALL_MAX_CHARS },
    { id: "recall-relevant-protected", label: "the message-relevant section survives fitting", missing: "priority fitting that protects the message-relevant recall section from being shed first", run: () => fitRecallBlock("header", oversizeSections()).includes("Records relevant to this message:") },
    { id: "recall-omissions-marked", label: "shed recall lines are named by an omission marker, whole lines only", missing: "an omission marker naming shed recall lines (no silent mid-line slice)", run: () => /omitted, lowest priority first/.test(fitRecallBlock("header", oversizeSections())) },
    { id: "hot-memory-budget", label: "a single memory record larger than the hot-memory budget is refused at write time (memory stays an index, not an archive)", missing: "a per-write word budget on memory records, enforced in MemoryStore.add (the 100k-char ceiling alone lets one record carry ~25k words)", run: () => { const dir = mkdtempSync(join(tmpdir(), "sam-context-audit-")); try { const store = new MemoryStore(join(dir, "missions.db")); try { store.add({ kind: "observation", content: "a small record", source: "context-audit", scope: "core" }); try { store.add({ kind: "observation", content: Array(MEMORY_RECORD_MAX_WORDS + 1).fill("word").join(" "), source: "context-audit", scope: "core" }); return false; } catch { return true; } } finally { store.close(); } } finally { rmSync(dir, { recursive: true, force: true }); } } },
  ] },
  { id: "law", label: "Standing law block", checks: [
    { id: "law-capped", label: "the law block never exceeds its character cap", missing: "a character cap on the law prompt block (the count cap alone allows ~10k chars)", run: () => lawPromptBlock(syntheticLaws(50, 200)).length <= LAW_PROMPT_MAX_CHARS },
    { id: "law-omissions-named", label: "laws left out of the prompt are named by count", missing: "an omission marker naming how many laws the prompt did not carry", run: () => /more standing law/.test(lawPromptBlock(syntheticLaws(50, 200))) && !/more standing law/.test(lawPromptBlock(syntheticLaws(1, 40))) },
  ] },
  { id: "assembly", label: "Tier order and history bounds", checks: [
    { id: "law-last", label: "standing law assembles after the standing files (the override layer)", missing: "prompt assembly that places standing law after the stable and context tiers", run: () => { const p = composeSystemPrompt({ base: "BASE", style: "STYLE", stable: "STABLETOKEN", role: "ROLETOKEN", context: "CONTEXTTOKEN", volatile: "", law: "LAWTOKEN" }); return p.indexOf("LAWTOKEN") > p.indexOf("STABLETOKEN") && p.indexOf("LAWTOKEN") > p.indexOf("CONTEXTTOKEN"); } },
    { id: "compaction-bounded", label: "compaction keeps a bounded tail under a bounded summary", missing: "sane compaction bounds (keep < trigger, a capped summary, a char trigger above the summary cap)", run: () => COMPACT_KEEP_MESSAGES >= 1 && COMPACT_KEEP_MESSAGES < COMPACT_TRIGGER_MESSAGES && COMPACT_SUMMARY_MAX_CHARS > 0 && COMPACT_TRIGGER_CHARS > COMPACT_SUMMARY_MAX_CHARS },
    { id: "standing-file-capped", label: "each standing file carries a character cap", missing: "a per-file character cap on standing files", run: () => STANDING_FILE_MAX_CHARS > 0 && STANDING_FILE_MAX_CHARS <= 16000 },
    { id: "no-duplicate-messages", label: "a stored message enters the prompt at most once (dedupe by message id, history copy wins)", missing: "prompt assembly that dedupes by message id - the current message was appended as the final turn after already riding in the history tail, so every message reached the model twice", run: () => { const kept = [{ id: "m1", role: "user" as const, content: "are u there?", source: "telegram" }, { id: "m1", role: "user" as const, content: "are u there?", source: "telegram" }, { id: "m2", role: "assistant" as const, content: "here" }]; const out = assembleTurnMessages({ kept, currentId: "m1", currentContent: "are u there?", currentSource: "telegram", resuming: false }); return duplicateMessageIdCount(kept) === 1 && out.filter(m => m.content.includes("are u there?")).length === 1 && out.filter(m => m.content.includes("[metadata source=telegram]")).length === 1; } },
  ] },
  { id: "load", label: "Measured per-profile load", checks: [
    { id: "system-load-budget", label: "every profile's fixed system load fits the named budget", missing: "a profile whose fixed context load (core + style + standing + role + law) fits the system budget - trim standing files or law", run: (a) => a.profiles.every(p => p.chars <= SYSTEM_CONTEXT_BUDGET_CHARS) },
  ] },
];

/** Measure the fixed load one chat turn carries per profile,
 *  before history: the shared base plus that profile's standing
 *  files, role instructions, and law block, counted in chars. */
export function measureProfileLoads(root: string): ProfileLoad[] {
  const base = CAPABILITY_STATEMENT.length + PLAIN_STYLE_INSTRUCTION.length;
  const store = new ChatStore(root);
  let agents: Array<{ name: string; instructions: string }> = [];
  try { agents = store.agents().map(a => ({ name: a.name, instructions: a.instructions ?? "" })); } finally { store.close(); }
  const prefs = new PreferenceStore(root);
  try {
    const loads: ProfileLoad[] = [];
    for (const profile of ["sam", ...agents.map(a => a.name)]) {
      const standing = standingPromptParts(root, profile);
      const standingChars = standing.stable.length + standing.context.length;
      const laws = prefs.lawsFor(profile);
      const lawChars = lawPromptBlock(laws).length;
      const roleChars = agents.find(a => a.name === profile)?.instructions.length ?? 0;
      loads.push({ profile, chars: base + standingChars + lawChars + roleChars, standingChars, lawChars, lawCount: laws.length, roleChars });
    }
    return loads;
  } finally { prefs.close(); }
}

/** Score the assembly rules and the live loads. Deterministic:
 *  the same tree and stores always produce the same audit
 *  (apart from `at`). */
export function buildContextAudit(root: string): ContextAudit {
  const assembly: ContextAssembly = { profiles: measureProfileLoads(root) };
  const dimensions: ContextDimension[] = [];
  const findings: ContextAudit["findings"] = [];
  let passed = 0; let total = 0;
  for (const dim of DIMENSIONS) {
    const checks: ContextCheck[] = dim.checks.map(spec => {
      let ok = false;
      try { ok = spec.run(assembly); } catch { ok = false; }
      if (!ok) findings.push({ dimension: dim.id, check: spec.id, missing: spec.missing });
      return { id: spec.id, label: spec.label, passed: ok };
    });
    const p = checks.filter(c => c.passed).length;
    passed += p; total += checks.length;
    dimensions.push({ id: dim.id, label: dim.label, passed: p, total: checks.length, checks });
  }
  return { at: new Date().toISOString(), overall: { passed, total }, dimensions, findings, profiles: assembly.profiles, budget: SYSTEM_CONTEXT_BUDGET_CHARS };
}

function auditPath(root: string) { return join(resolve(root), ".sam", "context-audit.json"); }
function auditDbPath(root: string) { return join(resolve(root), ".sam", "context-audit.db"); }

function parseAudit(data: unknown): ContextAudit | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Partial<ContextAudit>;
  if (typeof value.at !== "string" || !value.at) return null;
  if (!value.overall || typeof value.overall.passed !== "number" || typeof value.overall.total !== "number") return null;
  if (!Array.isArray(value.dimensions) || !Array.isArray(value.findings) || !Array.isArray(value.profiles)) return null;
  return value as ContextAudit;
}
function openAuditStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(auditDbPath(root));
  db.exec("CREATE TABLE IF NOT EXISTS context_audit (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  migrateLegacyAudit(db, root);
  return db;
}
function migrateLegacyAudit(db: Database.Database, root: string): void {
  const row = db.prepare("SELECT data FROM context_audit WHERE id = 1").get() as { data: string } | undefined;
  if (row) return;
  const file = auditPath(root);
  if (!existsSync(file)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  const record = parseAudit(data);
  if (!record) return;
  db.prepare("INSERT OR IGNORE INTO context_audit (id, data) VALUES (1, ?)").run(JSON.stringify(record));
  renameSync(file, file + ".migrated");
}
function auditStoreExists(root: string): boolean {
  return existsSync(auditDbPath(root)) || existsSync(auditPath(root));
}

/** The recorded audit through the store's own shape, or null
 *  when no audit has ever run - and a read on an install with
 *  no store at all creates nothing. */
export function readContextAudit(root: string): ContextAudit | null {
  if (!auditStoreExists(root)) return null;
  const db = openAuditStore(root);
  try {
    const row = db.prepare("SELECT data FROM context_audit WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return null;
    try { return parseAudit(JSON.parse(row.data)); } catch { return null; }
  } finally { db.close(); }
}

function saveContextAudit(root: string, audit: ContextAudit): void {
  const db = openAuditStore(root);
  try {
    db.prepare("INSERT INTO context_audit (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(audit));
  } finally { db.close(); }
}

/** Run the audit over the live assembly and stores: build it,
 *  record it (one UPSERT), and ledger one line carrying counts
 *  only. Returns the recorded audit. */
export function runContextAudit(root: string): ContextAudit {
  const audit = buildContextAudit(root);
  saveContextAudit(root, audit);
  recordActivity(root, "sam", "context-audit", "Context audit recorded: " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks, " + String(audit.findings.length) + " finding(s), " + String(audit.profiles.length) + " profile load(s), heaviest " + String(Math.max(0, ...audit.profiles.map(p => p.chars))) + " chars of " + String(audit.budget));
  return audit;
}

/** The audit as plain text (the sam-context-audit script job's
 *  stdout shape): the scorecard a person reads. */
export function contextAuditText(audit: ContextAudit): string {
  const lines: string[] = ["Context audit - " + audit.at + " - " + String(audit.overall.passed) + "/" + String(audit.overall.total) + " checks passed"];
  for (const dim of audit.dimensions) lines.push("- " + dim.label + ": " + String(dim.passed) + "/" + String(dim.total));
  if (audit.findings.length) {
    lines.push("", "Findings:");
    for (const f of audit.findings) lines.push("- [" + f.dimension + "/" + f.check + "] " + f.missing);
  } else lines.push("", "Findings: none - recall, law, standing files, and history all fit their budgets with omissions named, and no stored message enters the prompt twice.");
  lines.push("", "Profile loads (fixed system chars, budget " + String(audit.budget) + "):");
  for (const p of audit.profiles) lines.push("- " + p.profile + ": " + String(p.chars) + " chars (standing " + String(p.standingChars) + ", law " + String(p.lawChars) + " across " + String(p.lawCount) + ", role " + String(p.roleChars) + ")");
  return lines.join("\n");
}

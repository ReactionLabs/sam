import { readActivity } from "./activity.js";

// The store failure history scorecard (2026-11-21, the
// measured-proof series): every guarded store touch in SAM
// has ledgered a dead-store failure as one of twenty-six
// kinds since the store census landed - twenty-five
// *-store-failed kinds (action, audit, auth-probes,
// background, chat, code, coding, engine,
// engine-connection, heartbeat-jobs, heartbeat-state, loop,
// memory, mini, parallel, preference, provider, setup,
// skill-allowlists, skill-authors, skill-curator,
// skill-installs, subagents, task, tool-loads) plus
// telegram-state-failed - each through its ONE writer (the
// per-store *StoreFailureSummary functions), in the uniform
// shape "<Label> store <phase> failed: <reason>" (the audit
// writer names its store between the label and the phase).
// Until now there was no fold, so how many store touches
// ever died, on which phase, across how many distinct
// stores, was invisible in aggregate: self-work's defect
// queue counts the lines one by one, and no scorecard
// trends the family. A recorded store failure is the
// signal - a touch that died fail-closed instead of
// folding a dead store as empty state - so the verdict is
// attention only when any failure was ever recorded or a
// line is unparseable, else clear. This text folds the
// twenty-six classes to counts only, on ONE line: the
// failed count, the read / write / resolve phase counts,
// the distinct-store count as a number only, and the
// total. No stamp, no actor, no reason, and no verbatim
// summary enters the text - the summaries carry verbatim
// error reasons, which can name paths and surfaces, and
// the fold consumes and never prints them. The parsers
// validate each line's label and phase against the fixed
// sets the writers themselves use (the audit parser
// validates its store name against the five fixed audit
// stores), so a line whose label or phase drifted from its
// kind counts as unparseable rather than surfacing as free
// text. A pure read: it creates nothing, opens no store,
// and retries nothing - the store seams themselves are
// untouched; they already are the ONE writers.

export interface StoreFailureKindSpec {
  kind: string;
  label: string;
  phases: string[];
}

const READ_WRITE: string[] = ["read", "write"];

export const STORE_FAILURE_KINDS: StoreFailureKindSpec[] = [
  { kind: "action-store-failed", label: "Action store", phases: READ_WRITE },
  { kind: "audit-store-failed", label: "Audit store", phases: READ_WRITE },
  { kind: "auth-probes-store-failed", label: "Auth probes store", phases: READ_WRITE },
  { kind: "background-store-failed", label: "Background store", phases: READ_WRITE },
  { kind: "chat-store-failed", label: "Chat store", phases: READ_WRITE },
  { kind: "code-store-failed", label: "Code store", phases: READ_WRITE },
  { kind: "coding-store-failed", label: "Coding store", phases: READ_WRITE },
  { kind: "engine-connection-store-failed", label: "Engine connection store", phases: ["read", "write", "resolve"] },
  { kind: "engine-store-failed", label: "Engine store", phases: READ_WRITE },
  { kind: "heartbeat-jobs-store-failed", label: "Heartbeat jobs store", phases: READ_WRITE },
  { kind: "heartbeat-state-store-failed", label: "Heartbeat state store", phases: READ_WRITE },
  { kind: "loop-store-failed", label: "Loop store", phases: READ_WRITE },
  { kind: "memory-store-failed", label: "Memory store", phases: READ_WRITE },
  { kind: "mini-store-failed", label: "Mini store", phases: READ_WRITE },
  { kind: "parallel-store-failed", label: "Parallel store", phases: READ_WRITE },
  { kind: "preference-store-failed", label: "Preference store", phases: READ_WRITE },
  { kind: "provider-store-failed", label: "Provider store", phases: READ_WRITE },
  { kind: "setup-store-failed", label: "Setup store", phases: READ_WRITE },
  { kind: "skill-allowlists-store-failed", label: "Skill allowlists store", phases: READ_WRITE },
  { kind: "skill-authors-store-failed", label: "Skill authors store", phases: READ_WRITE },
  { kind: "skill-curator-store-failed", label: "Skill curator store", phases: READ_WRITE },
  { kind: "skill-installs-store-failed", label: "Skill installs store", phases: READ_WRITE },
  { kind: "subagents-store-failed", label: "Subagents store", phases: READ_WRITE },
  { kind: "task-store-failed", label: "Task store", phases: READ_WRITE },
  { kind: "telegram-state-failed", label: "Telegram state store", phases: READ_WRITE },
  { kind: "tool-loads-store-failed", label: "Tool loads store", phases: READ_WRITE },
];

export const AUDIT_STORE_NAMES: string[] = ["self-audit", "prompt-audit", "context-audit", "loop-audit", "eval-battery"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseStoreFailureSummary(kind: string, summary: string): { phase: string } | null {
  const spec = STORE_FAILURE_KINDS.find(s => s.kind === kind);
  if (!spec) return null;
  if (kind === "audit-store-failed") {
    const m = new RegExp("^" + escapeRegExp(spec.label) + " (\\S+) ([a-z]+) failed: (.+)$").exec(summary);
    if (!m) return null;
    if (!AUDIT_STORE_NAMES.includes(m[1])) return null;
    if (!spec.phases.includes(m[2])) return null;
    if (!m[3].trim()) return null;
    return { phase: m[2] };
  }
  const m = new RegExp("^" + escapeRegExp(spec.label) + " ([a-z]+) failed: (.+)$").exec(summary);
  if (!m) return null;
  if (!spec.phases.includes(m[1])) return null;
  if (!m[2].trim()) return null;
  return { phase: m[1] };
}

export function storeFailureHistoryScorecardText(root: string): string {
  let failed = 0;
  let reads = 0;
  let writes = 0;
  let resolves = 0;
  let unparseable = 0;
  let total = 0;
  const stores = new Set<string>();
  for (const spec of STORE_FAILURE_KINDS) {
    const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: spec.kind });
    total += lines.length;
    for (const line of lines) {
      const parsed = parseStoreFailureSummary(spec.kind, line.summary);
      if (!parsed) { unparseable += 1; continue; }
      failed += 1;
      stores.add(spec.kind);
      if (parsed.phase === "read") reads += 1;
      else if (parsed.phase === "write") writes += 1;
      else if (parsed.phase === "resolve") resolves += 1;
    }
  }
  const verdict = (failed > 0 || unparseable > 0) ? "attention" : "clear";
  let text = "Store failure history: " + verdict
    + ", " + String(failed) + " failed"
    + ", " + String(reads) + " read"
    + ", " + String(writes) + " write"
    + ", " + String(resolves) + " resolve"
    + ", " + String(stores.size) + " distinct stores"
    + ", " + String(total) + " total";
  if (unparseable > 0) text += ", " + String(unparseable) + " unparseable";
  return text;
}

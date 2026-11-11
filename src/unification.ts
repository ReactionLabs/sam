import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listActions } from "./actions.js";
import { heartbeatJobs } from "./heartbeat.js";
import { listBackgroundTasks } from "./background.js";

/**
 * UNIFICATION audit (items 2 + 3: one gate, one job).
 *
 * The architectural review (2026-11-09) verified that SAM carries a
 * second system beside the live one: a mission approvals ledger
 * (approvals.ts, ApprovalStore over missions.db) and a stored-but-
 * never-executed schedule store (dashboard.ts schedules.json). The
 * live turn imports none of it. The ONE approval gate is the actions
 * store (actions.ts): every chat proposal, dashboard card, and CLI
 * action decision rides it, under the Phase D approvals engine. The
 * ONE job model is heartbeat jobs + background tasks.
 *
 * This module is the research-pass report the program orders BEFORE
 * anything is deleted: a deterministic, read-only inventory of both
 * sides, plus the exact proposed cut as a named list. It never
 * creates, migrates, or deletes anything:
 *
 * - The legacy gate is read through a read-only SQLite handle opened
 *   with fileMustExist, and only when missions.db already exists.
 *   A missing database stays missing and a missing approvals table
 *   stays missing - an audit that creates the thing it counts would
 *   be lying about the state it found.
 * - The legacy schedule store is read as a file, never through a
 *   writer.
 * - The verdict is always "awaiting-owner-ruling": retire-or-adopt
 *   is Dip's call (deletion of anything real is a standing fence),
 *   and this report is the evidence that ruling is made on.
 *
 * A source guard in the tests pins the other half of ONE GATE: no
 * live surface (agent-turn, own-tools, connector-chat, heartbeat,
 * background, dashboard) may import ApprovalStore. If a second
 * consumer ever appears, the suite fails instead of the second
 * gate quietly growing a door.
 */

export const UNIFICATION_VERDICT = "awaiting-owner-ruling";

/** The exact cut this audit proposes, in order. Nothing here is
 *  executed by this module; each step lands only on the owner's
 *  retire ruling. */
export const PROPOSED_CUT: readonly string[] = [
  "Retire the mission approvals ledger: remove ApprovalStore (src/approvals.ts), the CLI `approval` group (request/list/inspect), and their tests. It has no decide door, no execution consumer, and no live surface; the actions gate is the only approval door.",
  "Retire the unexecuted schedule store: remove listSchedules/addSchedule (dashboard.ts), the .sam/schedules.json store, the CLI `schedule` group, and the dashboard Schedules block's legacy source. Heartbeat jobs (Phase C real cron) are the only schedule surface.",
  "Keep the commander stack's remaining CLI-only stores (missions, operatives, assignment leases, tasks) untouched in this cut: they are records, not gates or schedulers, and face their own retire-or-adopt call separately.",
  "After the cut, re-run this audit: the legacy gate and legacy schedule sections should read absent, and the one-gate guard stays in the suite permanently.",
];

export interface UnificationReport {
  liveGate: {
    store: "actions";
    total: number;
    pending: number;
    done: number;
    rejected: number;
    failed: number;
  };
  legacyGate: {
    store: "missions-approvals";
    dbPresent: boolean;
    approvalsTablePresent: boolean;
    missions: number;
    approvals: number;
    approvalsByStatus: Record<string, number>;
    /** The only consumer is the CLI approval group, which is
     *  request/list/inspect only - there is no decide door and no
     *  execution path consumes a decision. */
    cliOnly: true;
    decideDoor: false;
  };
  legacySchedules: {
    store: "schedules";
    present: boolean;
    count: number | null;
    /** Stored schedules are never executed; heartbeat jobs are
     *  the live scheduler. */
    executed: false;
  };
  liveJobs: {
    heartbeatJobs: number;
    backgroundTasks: number;
    backgroundOpen: number;
  };
  proposedCut: readonly string[];
  verdict: typeof UNIFICATION_VERDICT;
}

function readLegacyGate(root: string): UnificationReport["legacyGate"] {
  const base: UnificationReport["legacyGate"] = {
    store: "missions-approvals",
    dbPresent: false,
    approvalsTablePresent: false,
    missions: 0,
    approvals: 0,
    approvalsByStatus: {},
    cliOnly: true,
    decideDoor: false,
  };
  const dbFile = join(resolve(root), ".sam", "missions.db");
  if (!existsSync(dbFile)) return base;
  base.dbPresent = true;
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name),
    );
    if (tables.has("missions")) {
      base.missions = (db.prepare("SELECT COUNT(*) AS c FROM missions").get() as { c: number }).c;
    }
    if (tables.has("approvals")) {
      base.approvalsTablePresent = true;
      const rows = db.prepare("SELECT status, COUNT(*) AS c FROM approvals GROUP BY status").all() as Array<{ status: string; c: number }>;
      for (const row of rows) {
        base.approvalsByStatus[row.status] = row.c;
        base.approvals += row.c;
      }
    }
    return base;
  } finally {
    db.close();
  }
}

function readLegacySchedules(root: string): UnificationReport["legacySchedules"] {
  const file = join(resolve(root), ".sam", "schedules.json");
  if (!existsSync(file)) return { store: "schedules", present: false, count: 0, executed: false };
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return { store: "schedules", present: true, count: Array.isArray(data) ? data.length : null, executed: false };
  } catch {
    return { store: "schedules", present: true, count: null, executed: false };
  }
}

/** The full audit. Read-only: it creates no file, table, or store. */
export function unificationReport(root: string): UnificationReport {
  const actions = listActions(root);
  const background = listBackgroundTasks(root);
  return {
    liveGate: {
      store: "actions",
      total: actions.length,
      pending: actions.filter(a => a.status === "pending").length,
      done: actions.filter(a => a.status === "done").length,
      rejected: actions.filter(a => a.status === "rejected").length,
      failed: actions.filter(a => a.status === "failed").length,
    },
    legacyGate: readLegacyGate(root),
    legacySchedules: readLegacySchedules(root),
    liveJobs: {
      heartbeatJobs: heartbeatJobs(root).length,
      backgroundTasks: background.length,
      backgroundOpen: background.filter(t => t.status === "queued" || t.status === "running").length,
    },
    proposedCut: PROPOSED_CUT,
    verdict: UNIFICATION_VERDICT,
  };
}

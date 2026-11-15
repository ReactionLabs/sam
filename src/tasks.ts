import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { recordActivity } from "./activity.js";

export type TaskStatus = "PENDING" | "READY" | "LEASED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface Task { id:string; mission_id:string; objective:string; status:TaskStatus; lease_owner:string|null; lease_generation:number; lease_expires_at:number|null; attempts:number; created_at:string }
/** Reject invalid or overflowing timestamps before they can corrupt durable leases. */
function leaseExpiry(now:number,ttlMs:number):number {
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttlMs)||ttlMs<=0||
     !Number.isSafeInteger(now+ttlMs))throw new Error("Invalid lease timestamp or TTL");
  return now+ttlMs;
}
// Failure visibility (gap found 2026-11-15, hourly run
// 03:04 EST): the task store is the TaskScheduler riding
// missions.db - the mission task plan with dependency
// ordering, fenced leases, heartbeat, and completion,
// behind the CLI `task` doors and the offline runner. It
// is the census's odd shape: the only store class that
// takes a raw Database handle instead of a root, so it had
// no ledger of its own to write to, and every touch (the
// constructor's schema exec, add / claim / heartbeat /
// complete, list) threw into whichever catch wrapped the
// call with the seam unnamed - and any reader folding a
// dead store as "no tasks" would silently drop the
// mission's whole plan dressed as an empty list. Now the
// scheduler takes the install root as an optional
// constructor argument, threaded by every production door
// (the CLI's withTasks and both offline-runner
// constructions pass the workspace; OfflineMissionRunner
// passes it through), and its touches own their failure
// when a root is known (the preferences / chats
// precedent): a failed touch ledgers ONE task-store-failed
// line (the constructor's schema exec at phase write,
// because the exec performs the schema writes; list at
// phase read; add / claim / heartbeat / complete at phase
// write; actor sam; the verbatim reason collapsed and
// capped; never any task record - objectives are the
// owner's plan words, not failure data), tags the error,
// and rethrows exactly, so every caller's handling is
// unchanged and reads still fail closed. A touch already
// ledgered gains no second line. A handle-only
// construction (unit tests, scratch harnesses) has no
// install ledger to write to and rethrows bare, exactly
// as before - never dressed as ledgered. Validation and
// data errors (Task objective required, Mission does not
// exist, Mission is terminal, Dependency must belong to
// mission, Invalid worker, the lease / completion
// timestamp refusals) are not store failures and ledger
// nothing. The offline runner's own evidence touches (its
// result read and insert on task_execution_results) are
// the runner's seam, not this store's.
export type TaskStorePhase = "read" | "write";

export function taskStoreFailureSummary(phase: TaskStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Task store " + phase + " failed: " + clean).slice(0, 200);
}

export function recordTaskStoreFailure(root: string, phase: TaskStorePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "task-store-failed", taskStoreFailureSummary(phase, reason));
}

function tagTaskStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { taskStoreLedgered?: boolean }).taskStoreLedgered = true;
  }
}

export function isTaskStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { taskStoreLedgered?: boolean }).taskStoreLedgered === true;
}

const TASK_STORE_VALIDATION = [/^Task objective required$/, /^Mission does not exist$/, /^Mission is terminal$/, /^Dependency must belong to mission$/, /^Invalid worker$/, /^Invalid lease timestamp or TTL$/, /^Invalid completion timestamp$/];

function isTaskStoreValidation(error: unknown): boolean {
  return error instanceof Error && TASK_STORE_VALIDATION.some(re => re.test(error.message));
}

function failTaskStore(root: string | null, phase: TaskStorePhase, error: unknown): never {
  if (root !== null && !isTaskStoreLedgered(error) && !isTaskStoreValidation(error)) recordTaskStoreFailure(root, phase, error);
  if (root !== null && !isTaskStoreValidation(error)) tagTaskStoreLedgered(error);
  throw error;
}

export class TaskScheduler {
  private readonly ledgerRoot: string | null;
  constructor(private readonly db:Database.Database, root?: string) {
    this.ledgerRoot = root ? resolve(root) : null;
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','READY','LEASED','SUCCEEDED','FAILED','CANCELLED')),
        lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY(task_id,depends_on),
        CHECK(task_id <> depends_on)
      );
      CREATE INDEX IF NOT EXISTS tasks_mission_status ON tasks(mission_id,status);
    `);
    } catch (error) { failTaskStore(this.ledgerRoot, "write", error); }
  }
  private touch<T>(phase:TaskStorePhase, fn:()=>T):T{
    try { return fn(); }
    catch (error) { failTaskStore(this.ledgerRoot, phase, error); }
  }
  add(missionId:string, objective:string, dependsOn:string[]=[]):Task {
    return this.touch("write",()=>{
    if(!objective.trim()) throw new Error("Task objective required");
    return this.db.transaction(()=>{
      const mission=this.db.prepare("SELECT status FROM missions WHERE id=?").get(missionId) as {status:string}|undefined;
      if(!mission) throw new Error("Mission does not exist");
      if(["COMPLETED","FAILED","CANCELLED"].includes(mission.status)) throw new Error("Mission is terminal");
      for(const dep of dependsOn) {
        const found=this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND mission_id=?").get(dep,missionId);
        if(!found) throw new Error("Dependency must belong to mission");
      }
      const task:Task={id:randomUUID(),mission_id:missionId,objective,status:"PENDING",lease_owner:null,lease_generation:0,lease_expires_at:null,attempts:0,created_at:new Date().toISOString()};
      this.db.prepare("INSERT INTO tasks (id,mission_id,objective,status,lease_owner,lease_generation,lease_expires_at,attempts,created_at) VALUES (@id,@mission_id,@objective,@status,@lease_owner,@lease_generation,@lease_expires_at,@attempts,@created_at)").run(task);
      const insert=this.db.prepare("INSERT INTO task_dependencies (task_id,depends_on) VALUES (?,?)");
      for(const dep of dependsOn) insert.run(task.id,dep);
      return task;
    })();
    });
  }
  list(missionId:string):Task[] {
    return this.touch("read",()=>this.db.prepare("SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at,id").all(missionId) as Task[]);
  }
  claim(missionId:string,worker:string,now=Date.now(),ttlMs=30_000):Task|undefined {
    return this.touch("write",()=>{
    if(!worker.trim())throw new Error("Invalid worker");
    const expiresAt=leaseExpiry(now,ttlMs);
    return this.db.transaction(()=>{
      const mission=this.db.prepare("SELECT status FROM missions WHERE id=?").get(missionId) as {status:string}|undefined;
      if(mission?.status!=="RUNNING")return undefined;
      const eligible=this.db.prepare(`
        SELECT t.* FROM tasks t WHERE t.mission_id=?
          AND (t.status='PENDING' OR (t.status='LEASED' AND t.lease_expires_at <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on
            WHERE d.task_id=t.id AND parent.status!='SUCCEEDED'
          )
        ORDER BY t.created_at,t.id LIMIT 1
      `).get(missionId,now) as Task|undefined;
      if(!eligible)return undefined;
      this.db.prepare(`
        UPDATE tasks SET status='LEASED', lease_owner=?, lease_generation=lease_generation+1,
        lease_expires_at=?, attempts=attempts+1 WHERE id=?
      `).run(worker,expiresAt,eligible.id);
      return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(eligible.id) as Task;
    })();
    });
  }
  heartbeat(id:string,worker:string,generation:number,now=Date.now(),ttlMs=30_000):boolean {
    return this.touch("write",()=>{
    const expiresAt=leaseExpiry(now,ttlMs);
    const result=this.db.prepare(`
      UPDATE tasks SET lease_expires_at=? WHERE id=? AND status='LEASED'
      AND lease_owner=? AND lease_generation=? AND lease_expires_at>? AND lease_expires_at<?
      AND EXISTS (SELECT 1 FROM missions m WHERE m.id=tasks.mission_id AND m.status='RUNNING')
    `).run(expiresAt,id,worker,generation,now,expiresAt);
    return result.changes===1;
    });
  }
  complete(id:string,worker:string,generation:number,success:boolean,now=Date.now()):boolean {
    return this.touch("write",()=>{
    if(!Number.isSafeInteger(now)||now<0)throw new Error("Invalid completion timestamp");
    const result=this.db.prepare(`
      UPDATE tasks SET status=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
      AND status='LEASED' AND lease_owner=? AND lease_generation=? AND lease_expires_at>?
      AND EXISTS (SELECT 1 FROM missions m WHERE m.id=tasks.mission_id AND m.status='RUNNING')
    `).run(success?"SUCCEEDED":"FAILED",id,worker,generation,now);
    return result.changes===1;
    });
  }
}

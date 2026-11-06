import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export type TaskStatus = "PENDING" | "READY" | "LEASED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface Task { id:string; mission_id:string; objective:string; status:TaskStatus; lease_owner:string|null; lease_generation:number; lease_expires_at:number|null; attempts:number; created_at:string }
/** Reject invalid or overflowing timestamps before they can corrupt durable leases. */
function leaseExpiry(now:number,ttlMs:number):number {
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttlMs)||ttlMs<=0||
     !Number.isSafeInteger(now+ttlMs))throw new Error("Invalid lease timestamp or TTL");
  return now+ttlMs;
}
export class TaskScheduler {
  constructor(private readonly db:Database.Database) {
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
  }
  add(missionId:string, objective:string, dependsOn:string[]=[]):Task {
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
  }
  list(missionId:string):Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at,id").all(missionId) as Task[];
  }
  claim(missionId:string,worker:string,now=Date.now(),ttlMs=30_000):Task|undefined {
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
  }
  heartbeat(id:string,worker:string,generation:number,now=Date.now(),ttlMs=30_000):boolean {
    const expiresAt=leaseExpiry(now,ttlMs);
    const result=this.db.prepare(`
      UPDATE tasks SET lease_expires_at=? WHERE id=? AND status='LEASED'
      AND lease_owner=? AND lease_generation=? AND lease_expires_at>?
      AND EXISTS (SELECT 1 FROM missions m WHERE m.id=tasks.mission_id AND m.status='RUNNING')
    `).run(expiresAt,id,worker,generation,now);
    return result.changes===1;
  }
  complete(id:string,worker:string,generation:number,success:boolean,now=Date.now()):boolean {
    if(!Number.isSafeInteger(now)||now<0)throw new Error("Invalid completion timestamp");
    const result=this.db.prepare(`
      UPDATE tasks SET status=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?
      AND status='LEASED' AND lease_owner=? AND lease_generation=? AND lease_expires_at>?
      AND EXISTS (SELECT 1 FROM missions m WHERE m.id=tasks.mission_id AND m.status='RUNNING')
    `).run(success?"SUCCEEDED":"FAILED",id,worker,generation,now);
    return result.changes===1;
  }
}

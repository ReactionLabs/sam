import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OPERATIVE_HEARTBEAT_TTL_MS } from "./operatives.js";

export interface AssignmentLease {
  id:string; operative_id:string; task_id:string; generation:number;
  expires_at:number; completed_at:number|null;
}
/** Durable capacity reservations. A lease is not permission to execute tools. */
export class AssignmentLeases {
  private db:Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=openDatabase(path);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assignment_leases (
        id TEXT PRIMARY KEY, operative_id TEXT NOT NULL REFERENCES operatives(id),
        task_id TEXT NOT NULL, generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS assignment_leases_capacity
        ON assignment_leases(operative_id,expires_at,completed_at);
      CREATE INDEX IF NOT EXISTS assignment_leases_task
        ON assignment_leases(task_id,expires_at,completed_at);
    `);
  }
  /** Atomically reserve a healthy operative and an unclaimed task. */
  claim(operativeId:string,taskId:string,now=Date.now(),ttlMs=30_000):AssignmentLease|undefined {
    if(!taskId.trim()||!Number.isSafeInteger(now)||!Number.isSafeInteger(ttlMs)||ttlMs<1)
      throw new Error("Invalid lease parameters");
    return this.db.transaction(()=>{
      const op=this.db.prepare("SELECT * FROM operatives WHERE id=?").get(operativeId) as
        {state:string;last_seen_at:string|null;max_concurrency:number}|undefined;
      if(!op||op.state!=="available"||!op.last_seen_at||
        Date.parse(op.last_seen_at)<=now-OPERATIVE_HEARTBEAT_TTL_MS)return undefined;
      const capacity=(this.db.prepare(`SELECT COUNT(*) AS n FROM assignment_leases
        WHERE operative_id=? AND completed_at IS NULL AND expires_at>?`).get(operativeId,now) as {n:number}).n;
      if(capacity>=op.max_concurrency)return undefined;
      const existing=this.db.prepare(`SELECT 1 FROM assignment_leases
        WHERE task_id=? AND completed_at IS NULL AND expires_at>?`).get(taskId,now);
      if(existing)return undefined;
      const previous=this.db.prepare(`SELECT COALESCE(MAX(generation),0) AS n
        FROM assignment_leases WHERE task_id=?`).get(taskId) as {n:number};
      const lease:AssignmentLease={id:randomUUID(),operative_id:operativeId,task_id:taskId,
        generation:previous.n+1,expires_at:now+ttlMs,completed_at:null};
      this.db.prepare(`INSERT INTO assignment_leases
        (id,operative_id,task_id,generation,expires_at,completed_at)
        VALUES (@id,@operative_id,@task_id,@generation,@expires_at,@completed_at)`).run(lease);
      return lease;
    })();
  }
  renew(id:string,operativeId:string,generation:number,now=Date.now(),ttlMs=30_000):boolean {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new Error("Invalid lease TTL");
    return this.db.prepare(`UPDATE assignment_leases SET expires_at=?
      WHERE id=? AND operative_id=? AND generation=? AND completed_at IS NULL
      AND expires_at>? AND EXISTS (
        SELECT 1 FROM operatives WHERE operatives.id=assignment_leases.operative_id
        AND state='available' AND last_seen_at IS NOT NULL AND
        last_seen_at>?
      )`).run(now+ttlMs,id,operativeId,generation,now,
        new Date(now-OPERATIVE_HEARTBEAT_TTL_MS).toISOString()).changes===1;
  }
  finish(id:string,operativeId:string,generation:number,now=Date.now()):boolean {
    return this.db.prepare(`UPDATE assignment_leases SET completed_at=?
      WHERE id=? AND operative_id=? AND generation=? AND completed_at IS NULL AND expires_at>?`)
      .run(now,id,operativeId,generation,now).changes===1;
  }
  active(operativeId:string,now=Date.now()):AssignmentLease[] {
    return this.db.prepare(`SELECT * FROM assignment_leases
      WHERE operative_id=? AND completed_at IS NULL AND expires_at>? ORDER BY expires_at`)
      .all(operativeId,now) as AssignmentLease[];
  }
  close():void {this.db.close();}
}

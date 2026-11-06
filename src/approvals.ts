import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

export type RiskClass = "LOCAL_WRITE" | "EXTERNAL_WRITE" | "DESTRUCTIVE" | "PRODUCTION" | "FINANCIAL" | "CREDENTIAL";
export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "CONSUMED";
export interface Approval {
  id:string; mission_id:string; risk:RiskClass; action_digest:string;
  status:ApprovalStatus; requested_at:number; expires_at:number;
  decided_at:number|null; decided_by:string|null; consumed_at:number|null;
}
function canonical(value:unknown):string {
  if(value===null || typeof value!=="object") {
    if(typeof value==="undefined" || typeof value==="function" || typeof value==="symbol" || typeof value==="bigint") throw new Error("Action must be JSON serializable");
    const result=JSON.stringify(value);
    if(result===undefined)throw new Error("Action must be JSON serializable");
    return result;
  }
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  const obj=value as Record<string,unknown>;
  return "{"+Object.keys(obj).sort().map(key=>JSON.stringify(key)+":"+canonical(obj[key])).join(",")+"}";
}
export function actionDigest(action:unknown):string {
  return createHash("sha256").update(canonical(action)).digest("hex");
}
export class ApprovalStore {
  constructor(private readonly db:Database.Database) {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        risk TEXT NOT NULL CHECK(risk IN ('LOCAL_WRITE','EXTERNAL_WRITE','DESTRUCTIVE','PRODUCTION','FINANCIAL','CREDENTIAL')),
        action_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','DENIED','CONSUMED')),
        requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        decided_at INTEGER, decided_by TEXT, consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS approvals_mission ON approvals(mission_id,status);
    `);
  }
  request(missionId:string,risk:RiskClass,action:unknown,now=Date.now(),ttlMs=300_000):Approval {
    if(!["LOCAL_WRITE","EXTERNAL_WRITE","DESTRUCTIVE","PRODUCTION","FINANCIAL","CREDENTIAL"].includes(risk))throw new Error("Unknown risk class");
    if(!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>86_400_000)throw new Error("Invalid approval lifetime");
    const digest=actionDigest(action);
    const row:Approval={id:randomUUID(),mission_id:missionId,risk,action_digest:digest,status:"PENDING",requested_at:now,expires_at:now+ttlMs,decided_at:null,decided_by:null,consumed_at:null};
    this.db.prepare(`INSERT INTO approvals (id,mission_id,risk,action_digest,status,requested_at,expires_at,decided_at,decided_by,consumed_at)
      VALUES (@id,@mission_id,@risk,@action_digest,@status,@requested_at,@expires_at,@decided_at,@decided_by,@consumed_at)`).run(row);
    return row;
  }
  get(id:string):Approval|undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Approval|undefined;
  }
  list(missionId:string):Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE mission_id=? ORDER BY requested_at,id").all(missionId) as Approval[];
  }
  decide(id:string,actor:string,allow:boolean,now=Date.now()):boolean {
    if(!actor.trim())throw new Error("Approver identity required");
    return this.db.prepare(`UPDATE approvals SET status=?,decided_by=?,decided_at=?
      WHERE id=? AND status='PENDING' AND expires_at>?`)
      .run(allow?"APPROVED":"DENIED",actor,now,id,now).changes===1;
  }
  consume(id:string,missionId:string,risk:RiskClass,action:unknown,now=Date.now()):boolean {
    const digest=actionDigest(action);
    // One-shot, digest-bound authorization. Must be called in the same
    // transaction as the local effect it guards; remote effects need
    // separate reconciliation/idempotency before retries.
    return this.db.prepare(`UPDATE approvals SET status='CONSUMED',consumed_at=?
      WHERE id=? AND mission_id=? AND risk=? AND action_digest=?
      AND status='APPROVED' AND expires_at>?
      AND EXISTS (SELECT 1 FROM missions m WHERE m.id=approvals.mission_id AND m.status='RUNNING')`)
      .run(now,id,missionId,risk,digest,now).changes===1;
  }
}

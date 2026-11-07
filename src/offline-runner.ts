import Database from "better-sqlite3";
import {TaskScheduler} from "./tasks.js";
import {type ExecutionAdapter, type ExecutionEvidence, type ExecutionRequest, verifyExecutionEvidence} from "./execution.js";

export interface StoredExecution {
  task_id:string; mission_id:string; worker_id:string; lease_generation:number;
  adapter_id:string; request_id:string; outcome:string; output:string;
  output_sha256:string; completed_at:string;
}
/** Offline execution boundary. Completion and evidence persistence share one SQLite transaction. */
export class OfflineMissionRunner {
  private readonly tasks:TaskScheduler;
  constructor(private readonly db:Database.Database, private readonly clock:()=>number=Date.now) {
    this.tasks=new TaskScheduler(db);
    db.exec(`CREATE TABLE IF NOT EXISTS task_execution_results (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      mission_id TEXT NOT NULL REFERENCES missions(id),
      worker_id TEXT NOT NULL, lease_generation INTEGER NOT NULL,
      adapter_id TEXT NOT NULL, request_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','FAILED')),
      output TEXT NOT NULL, output_sha256 TEXT NOT NULL, completed_at TEXT NOT NULL
    )`);
  }
  result(taskId:string):StoredExecution|undefined {
    return this.db.prepare("SELECT * FROM task_execution_results WHERE task_id=?").get(taskId) as StoredExecution|undefined;
  }
  /** Only one task is claimed. Never retry a failed adapter automatically. */
  async runOne(missionId:string,workerId:string,adapter:ExecutionAdapter,now=this.clock(),ttlMs=30_000):Promise<StoredExecution|undefined> {
    if(adapter.id!=="local-echo-test") throw new Error("Only the explicit offline test adapter is permitted");
    const lease=this.tasks.claim(missionId,workerId,now,ttlMs);
    if(!lease)return undefined;
    const request:ExecutionRequest={missionId,taskId:lease.id,workerId,leaseGeneration:lease.lease_generation,objective:lease.objective};
    let evidence:ExecutionEvidence;
    try { evidence=await adapter.execute(request); }
    catch { throw new Error("Offline adapter failed; lease will expire for explicit recovery"); }
    if(!verifyExecutionEvidence(evidence,request))throw new Error("Invalid execution evidence; task remains leased");
    const completedAt=Date.parse(evidence.completedAt);
    const finishedAt=this.clock();
    if(!Number.isSafeInteger(finishedAt)||finishedAt<now)throw new Error("Invalid runner completion clock");
    if(!Number.isFinite(completedAt)||completedAt<now||completedAt>finishedAt)
      throw new Error("Evidence completion time outside execution window");
    return this.db.transaction(()=>{
      if(!this.tasks.complete(lease.id,workerId,lease.lease_generation,evidence.outcome==="SUCCEEDED",finishedAt))
        throw new Error("Lease expired, superseded or mission no longer running; evidence not persisted");
      this.db.prepare(`INSERT INTO task_execution_results
        (task_id,mission_id,worker_id,lease_generation,adapter_id,request_id,outcome,output,output_sha256,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lease.id,missionId,workerId,lease.lease_generation,adapter.id,
        evidence.requestId,evidence.outcome,evidence.output,evidence.outputSha256,evidence.completedAt);
      return this.result(lease.id)!;
    })();
  }
}

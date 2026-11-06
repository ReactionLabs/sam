import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canTransition, missionStatuses, type MissionStatus } from "./kernel.js";

export interface Mission { id:string; code:string; objective:string; status:MissionStatus; created_at:string; updated_at:string }
export interface MissionEvent { id:number; mission_id:string; sequence:number; type:string; payload:string; created_at:string }
export class MissionStore {
  private db: Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, objective TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mission_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),
        sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(mission_id,sequence)
      );
    `);
  }
  create(objective:string):Mission {
    if(!objective.trim()) throw new Error("Mission objective cannot be empty");
    const tx=this.db.transaction(()=>{
      const now=new Date().toISOString(), id=randomUUID();
      const next=(this.db.prepare("SELECT COUNT(*) AS n FROM missions").get() as {n:number}).n+1;
      // Unique code generation retries after deletion or concurrent processes.
      let number=next;
      while(this.db.prepare("SELECT 1 FROM missions WHERE code=?").get("OP-"+String(number).padStart(4,"0"))) number++;
      const mission={id,code:"OP-"+String(number).padStart(4,"0"),objective,status:"DRAFT" as MissionStatus,created_at:now,updated_at:now};
      this.db.prepare("INSERT INTO missions VALUES (@id,@code,@objective,@status,@created_at,@updated_at)").run(mission);
      this.appendEvent(id,"mission.created",{objective});
      return mission;
    });
    return tx();
  }
  list():Mission[] { return this.db.prepare("SELECT * FROM missions ORDER BY created_at DESC, rowid DESC").all() as Mission[]; }
  get(code:string):Mission|undefined { return this.db.prepare("SELECT * FROM missions WHERE code=? OR id=?").get(code,code) as Mission|undefined; }
  events(id:string):MissionEvent[] { return this.db.prepare("SELECT * FROM mission_events WHERE mission_id=? ORDER BY sequence").all(id) as MissionEvent[]; }
  transition(code:string,to:MissionStatus):Mission {
    if(!missionStatuses.includes(to)) throw new Error("Unknown status: "+to);
    return this.db.transaction(()=>{
      const mission=this.get(code);
      if(!mission) throw new Error("Mission not found: "+code);
      if(!canTransition(mission.status,to)) throw new Error("Invalid transition: "+mission.status+" -> "+to);
      const now=new Date().toISOString();
      this.db.prepare("UPDATE missions SET status=?,updated_at=? WHERE id=? AND status=?").run(to,now,mission.id,mission.status);
      this.appendEvent(mission.id,"mission.transitioned",{from:mission.status,to});
      return this.get(code)!;
    })();
  }
  private appendEvent(missionId:string,type:string,payload:unknown):void {
    const row=this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM mission_events WHERE mission_id=?").get(missionId) as {n:number};
    this.db.prepare("INSERT INTO mission_events (mission_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?)")
      .run(missionId,row.n,type,JSON.stringify(payload),new Date().toISOString());
  }
  close():void {this.db.close();}
}

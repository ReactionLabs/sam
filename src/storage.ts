import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canTransition, missionStatusBlocker, type MissionStatus } from "./kernel.js";

export interface Mission { id:string; code:string; objective:string; status:MissionStatus; created_at:string; updated_at:string }
/** The fold a mission code is compared under: case and
 *  separators dropped, the OP prefix dropped, and the
 *  numeric part's leading zeros stripped - the registry's
 *  own alphabet, since canonical codes are zero-padded
 *  (OP-0001), so "op-1", "OP1", "op_0001", and a bare "1"
 *  all fold to the same key as OP-0001. A value that is
 *  not an OP code or a bare number folds to its stripped
 *  form, which no code's key can equal. */
export function normalizeMissionCode(value:string):string{
  const folded=(value??"").toLowerCase().replace(/[^a-z0-9]+/g,"");
  const digits=folded.startsWith("op")?folded.slice(2):(/^\d+$/.test(folded)?folded:"");
  return digits?String(Number(digits)):folded;
}
/** The ONE source carrying the mission code refusal
 *  (refusal-class sweep, 2026-11-27): every door that picks
 *  a mission by code - MissionStore.transition inside the
 *  store, and the CLI's missionOrThrow / `mission inspect`
 *  / `task add` / `task list` doors - improvised the same
 *  bare "Mission not found: X", naming NONE of the codes
 *  that exist and offering NO fold correction, so a folded
 *  code ("op-1", "OP1", a bare "1") dead-ended at the door
 *  that picks which mission a task, a memory, or a
 *  transition lands on. missionCodeBlocker carries the
 *  refusal (value echoed, the existing codes named as the
 *  registry, keeping the "Mission not found" prefix, fold
 *  correction when exactly one code matches folded); the
 *  doors throw it before anything is touched. The registry
 *  is dynamic per install, so the exactly-one-match rule
 *  is what keeps a correction unambiguous (codes are
 *  numerically unique, so folded keys never collide).
 *  MissionStore.get stays permissive by design - it
 *  resolves a code OR an id for internal callers, and an
 *  exact code or id reads no blocker here. Null means the
 *  value names a mission. */
export function missionCodeBlocker(missions:readonly Pick<Mission,"code"|"id">[],value:unknown):string|null{
  if(typeof value==="string"&&(missions.some(m=>m.code===value)||missions.some(m=>m.id===value)))return null;
  const target=typeof value==="string"?normalizeMissionCode(value):"";
  const matches=target?missions.filter(m=>normalizeMissionCode(m.code)===target):[];
  const fix=matches.length===1?matches[0]!.code:null;
  const known=missions.map(m=>m.code).sort((a,b)=>a.localeCompare(b));
  return "Mission not found: \""+String(value)+"\". Missions: "+(known.length?known.join(", "):"none created")+(fix?". Did you mean \""+fix+"\"?":"");
}
export interface MissionEvent { id:number; mission_id:string; sequence:number; type:string; payload:string; created_at:string }
export class MissionStore {
  private db: Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=openDatabase(path);
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
    const statusBlocker=missionStatusBlocker(to); if(statusBlocker) throw new Error(statusBlocker);
    return this.db.transaction(()=>{
      const mission=this.get(code);
      if(!mission) throw new Error(missionCodeBlocker(this.list(),code)!);
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

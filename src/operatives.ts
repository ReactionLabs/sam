import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Operatives are capability declarations, never credentials or executable commands. */
export type OperativeState = "available" | "paused" | "offline";
export interface Operative {
  id:string; name:string; adapter:string; capabilities:string[];
  state:OperativeState; max_concurrency:number; active_assignments:number;
  last_seen_at:string|null; created_at:string;
}
interface Row {
  id:string; name:string; adapter:string; capabilities_json:string;
  state:OperativeState; max_concurrency:number; active_assignments:number;
  last_seen_at:string|null; created_at:string;
}
function decode(row:Row):Operative {
  return {id:row.id,name:row.name,adapter:row.adapter,
    capabilities:JSON.parse(row.capabilities_json) as string[],state:row.state,
    max_concurrency:row.max_concurrency,active_assignments:row.active_assignments,
    last_seen_at:row.last_seen_at,created_at:row.created_at};
}
const identifier=/^[a-z][a-z0-9._-]{0,63}$/;
export class OperativeRegistry {
  private db:Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operatives (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, adapter TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('available','paused','offline')),
        max_concurrency INTEGER NOT NULL CHECK(max_concurrency BETWEEN 1 AND 100),
        active_assignments INTEGER NOT NULL DEFAULT 0 CHECK(active_assignments >= 0),
        last_seen_at TEXT, created_at TEXT NOT NULL
      );
    `);
  }
  register(input:{name:string;adapter:string;capabilities:string[];maxConcurrency?:number}):Operative {
    const {name,adapter}=input;
    const capabilities=[...new Set(input.capabilities)].sort();
    const max=input.maxConcurrency??1;
    if(!identifier.test(name)||!identifier.test(adapter)||capabilities.length===0||
      capabilities.some(c=>!identifier.test(c))||!Number.isInteger(max)||max<1||max>100)
      throw new Error("Invalid operative declaration");
    const record:Row={id:randomUUID(),name,adapter,capabilities_json:JSON.stringify(capabilities),
      state:"offline",max_concurrency:max,active_assignments:0,last_seen_at:null,
      created_at:new Date().toISOString()};
    this.db.prepare(`INSERT INTO operatives
      (id,name,adapter,capabilities_json,state,max_concurrency,active_assignments,last_seen_at,created_at)
      VALUES (@id,@name,@adapter,@capabilities_json,@state,@max_concurrency,@active_assignments,@last_seen_at,@created_at)`).run(record);
    return decode(record);
  }
  list():Operative[] {
    return (this.db.prepare("SELECT * FROM operatives ORDER BY name").all() as Row[]).map(decode);
  }
  setState(id:string,state:OperativeState):boolean {
    if(!["available","paused","offline"].includes(state))throw new Error("Invalid operative state");
    return this.db.prepare("UPDATE operatives SET state=?,last_seen_at=? WHERE id=?")
      .run(state,state==="available"?new Date().toISOString():null,id).changes===1;
  }
  /** Deterministic candidate selection; does not grant tool or execution authority. */
  candidates(required:string[]):Operative[] {
    if(required.length===0||required.some(c=>!identifier.test(c)))throw new Error("Invalid capabilities");
    return this.list().filter(o=>o.state==="available"&&
      o.active_assignments<o.max_concurrency&&required.every(c=>o.capabilities.includes(c)))
      .sort((a,b)=>(a.active_assignments/a.max_concurrency)-(b.active_assignments/b.max_concurrency)
        ||a.name.localeCompare(b.name));
  }
  /** Reserve capacity atomically; caller must separately enforce policy before execution. */
  reserve(id:string):boolean {
    return this.db.prepare(`UPDATE operatives SET active_assignments=active_assignments+1
      WHERE id=? AND state='available' AND active_assignments<max_concurrency`).run(id).changes===1;
  }
  release(id:string):boolean {
    return this.db.prepare(`UPDATE operatives SET active_assignments=active_assignments-1
      WHERE id=? AND active_assignments>0`).run(id).changes===1;
  }
  close():void {this.db.close();}
}

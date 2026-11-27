import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Operatives are capability declarations, never credentials or executable commands. */
export const operativeStates = ["available", "paused", "offline"] as const;
export type OperativeState = typeof operativeStates[number];
export function foldOperativeStateName(value: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/** The ONE source for why an operative door cannot name
 *  this state: the state is a registry name
 *  (operativeStates) a person types at the CLI
 *  `operative state` door, and the ONE seam every state
 *  change rides, OperativeRegistry.setState, refused it
 *  with the bare "Invalid operative state" - echoing no
 *  value, naming none of the three states, and offering
 *  no fold correction, so a folded name ("Available",
 *  "off-line", "off_line") dead-ended. An exact state
 *  reads no blocker. Anything else is refused with the
 *  value echoed, the states named as the registry, and,
 *  when exactly one state matches the bad value folded
 *  for case and separators, that correction. The
 *  "Invalid operative state" prefix is kept: its
 *  readers match it. Both doors throw this text before
 *  any operative is touched. Stored-state readers stay
 *  permissive by design - a stored operative's state is
 *  read back as stored, and the SQL CHECK constraint
 *  mirrors the registry and is untouched. Null means
 *  the state can be named. */
export function operativeStateBlocker(value: unknown): string | null {
  if (typeof value === "string" && (operativeStates as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldOperativeStateName(value) : "";
  const matches = target ? operativeStates.filter(s => foldOperativeStateName(s) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Invalid operative state \"" + String(value) + "\". States: " + operativeStates.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
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
/** Operatives must renew liveness; a stale declaration cannot receive new work. */
export const OPERATIVE_HEARTBEAT_TTL_MS=60_000;
export class OperativeRegistry {
  private db:Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=openDatabase(path);
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
    const stateBlocker=operativeStateBlocker(state);if(stateBlocker)throw new Error(stateBlocker);
    return this.db.prepare("UPDATE operatives SET state=?,last_seen_at=? WHERE id=?")
      .run(state,state==="available"?new Date().toISOString():null,id).changes===1;
  }
  /** Only an explicitly available operative can renew its liveness. */
  heartbeat(id:string):boolean {
    return this.db.prepare("UPDATE operatives SET last_seen_at=? WHERE id=? AND state='available'")
      .run(new Date().toISOString(),id).changes===1;
  }
  /** Deterministic candidate selection; does not grant tool or execution authority. */
  candidates(required:string[]):Operative[] {
    if(required.length===0||required.some(c=>!identifier.test(c)))throw new Error("Invalid capabilities");
    const cutoff=new Date(Date.now()-OPERATIVE_HEARTBEAT_TTL_MS).toISOString();
    return this.list().filter(o=>o.state==="available"&&o.last_seen_at!==null&&o.last_seen_at>cutoff&&
      o.active_assignments<o.max_concurrency&&required.every(c=>o.capabilities.includes(c)))
      .sort((a,b)=>(a.active_assignments/a.max_concurrency)-(b.active_assignments/b.max_concurrency)
        ||a.name.localeCompare(b.name));
  }
  /** Reserve capacity atomically; caller must separately enforce policy before execution. */
  reserve(id:string):boolean {
    const cutoff=new Date(Date.now()-OPERATIVE_HEARTBEAT_TTL_MS).toISOString();
    return this.db.prepare(`UPDATE operatives SET active_assignments=active_assignments+1
      WHERE id=? AND state='available' AND last_seen_at IS NOT NULL AND last_seen_at>?
      AND active_assignments<max_concurrency`).run(id,cutoff).changes===1;
  }
  release(id:string):boolean {
    return this.db.prepare(`UPDATE operatives SET active_assignments=active_assignments-1
      WHERE id=? AND active_assignments>0`).run(id).changes===1;
  }
  close():void {this.db.close();}
}
